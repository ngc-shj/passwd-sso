# Batch A: V-1 フォルダ (#70) + V-2 変更履歴 (#71)

## Context

P0 完了後の Phase 2 (P1 前半)。エントリ数が増えた際の整理手段 (フォルダ) とデータロス防止 (変更履歴) を同時に実装する。両機能とも PasswordEntry 周辺の変更でありスキーマレビューを 1 回にまとめられる。

---

## Step 1: Prisma Schema + Migration

**File:** `prisma/schema.prisma`

### 新規モデル (4 つ)

**Folder** (個人):
```prisma
model Folder {
  id        String   @id @default(cuid())
  name      String   @db.VarChar(100)
  parentId  String?  @map("parent_id")
  userId    String   @map("user_id")
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user     User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  parent   Folder?         @relation("FolderHierarchy", fields: [parentId], references: [id], onDelete: SetNull)
  children Folder[]        @relation("FolderHierarchy")
  entries  PasswordEntry[]

  @@unique([name, parentId, userId])
  @@index([userId])
  @@map("folders")
}
```

**OrgFolder**:
```prisma
model OrgFolder {
  id        String   @id @default(cuid())
  name      String   @db.VarChar(100)
  parentId  String?  @map("parent_id")
  orgId     String   @map("org_id")
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  org      Organization       @relation(fields: [orgId], references: [id], onDelete: Cascade)
  parent   OrgFolder?         @relation("OrgFolderHierarchy", fields: [parentId], references: [id], onDelete: SetNull)
  children OrgFolder[]        @relation("OrgFolderHierarchy")
  entries  OrgPasswordEntry[]

  @@unique([name, parentId, orgId])
  @@index([orgId])
  @@map("org_folders")
}
```

**PasswordEntryHistory**:
```prisma
model PasswordEntryHistory {
  id            String   @id @default(cuid())
  entryId       String   @map("entry_id")
  encryptedBlob String   @map("encrypted_blob") @db.Text
  blobIv        String   @map("blob_iv") @db.VarChar(24)
  blobAuthTag   String   @map("blob_auth_tag") @db.VarChar(32)
  keyVersion    Int      @map("key_version")
  aadVersion    Int      @default(0) @map("aad_version")
  changedAt     DateTime @default(now()) @map("changed_at")

  entry PasswordEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)

  @@index([entryId, changedAt])
  @@map("password_entry_histories")
}
```

**OrgPasswordEntryHistory**:
```prisma
model OrgPasswordEntryHistory {
  id            String   @id @default(cuid())
  entryId       String   @map("entry_id")
  encryptedBlob String   @map("encrypted_blob") @db.Text
  blobIv        String   @map("blob_iv") @db.VarChar(24)
  blobAuthTag   String   @map("blob_auth_tag") @db.VarChar(32)
  aadVersion    Int      @default(0) @map("aad_version")
  changedById   String   @map("changed_by_id")
  changedAt     DateTime @default(now()) @map("changed_at")

  entry     OrgPasswordEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  changedBy User             @relation(fields: [changedById], references: [id])

  @@index([entryId, changedAt])
  @@map("org_password_entry_histories")
}
```

### 既存モデル変更

- `PasswordEntry` に `folderId String? @map("folder_id")` + `folder Folder?` + `histories PasswordEntryHistory[]`
- `OrgPasswordEntry` に `orgFolderId String? @map("org_folder_id")` + `orgFolder OrgFolder?` + `histories OrgPasswordEntryHistory[]`
- `User` に `folders Folder[]`, `orgPasswordHistories OrgPasswordEntryHistory[]`
- `Organization` に `folders OrgFolder[]`
- `AuditAction` enum に `FOLDER_CREATE`, `FOLDER_UPDATE`, `FOLDER_DELETE`, `ENTRY_HISTORY_RESTORE`

### NULL 一意制約の対処

PostgreSQL で `@@unique([name, parentId, userId])` は `parentId=NULL` の行を重複と見なさない。マイグレーション SQL に条件付きインデックスを追加:

```sql
-- Prisma の @@unique は NULL を区別しないため、ルートフォルダ同名防止に部分インデックスが必要
-- cf. PostgreSQL: NULL != NULL in unique constraints
CREATE UNIQUE INDEX "folders_name_user_id_root" ON "folders" ("name", "user_id") WHERE "parent_id" IS NULL;
CREATE UNIQUE INDEX "org_folders_name_org_id_root" ON "org_folders" ("name", "org_id") WHERE "parent_id" IS NULL;
```

**マイグレーション名:** `add_folders_and_entry_history`

**drift 防止**: テストで部分インデックスの存在を検証する (Step 9 参照)

---

## Step 2: Constants + Validation

### 2a. 定数

| ファイル | 追加 |
|---------|------|
| `src/lib/constants/audit.ts` | `FOLDER_CREATE`, `FOLDER_UPDATE`, `FOLDER_DELETE`, `ENTRY_HISTORY_RESTORE`, `HISTORY_PURGE` を `AUDIT_ACTION` + VALUES + GROUPS に追加。`AUDIT_METADATA_KEY` に `HISTORY_ID`, `RESTORED_FROM_CHANGED_AT`, `PURGED_COUNT` を定数定義 |
| `src/lib/constants/audit-target.ts` | `FOLDER: "Folder"`, `ORG_FOLDER: "OrgFolder"` |
| `src/lib/constants/api-path.ts` | `FOLDERS: "/api/folders"` + 動的パス (`folderById`, `orgFolders`, `passwordHistory`, `passwordHistoryRestore` 等) |
| `src/lib/api-error-codes.ts` | `FOLDER_ALREADY_EXISTS`, `FOLDER_MAX_DEPTH_EXCEEDED`, `FOLDER_CIRCULAR_REFERENCE`, `HISTORY_NOT_FOUND` |

### 2b. Validation schemas

**File:** `src/lib/validations.ts`

```typescript
export const createFolderSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});
```

既存スキーマ変更:
- `createE2EPasswordSchema` に `folderId: z.string().cuid().optional().nullable()`
- `updateE2EPasswordSchema` に `folderId: z.string().cuid().optional().nullable()`

---

## Step 3: フォルダ API (Personal)

タグ API (`src/app/api/tags/route.ts`) のパターンに準拠。

### `src/app/api/folders/route.ts` (GET, POST)

- **GET**: `prisma.folder.findMany({ where: { userId }, include: { _count: { select: { entries: { where: { deletedAt: null } } } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })`。フラット配列を返し、クライアント側で parentId を元にツリー構築。
- **POST**: Zod バリデーション → 深度チェック (max 5) → 重複チェック → 作成 → 監査ログ

### `src/app/api/folders/[id]/route.ts` (PUT, DELETE)

- **PUT**: 所有権確認 → parentId 変更時は循環参照 + 深度チェック → 更新
- **DELETE**: 子フォルダの `parentId` を削除フォルダの `parentId` に昇格 → エントリの `folderId` を null → フォルダ削除 → 監査ログ

### 深度/循環参照ヘルパー (Personal + Org 共用)

`src/lib/folder-utils.ts`:

ジェネリックな実装で Personal (`Folder`) と Org (`OrgFolder`) の両方に対応。Prisma の delegate パターンではなく、コールバックで親ノード取得関数を注入する:

```typescript
interface ParentNode { parentId: string | null; ownerId: string }

// 深度チェック — parentId から根まで遡り最大深度を検証
async function validateFolderDepth(
  parentId: string | null,
  ownerId: string,
  getParent: (id: string) => Promise<ParentNode | null>,
  maxDepth = 5,
): Promise<number>

// 循環参照チェック — newParentId から遡り folderId が現れないことを確認
async function checkCircularReference(
  folderId: string,
  newParentId: string,
  getParent: (id: string) => Promise<ParentNode | null>,
): Promise<boolean>
```

呼び出し側:
- Personal: `getParent = (id) => prisma.folder.findUnique({ where: { id }, select: { parentId: true, userId: true } }).then(f => f ? { parentId: f.parentId, ownerId: f.userId } : null)`
- Org: `getParent = (id) => prisma.orgFolder.findUnique({ where: { id }, select: { parentId: true, orgId: true } }).then(f => f ? { parentId: f.parentId, ownerId: f.orgId } : null)`

---

## Step 4: フォルダ API (Org)

- `src/app/api/orgs/[orgId]/folders/route.ts` (GET, POST)
- `src/app/api/orgs/[orgId]/folders/[id]/route.ts` (PUT, DELETE)

Org タグ API (`src/app/api/orgs/[orgId]/tags/route.ts`) パターンに準拠。`requireOrgPermission` でアクセス制御。

---

## Step 5: 変更履歴 — PUT 修正 + History API

### 5a. PUT /api/passwords/[id] 修正

**File:** `src/app/api/passwords/[id]/route.ts`

`encryptedBlob` が更新される場合、更新前に現在の blob をスナップショット保存:

```typescript
if (encryptedBlob) {
  await prisma.$transaction(async (tx) => {
    await tx.passwordEntryHistory.create({
      data: {
        entryId: id,
        encryptedBlob: existing.encryptedBlob,
        blobIv: existing.blobIv,
        blobAuthTag: existing.blobAuthTag,
        keyVersion: existing.keyVersion,
        aadVersion: existing.aadVersion,
      },
    });
    // Max 20 件を超えたら古い順に削除 (安定ソート: changedAt asc, id asc)
    const all = await tx.passwordEntryHistory.findMany({
      where: { entryId: id }, orderBy: [{ changedAt: "asc" }, { id: "asc" }], select: { id: true },
    });
    if (all.length > 20) {
      await tx.passwordEntryHistory.deleteMany({
        where: { id: { in: all.slice(0, all.length - 20).map(r => r.id) } },
      });
    }
  });
}
```

`folderId` も処理:
```typescript
if (folderId !== undefined) updateData.folderId = folderId;
```

### 5b. Org PUT も同様

**File:** `src/app/api/orgs/[orgId]/passwords/[id]/route.ts` — `OrgPasswordEntryHistory` に `changedById` 付きで保存

### 5c. GET /api/passwords/[id]/history

**New:** `src/app/api/passwords/[id]/history/route.ts`

所有権確認 → `findMany({ where: { entryId }, orderBy: { changedAt: "desc" } })` → 暗号化ブロブをそのまま返却

### 5d. POST /api/passwords/[id]/history/[historyId]/restore

**New:** `src/app/api/passwords/[id]/history/[historyId]/restore/route.ts`

1. 所有権確認
2. 履歴エントリ取得 + entryId 一致確認
3. 現在の blob をスナップショット保存 (5a と同じロジック)
4. 履歴の blob で entry を更新
5. `ENTRY_HISTORY_RESTORE` 監査ログ — metadata に `{ historyId, restoredFromChangedAt }` を含める

### 5e. 保持期間クリーンアップ (独立 API)

**指摘対応**: 読み取り API (`GET /api/passwords`) への副作用同居を避け、専用エンドポイントに分離。

**New:** `src/app/api/maintenance/purge-history/route.ts`

```typescript
// POST /api/maintenance/purge-history
// 認証必須。ユーザー自身の履歴のみ対象。
// 90日超過分を一括削除。
const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
const deleted = await prisma.passwordEntryHistory.deleteMany({
  where: { entry: { userId }, changedAt: { lt: ninetyDaysAgo } },
});
return NextResponse.json({ purged: deleted.count });
```

運用方法:
- 手動: 設定画面から「古い履歴を削除」ボタン (ユーザー自身のデータのみ)
- 自動: 将来的に cron/Cloud Scheduler で定期実行 (本バッチでは手動のみ)
- レート制限: 既存 Redis rate limiter を適用 (1 リクエスト/分)
- 監査ログ: `HISTORY_PURGE` アクション + `{ purgedCount }` を記録 (`purgedCount=0` でもログ出力)

認可境界の分離方針:
- 本バッチ: `user-self purge` のみ (`POST /api/maintenance/purge-history`, session 認証, 自分の履歴のみ)
- 将来の system purge (cron/管理者) は別エンドポイント (`POST /api/admin/purge-history`) + 管理者認証で実装。同一エンドポイントに混在させない

---

## Step 6: i18n

**Files:** `messages/en.json`, `messages/ja.json`

### Dashboard セクション
- `folders` / `noFolders` / `createFolder` / `editFolder` / `deleteFolder` / `folderName` / `parentFolder` / `noParent` / `folderDeleteConfirm` / `folderMaxDepth`

### PasswordDetail セクション
- `entryHistory` / `entryHistoryEmpty` / `restoreVersion` / `restoreConfirm` / `versionFrom` / `viewVersion`

### ApiErrors
- `folderAlreadyExists` / `folderMaxDepthExceeded` / `folderCircularReference` / `historyNotFound`

---

## Step 7: フォルダ UI

### 7a. FolderTree — `src/components/folders/folder-tree.tsx`

再帰的ツリー。`Collapsible` で展開/折りたたみ。各ノードは `Link` → `/dashboard/folders/[folderId]`。エントリ数バッジ表示。

### 7b. FolderDialog — `src/components/folders/folder-dialog.tsx`

作成/編集ダイアログ。name 入力 + 親フォルダ select。

### 7c. Sidebar 統合

**File:** `src/components/layout/sidebar.tsx`

"Organize" セクション内にフォルダツリーをタグ一覧の上に配置。`API_PATH.FOLDERS` からフォルダをフェッチ。`activeFolderId` をパスから検出し auto-expand。

### 7d. フォルダページ

**New:** `src/app/[locale]/dashboard/folders/[folderId]/page.tsx`

`src/app/[locale]/dashboard/tags/[tagId]/page.tsx` と同一パターン。`PasswordDashboard` に `folderId` を渡す。

### 7e. PasswordDashboard / PasswordList 修正

- `PasswordDashboardProps` に `folderId?: string | null`
- `PasswordListProps` に `folderId?: string | null`
- Fetch: `if (folderId) params.set("folder", folderId)`

### 7f. GET /api/passwords 修正

`src/app/api/passwords/route.ts` の where 句に `folderId` フィルタ追加。

### 7g. PasswordForm 修正

`src/components/passwords/password-form.tsx` にフォルダ選択ドロップダウン追加 (タグセクションの後)。

### 7h. POST /api/passwords 修正

`src/app/api/passwords/route.ts` の create data に `folderId` を含める。

---

## Step 8: 変更履歴 UI

### 8a. EntryHistorySection — `src/components/passwords/entry-history-section.tsx`

`apiPath.passwordHistory(entryId)` からフェッチ。Collapsible セクション。各リビジョン: タイムスタンプ + "View" + "Restore" ボタン。

### 8b. EntryHistoryViewDialog — `src/components/passwords/entry-history-view-dialog.tsx`

暗号化 blob をクライアント側で復号し読み取り専用表示。"Restore" ボタン付き。

### 8c. PasswordDetailInline 統合

**File:** `src/components/passwords/password-detail-inline.tsx`

既存 passwordHistory セクション (blob 内の古いパスワード) の下に `<EntryHistorySection>` を追加。

---

## Step 9: テスト

| 新規ファイル | 内容 |
|-------------|------|
| `src/app/api/folders/route.test.ts` | GET/POST: 認証, 作成, 重複, バリデーション |
| `src/app/api/folders/[id]/route.test.ts` | PUT/DELETE: 所有権, 深度, 循環参照, 子昇格 |
| `src/app/api/passwords/[id]/history/route.test.ts` | GET: 認証, 所有権, 降順返却 |
| `src/app/api/passwords/[id]/history/[historyId]/restore/route.test.ts` | POST: 復元, スナップショット作成 |

既存修正:

- `src/app/api/passwords/[id]/route.test.ts` — PUT で blob 変更時に history レコード作成を確認

追加テストケース (レビュー指摘対応):

- root folder 重複テスト — `parentId=null` で同名フォルダ作成 → 409 エラー (部分インデックスの検証)
- restore 連打テスト — 同一 historyId で連続 POST → transaction 境界で整合性保持を確認
- purge API 単体テスト — `POST /api/maintenance/purge-history` で 90 日超過分のみ削除、それ以内は残存
- 部分インデックス存在確認テスト — migration 後に `pg_indexes` から `folders_name_user_id_root` の存在を検証

---

## 変更ファイルサマリ

| カテゴリ | ファイル |
|---------|---------|
| **Schema** | `prisma/schema.prisma` |
| **Constants** | `src/lib/constants/audit.ts`, `audit-target.ts`, `api-path.ts`, `src/lib/api-error-codes.ts` |
| **Validation** | `src/lib/validations.ts` |
| **Folder API** | `src/app/api/folders/route.ts` (new), `src/app/api/folders/[id]/route.ts` (new), `src/app/api/orgs/[orgId]/folders/route.ts` (new), `src/app/api/orgs/[orgId]/folders/[id]/route.ts` (new) |
| **History API** | `src/app/api/passwords/[id]/history/route.ts` (new), `.../[historyId]/restore/route.ts` (new), Org 同等 (new) |
| **Maintenance API** | `src/app/api/maintenance/purge-history/route.ts` (new) |
| **Existing API** | `src/app/api/passwords/route.ts`, `src/app/api/passwords/[id]/route.ts`, `src/app/api/orgs/[orgId]/passwords/[id]/route.ts` |
| **Utility** | `src/lib/folder-utils.ts` (new) |
| **UI — Folder** | `src/components/folders/folder-tree.tsx` (new), `folder-dialog.tsx` (new) |
| **UI — History** | `src/components/passwords/entry-history-section.tsx` (new), `entry-history-view-dialog.tsx` (new) |
| **UI — Existing** | `src/components/layout/sidebar.tsx`, `password-dashboard.tsx`, `password-list.tsx`, `password-form.tsx`, `password-detail-inline.tsx` |
| **Pages** | `src/app/[locale]/dashboard/folders/[folderId]/page.tsx` (new) |
| **i18n** | `messages/en.json`, `messages/ja.json` |
| **Tests** | 4 新規 + 1 既存修正 |

---

## 検証

1. `npm run db:migrate` — マイグレーション成功
2. `npm run lint` — エラーなし
3. `npm test` — 全テスト pass
4. `npm run build` — ビルド成功
5. 手動確認:
   - フォルダ作成 → サイドバーに表示
   - フォルダにエントリ割当 → フォルダフィルタで絞り込み
   - ネスト (最大 5 階層) → 6 階層目でエラー
   - フォルダ削除 → 子が親に昇格、エントリは未所属
   - エントリ編集 (blob 変更) → 履歴レコード作成
   - 履歴一覧表示 → 復号して内容確認
   - 履歴から復元 → 現在版がスナップショット保存 + 旧版で上書き
