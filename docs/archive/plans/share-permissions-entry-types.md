# 共有権限のエントリータイプ別フィールド定義

## Context

`applySharePermissions()` のフィールドフィルタリングが LOGIN エントリ専用の定義になっている。

- **OVERVIEW_ONLY**: `title`, `username`, `url` のみ保持 → クレジットカード・銀行口座等では `username`/`url` が存在しないため、title だけになり実質的に空表示
- **HIDE_PASSWORD**: `password`, `cvv` のみ削除 → 銀行口座の `accountNumber`/`iban`、ソフトウェアライセンスの `licenseKey`、ID の `idNumber` 等の機密フィールドが漏洩

エントリータイプごとに「概要フィールド」「機密フィールド」を定義し、全7タイプで意味のある共有が可能にする。

---

## エントリータイプ別フィールド定義

### HIDE_PASSWORD — 除外する機密フィールド

| Entry Type | 除外フィールド |
|------------|--------------|
| LOGIN | `password` |
| SECURE_NOTE | `content` |
| CREDIT_CARD | `cardNumber`, `cvv` |
| IDENTITY | `idNumber` |
| PASSKEY | `credentialId` |
| BANK_ACCOUNT | `accountNumber`, `routingNumber`, `iban` |
| SOFTWARE_LICENSE | `licenseKey` |

### OVERVIEW_ONLY — 保持する概要フィールド

| Entry Type | 保持フィールド |
|------------|--------------|
| LOGIN | `title`, `username`, `url` |
| SECURE_NOTE | `title` |
| CREDIT_CARD | `title`, `cardholderName`, `brand`, `expiryMonth`, `expiryYear` |
| IDENTITY | `title`, `fullName`, `email` |
| PASSKEY | `title`, `username`, `relyingPartyName` |
| BANK_ACCOUNT | `title`, `bankName`, `accountType`, `accountHolderName` |
| SOFTWARE_LICENSE | `title`, `softwareName`, `version`, `licensee` |

---

## 実装計画

### Step 1: `applySharePermissions` にエントリータイプ対応を追加

**`src/lib/constants/share-permission.ts`**:

- シグネチャ変更: `applySharePermissions(data, permissions)` → `applySharePermissions(data, permissions, entryType?)`
- `entryType` が未指定の場合は現行動作 (後方互換)
- `HIDE_PASSWORD_FIELDS` → `SENSITIVE_FIELDS_BY_TYPE` (Map)
- `OVERVIEW_ONLY_FIELDS` → `OVERVIEW_FIELDS_BY_TYPE` (Map)
- フォールバック: 未知の entryType は LOGIN と同じ動作

### Step 2: 呼び出し元に `entryType` を渡す

**`src/app/api/share-links/route.ts`** (line 92):
```typescript
const filteredData = applySharePermissions(
  data as Record<string, unknown>,
  permissions ?? [],
  entryType,  // ← 追加 (既に entry.entryType で取得済み)
);
```

**`src/components/share/share-dialog.tsx`** (line 190):
```typescript
const filteredData = applySharePermissions(safeData, permissions, entryType);
```
- `entryType` は既に props で渡されている

### Step 3: テスト更新

**`src/lib/constants/share-permission.test.ts`**:
- 既存テストは `entryType` 未指定で後方互換確認
- 新規テスト追加:
  - CREDIT_CARD + HIDE_PASSWORD → `cardNumber`, `cvv` 除外、`cardholderName` 保持
  - CREDIT_CARD + OVERVIEW_ONLY → `title`, `cardholderName`, `brand`, `expiryMonth`, `expiryYear` のみ
  - BANK_ACCOUNT + HIDE_PASSWORD → `accountNumber`, `routingNumber`, `iban` 除外
  - BANK_ACCOUNT + OVERVIEW_ONLY → `title`, `bankName`, `accountType`, `accountHolderName` のみ
  - IDENTITY + HIDE_PASSWORD → `idNumber` 除外
  - SOFTWARE_LICENSE + HIDE_PASSWORD → `licenseKey` 除外
  - SECURE_NOTE + HIDE_PASSWORD → `content` 除外
  - PASSKEY + HIDE_PASSWORD → `credentialId` 除外

---

## ファイル一覧

**変更 (3)**:
- `src/lib/constants/share-permission.ts` — エントリータイプ別定義 + シグネチャ変更
- `src/app/api/share-links/route.ts` — `entryType` を渡す
- `src/components/share/share-dialog.tsx` — `entryType` を渡す

**テスト更新 (1)**:
- `src/lib/constants/share-permission.test.ts` — エントリータイプ別ケース追加

---

## Verification

1. `npx tsc --noEmit` — 0 errors
2. `npx vitest run src/lib/constants/share-permission.test.ts` — 全パス
3. `npx vitest run` — 全テストパス
4. 手動: クレジットカードエントリで「概要のみ」共有 → タイトル, カード名義, ブランド, 有効期限が表示
5. 手動: 銀行口座エントリで「パスワード非表示」共有 → 口座番号, ルーティング番号, IBAN が非表示
locale String? @db.VarChar(5)
```

**`prisma/migrations/20260302120000_add_user_locale/migration.sql`**:
```sql
ALTER TABLE "users" ADD COLUMN "locale" VARCHAR(5);
```
- Nullable、デフォルトなし。`null` = 「未設定 → フォールバック」
- RLS ポリシー変更不要（既存 tenant_isolation がそのまま適用）

### Step 2: 共通ヘルパー `resolveUserLocale`

**`src/lib/locale.ts`** (新規):
```typescript
export function resolveUserLocale(
  storedLocale?: string | null,
  acceptLanguage?: string | null,
): string
```
- 優先順位: DB保存値 → Accept-Language → `routing.defaultLocale`（"ja"）
- `new-device-detection.ts` のローカル `resolveLocale` を置き換え

### Step 3: API エンドポイント `PUT /api/user/locale`

**`src/app/api/user/locale/route.ts`** (新規):
- Zod で `locale` を `z.enum(["ja", "en"])` バリデーション
- `auth()` で認証、`withUserTenantRls` で更新
- 監査ログ不要（セキュリティ非関連）

**`src/lib/constants/api-path.ts`** — `USER_LOCALE` 追加

**`src/proxy.ts`** 108行目付近 — 保護ルートに追加:
```typescript
pathname.startsWith(`${API_PATH.API_ROOT}/user`)
```

### Step 4: LanguageSwitcher の更新

**`src/components/layout/language-switcher.tsx`** — `switchLocale` に fire-and-forget PUT を追加:
```typescript
const switchLocale = (newLocale: string) => {
  router.replace(pathname, { locale: newLocale });
  void fetch("/api/user/locale", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: newLocale }),
  });
};
```
- 未ログイン時（サインインページ）は 401 → サイレント無視

### Step 5: 新デバイス検知の更新

**`src/lib/new-device-detection.ts`**:
- ローカル `resolveLocale` 関数を削除、`resolveUserLocale` を import
- `user` クエリの `select` に `locale` 追加
- `resolveUserLocale(user.locale, meta.acceptLanguage)` に変更

### Step 6: 緊急アクセスメールの更新（8ファイル）

全て同じパターン: `routing.defaultLocale` → `resolveUserLocale(recipient.locale)`

| ファイル | メール受信者 | locale 取得元 |
|---------|------------|-------------|
| `emergency-access/route.ts` | grantee | grantee ユーザー検索（best-effort） |
| `emergency-access/accept/route.ts` | owner | owner.locale |
| `emergency-access/reject/route.ts` | owner | owner.locale |
| `emergency-access/[id]/accept/route.ts` | owner | owner.locale |
| `emergency-access/[id]/decline/route.ts` | owner | owner.locale |
| `emergency-access/[id]/request/route.ts` | owner | owner.locale |
| `emergency-access/[id]/approve/route.ts` | grantee | grantee.locale |
| `emergency-access/[id]/revoke/route.ts` | grantee | grantee.locale |

受信者の `select` に `locale` を追加し、`import { routing }` → `import { resolveUserLocale }` に変更。

---

## ファイル一覧

**新規 (3)**:
- `prisma/migrations/20260302120000_add_user_locale/migration.sql`
- `src/lib/locale.ts`
- `src/app/api/user/locale/route.ts`

**変更 (12)**:
- `prisma/schema.prisma` — User に `locale` 追加
- `src/lib/constants/api-path.ts` — `USER_LOCALE` 定数追加
- `src/proxy.ts` — `/api/user` を保護ルートに追加
- `src/components/layout/language-switcher.tsx` — PUT 呼び出し追加
- `src/lib/new-device-detection.ts` — `resolveUserLocale` 使用
- `src/app/api/emergency-access/route.ts`
- `src/app/api/emergency-access/accept/route.ts`
- `src/app/api/emergency-access/reject/route.ts`
- `src/app/api/emergency-access/[id]/accept/route.ts`
- `src/app/api/emergency-access/[id]/decline/route.ts`
- `src/app/api/emergency-access/[id]/request/route.ts`
- `src/app/api/emergency-access/[id]/approve/route.ts`
- `src/app/api/emergency-access/[id]/revoke/route.ts`

---

## Verification

1. `npm run db:migrate` 成功
2. LanguageSwitcher で en → ja 切替 → DB に `locale = "ja"` が保存されることを Prisma Studio で確認
3. 別ブラウザでログイン → 通知・メールがユーザーの選択言語で届く
4. `npm run lint` パス
5. 既存テスト + 新規テストが全パス

---

# (以下は Batch D の元の計画)


---

## 実装順序

依存関係とリスクを考慮した順序:

| Step | Feature | Group | Complexity | Schema |
|------|---------|-------|------------|--------|
| 1 | N-2: 通知センター | D-2 | M | New model |
| 2 | B-4: セキュリティポリシー | D-3 | M | New model |
| 3 | U-4: セキュアノートテンプレート | D-1 | S | None |
| 4 | E-6: Markdown 対応 | D-1 | M | None |
| 5 | V-6: ネストタグ | D-1 | L | Modify 2 models |
| 6 | S-6: 新デバイスログイン通知 | D-2 | M | None |
| 7 | B-3: SIEM 連携 | D-3 | L | New model |
| 8 | C-2: 共有権限 | D-4 | M | Modify 1 model |

**理由:** N-2 を最初に → S-6 が通知モデルを利用。B-4 を早期に → 後続の enforcement に必要。U-4/E-6 はスキーマ変更なし・低リスク。V-6 は unique constraint 変更で最も複雑。

---

## Step 1: N-2 — アプリ内通知センター

### Schema (`prisma/schema.prisma`)
```prisma
enum NotificationType {
  SECURITY_ALERT
  NEW_DEVICE_LOGIN
  EMERGENCY_ACCESS
  SHARE_ACCESS
  TEAM_INVITE
  ENTRY_EXPIRING
  WATCHTOWER_ALERT
  POLICY_UPDATE
}

model Notification {
  id        String           @id @default(cuid())
  userId    String           @map("user_id")
  tenantId  String           @map("tenant_id")
  type      NotificationType
  title     String           @db.VarChar(200)
  body      String           @db.Text
  metadata  Json?
  isRead    Boolean          @default(false) @map("is_read")
  createdAt DateTime         @default(now()) @map("created_at")
  user   User   @relation(...)
  tenant Tenant @relation(...)
  @@index([userId, isRead, createdAt])
  @@index([tenantId])
  @@map("notifications")
}
```
- RLS: ENABLE + FORCE + tenant_isolation policy (既存パターン準拠)
- User, Tenant に `notifications Notification[]` を追加

### API Routes
- `src/app/api/notifications/route.ts` — GET (cursor ページネーション, limit max 50, unreadOnly filter), PATCH (全件既読)
- `src/app/api/notifications/count/route.ts` — GET (未読数のみ返却、軽量ポーリング用)
- `src/app/api/notifications/[id]/route.ts` — PATCH (個別既読), DELETE

### Lib
- `src/lib/notification.ts` — `createNotification()` fire-and-forget ヘルパー (logAudit パターン踏襲)
  - **設計ルール**: `body` に E2E 暗号化エントリの内容 (タイトル、パスワード等) を含めてはならない。許可される情報: タイムスタンプ、IP アドレス、UA カテゴリ、アクションタイプ等の非秘匿情報のみ
  - `metadata` も同様に audit ログの `METADATA_BLOCKLIST` と同等のブロックリスト検査を適用

### UI
- `src/components/notifications/notification-bell.tsx` — Bell アイコン + unread count バッジ
  - `/api/notifications/count` を 60s 間隔でポーリング (軽量 count endpoint)
  - 将来的に SSE への移行を検討 (コメントで明記)
- `src/components/notifications/notification-dropdown.tsx` — ドロップダウンリスト + 全既読ボタン
- `src/components/notifications/notification-item.tsx` — 各通知行 (タイプ別アイコン, 相対時刻, 未読ドット)
- 統合先: `src/components/layout/header.tsx` line 93 (`<LanguageSwitcher />` と user dropdown の間)

### i18n
- 新規: `messages/{en,ja}/Notifications.json` (~14 keys)

### Tests
- `src/app/api/notifications/route.test.ts` — GET pagination, PATCH mark-all-read
- `src/app/api/notifications/[id]/route.test.ts` — PATCH mark-read, DELETE
- `src/components/notifications/notification-bell.test.tsx` — polling 間隔 (`vi.useFakeTimers`), アンマウント後の fetch 停止, 未読バッジ表示

---

## Step 2: B-4 — セキュリティポリシー

### Schema
```prisma
model TeamPolicy {
  id        String  @id @default(cuid())
  teamId    String  @unique @map("team_id")
  tenantId  String  @map("tenant_id")
  minPasswordLength         Int     @default(0)
  requireUppercase          Boolean @default(false)
  requireLowercase          Boolean @default(false)
  requireNumbers            Boolean @default(false)
  requireSymbols            Boolean @default(false)
  maxSessionDurationMinutes Int?
  requireRepromptForAll     Boolean @default(false)
  allowExport               Boolean @default(true)
  allowSharing              Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  team   Team   @relation(...)
  tenant Tenant @relation(...)
  @@index([tenantId])
  @@map("team_policies")
}
```
- Team に `policy TeamPolicy?` を追加
- RLS 設定必須

### AuditAction 追加
- `schema.prisma` enum `AuditAction` + `src/lib/constants/audit.ts` に `POLICY_UPDATE` を追加

### API
- `src/app/api/teams/[teamId]/policy/route.ts` — GET (デフォルト値 or DB値), PUT (upsert, OWNER/ADMIN のみ `TEAM_UPDATE` 権限)
- PUT 成功時に `logAudit({ action: AUDIT_ACTION.POLICY_UPDATE })` を記録

### Lib
- `src/lib/team-policy.ts` — `getTeamPolicy()`, `assertPolicyAllowsExport()`, `assertPolicyAllowsSharing()`

### Enforcement 設計
- **サーバーサイド**: `allowExport` → チーム audit log download で 403。`allowSharing` → share link 作成時に 403
- **クライアントサイド (advisory)**: パスワード強度 (minLength 等) は E2E 暗号化のためサーバーで強制不可。VaultContext 内で TeamPolicy を参照し、パスワードジェネレーターのデフォルト設定を上書き + UI 警告を表示。入力時のバリデーションエラーとして表示するが、保存自体はブロックしない
- **設計意図**: advisory + UI 強制 + export/share 時の再確認

### Validation (`src/lib/validations.ts`)
- `upsertTeamPolicySchema` 追加

### UI
- `src/components/team/team-policy-settings.tsx` — チーム設定ページ内にフォーム (Switch, Input, Card)
- 統合先: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`

### i18n
- 新規: `messages/{en,ja}/TeamPolicy.json` (~12 keys)

### Tests
- `src/app/api/teams/[teamId]/policy/route.test.ts` — GET default, PUT by ADMIN, PUT rejected by MEMBER, upsert べき等性 (PUT 後 GET で一致)
- Enforcement テスト: `audit-logs/download/route.test.ts` 内に `allowExport=false` で 403 を返すケース追加

---

## Step 3: U-4 — セキュアノートテンプレート

### Schema 変更なし

### Lib
- 新規: `src/lib/secure-note-templates.ts` — 静的テンプレート定義 6 種:
  - blank, wifi, api_key, server, recovery_codes, meeting

### UI 変更
- `src/components/passwords/secure-note-form.tsx`:
  - `mode === "create"` 時のみ テンプレート Select を title 上部に表示
  - 選択時に title + content をプリフィル (既存入力がある場合はスキップ)

### i18n
- `messages/{en,ja}/SecureNoteForm.json` にテンプレート関連 ~8 keys 追加

### Tests
- `src/lib/secure-note-templates.test.ts`:
  - ID 一意性: `expect(new Set(templates.map(t => t.id)).size).toBe(templates.length)` (数をハードコードしない)
  - 全テンプレートに titleKey が存在すること

---

## Step 4: E-6 — セキュアノート Markdown 対応

### Package
```bash
npm install react-markdown remark-gfm
```
- `rehype-raw` は不使用 (HTML 注入防止)

### Encrypted Blob 変更
- `encryptedBlob` 内に `isMarkdown: boolean` フラグを追加 (デフォルト `true` で新規作成、既存エントリは `undefined` → `false` 扱い)
- テンプレート (U-4) 使用時も Markdown として扱うため、テンプレート選択で `isMarkdown` は自動 `true`

### UI 変更

**Form (`src/components/passwords/secure-note-form.tsx`):**
- Edit / Preview タブ切替を textarea 上部に追加
- Preview: `<ReactMarkdown remarkPlugins={[remarkGfm]}>` + `prose prose-sm dark:prose-invert`

**Detail view (`src/components/passwords/password-detail-inline.tsx` line 756-766):**
- `isMarkdown` が true (または undefined でない) の場合は Rendered をデフォルト表示
- Rendered / Source トグル追加

### i18n
- `SecureNoteForm.json` に `editTab`, `previewTab` 追加
- `PasswordDetail.json` に `showMarkdown`, `showSource` 追加

### Tests
- `src/components/passwords/secure-note-markdown.test.tsx`:
  - headings / list のレンダリング確認
  - **XSS 耐性**: `<script>` タグが DOM に挿入されないこと (`container.querySelector('script')` で確認)
  - `<a href="javascript:...">` が無害化されること
  - `rehype-raw` 未使用の検証 (HTML タグがテキストとして表示)

---

## Step 5: V-6 — ネストタグ

### Schema 変更
**Tag:**
- `parentId String? @map("parent_id")` 追加
- 自己参照リレーション: `parent Tag? @relation("TagHierarchy", ...)` + `children Tag[] @relation("TagHierarchy")`
- Unique constraint: `@@unique([name, userId])` → `@@unique([name, parentId, userId])`
- Migration SQL: ルートレベル (parentId IS NULL) の一意性は partial index で保証

**TeamTag:** 同様の変更 (`@@unique([name, parentId, teamId])`)

### Migration (要注意)
- 既存 unique constraint を DROP → 新 constraint を CREATE
- Partial index: `CREATE UNIQUE INDEX "tags_name_user_id_root_key" ON "tags" ("name", "user_id") WHERE "parent_id" IS NULL`
- TeamTag 用も同様: `CREATE UNIQUE INDEX "team_tags_name_team_id_root_key" ON "team_tags" ("name", "team_id") WHERE "parent_id" IS NULL`
- **既存コード影響**: `prisma.tag.findUnique({ where: { name_userId: ... } })` を使用している箇所を事前に grep し、新 compound key に移行

### 循環参照防止
- DB レベル: `CHECK ("parent_id" != "id")` で自己参照を禁止
- API レベル: INSERT/UPDATE 時に祖先チェーンを再帰的に走査し、循環を検出。Max depth 3 も同時に検証
- `tag-tree.ts` 内に `validateParentChain(tagId, newParentId, allTags)` を実装。visited set で cycle detection

### Lib
- 新規: `src/lib/tag-tree.ts`:
  - `buildTagTree(flatTags)` — フラット配列からツリー構築 (orphan tags は root にフォールバック)
  - `flattenTagTree(tree)` — depth-first flatten (ドロップダウン表示用)
  - `collectDescendantIds(tree, tagId)` — フィルタ時の子孫 ID 収集
  - `validateParentChain(tagId, newParentId, allTags)` — 循環参照 + depth 検証

### API 変更
- `GET /api/tags` — `?tree=true` パラメータ追加
- `POST /api/tags` — `parentId` 受付、`validateParentChain()` で depth + cycle 検証
- `PUT /api/tags/[id]` — `parentId` 変更対応、同様の検証
- Team tag routes も同様

### Validation (`src/lib/validations.ts`)
- `createTagSchema` に `parentId: z.string().cuid().optional().nullable()` 追加

### UI 変更
- `src/components/tags/tag-input.tsx` — tree 取得、インデント表示 (`paddingLeft: depth * 12px`)
- `src/components/tags/tag-dialog.tsx` — 親タグ選択セレクタ追加
- `src/components/team/team-tag-input.tsx` — 同様
- Tag フィルタ: 親タグ選択時に `collectDescendantIds()` で子孫含む

### i18n
- `messages/{en,ja}/Tag.json` に `parentTag`, `noParent`, `pathSeparator`, `maxDepthError`, `cycleError` 追加

### Tests
- `src/lib/tag-tree.test.ts`:
  - `buildTagTree` 正常系 + orphan handling
  - `collectDescendantIds` 正常系
  - `validateParentChain`: depth 3 OK / depth 4 → error / cycle → error
- `src/app/api/tags/route.test.ts`:
  - POST with parentId
  - GET with tree=true
  - 同名ルートタグの重複 → Prisma P2002 → 409 Conflict をモック
  - depth 4 → 400

---

## Step 6: S-6 — 新デバイスログイン通知

### Schema 変更なし
(Session に ipAddress / userAgent は既存)

### Auth adapter 変更 (レビュー反映: signIn event → createSession に移動)
- `src/lib/auth-adapter.ts` の `createSession` 内で `void checkNewDeviceAndNotify(userId, meta)` を呼び出し
  - **理由**: `events.signIn` は `{ user }` のみ受取で `sessionMetaStorage.getStore()` が参照できない可能性がある。`createSession` は `sessionMetaStorage` のコンテキスト内で実行されるため、IP/UA に確実にアクセス可能

### Lib
- 新規: `src/lib/new-device-detection.ts`:
  - `checkNewDeviceAndNotify(userId, meta: { ip, userAgent })` を export
  - 過去 30 日の session.userAgent と Bowser で browser.name + os.name を比較
  - 一致なし → メール送信 + `createNotification()` (N-2 活用)
  - 初回ログイン (sessions 0 件) → 通知スキップ
  - fire-and-forget (auth フロー妨げない。try/catch で全例外を握りつぶし)

### Email Template
- 新規: `src/lib/email/templates/new-device-login.ts` (emergency-access.ts パターン踏襲、LABELS + locale)

### i18n
- `Notifications.json` に `newDeviceLogin_title`, `newDeviceLogin_body` 追加

### Tests
- `src/lib/new-device-detection.test.ts`:
  - 同一デバイス (同 browser.name + os.name) → 通知なし
  - 新デバイス → `sendEmail` + `createNotification` が呼ばれる
  - 初回ログイン (sessions 0 件) → 通知スキップ
  - 例外発生時 → throw しないこと
- `src/__tests__/auth-adapter-device.test.ts` — createSession から `checkNewDeviceAndNotify` が呼ばれることを検証

---

## Step 7: B-3 — SIEM 連携

### AuditAction 追加
- `AUDIT_LOG_DOWNLOAD`, `WEBHOOK_CREATE`, `WEBHOOK_DELETE`, `WEBHOOK_DELIVERY_FAILED` を `schema.prisma` + `src/lib/constants/audit.ts` に追加

### Sub-feature A: 監査ログダウンロード (最優先)

**API:**
- `src/app/api/audit-logs/download/route.ts` — GET
  - format: `jsonl` (default) / `csv`
  - from, to (ISO date, max range 90 days)
  - actions フィルタ
  - Streaming `ReadableStream` + cursor-based batch (500 件ずつ)
  - **Rate limit**: `createRateLimiter({ windowMs: 60_000, max: 2 })` per user
  - ダウンロード自体を `logAudit({ action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD })` で記録
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts` — team 版 (ADMIN/OWNER)
  - **B-4 enforcement**: `assertPolicyAllowsExport(teamId)` でポリシーチェック

### Sub-feature B: TeamWebhook

**Schema (レビュー反映: secretHash → secretEncrypted):**
```prisma
model TeamWebhook {
  id               String   @id @default(cuid())
  teamId           String   @map("team_id")
  tenantId         String   @map("tenant_id")
  url              String   @db.VarChar(2048)
  secretEncrypted  String   @map("secret_encrypted") @db.Text
  secretIv         String   @map("secret_iv") @db.VarChar(24)
  secretAuthTag    String   @map("secret_auth_tag") @db.VarChar(32)
  masterKeyVersion Int      @default(1) @map("master_key_version")
  events           String[]
  isActive         Boolean  @default(true)
  lastError        String?  @db.Text
  failCount        Int      @default(0)
  lastDeliveredAt  DateTime? @map("last_delivered_at")
  lastFailedAt     DateTime? @map("last_failed_at")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  team   Team   @relation(...)
  tenant Tenant @relation(...)
  @@index([teamId])
  @@index([tenantId])
  @@map("team_webhooks")
}
```
- **Secret 保管**: 生成した HMAC secret をサーバーサイドマスターキーで AES-256-GCM 暗号化して保存 (`secretEncrypted` + `secretIv` + `secretAuthTag`)。配信時にマスターキーで復号して HMAC 計算
- plain secret は POST レスポンスで一度だけ返却
- **Key versioning**: `masterKeyVersion` でどのマスターキーバージョンで暗号化したか記録。マスターキーローテーション後も旧バージョンのキーで復号可能 (既存の PasswordShare と同じパターン `src/lib/share-crypto.ts` を踏襲)

**API:**
- `src/app/api/teams/[teamId]/webhooks/route.ts` — POST (作成), GET (一覧)
- `src/app/api/teams/[teamId]/webhooks/[webhookId]/route.ts` — DELETE

**Webhook Dispatcher (`src/lib/webhook-dispatcher.ts`):**
- `dispatchWebhook(teamId, event)` — fire-and-forget
- `global.fetch` で POST、HMAC `X-Signature: sha256=<hmac>` ヘッダー
- 3 回リトライ (exponential backoff: 1s, 5s, 25s)
- 3 回失敗後: `logAudit({ action: AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED })` で記録 + `failCount` 更新 + `lastFailedAt` 更新
- `logAudit()` のコールパスからは呼び出さない (無限ループ防止)。代わりに `createNotification()` 成功後や明示的な呼び出し元から配信

### i18n
- 新規: `messages/{en,ja}/TeamWebhook.json` (~10 keys)

### Tests
- `src/app/api/audit-logs/download/route.test.ts`:
  - `request-builder.ts` に `parseStreamResponse(response): Promise<string>` ヘルパー追加
  - JSONL 形式の行数・各行の JSON パース確認
  - CSV ヘッダー行 + データ行確認
  - date range > 90 days → 400
  - rate limit 超過 → 429
- `src/app/api/teams/[teamId]/webhooks/route.test.ts` — CRUD by OWNER, MEMBER → 403
- `src/lib/webhook-dispatcher.test.ts` — `vi.useFakeTimers()` でリトライ間隔制御, HMAC 署名検証 (固定 secret で期待値比較), 3 回失敗後の `failCount` 更新

---

## Step 8: C-2 — 共有権限

### Schema 変更
`PasswordShare` に追加:
```prisma
permissions String[] @default([])
```

### Constants
- 新規: `src/lib/constants/share-permission.ts`:
  - `VIEW_ALL` — 全フィールド表示 (デフォルト, 後方互換)
  - `HIDE_PASSWORD` — パスワード/CVV 非表示
  - `OVERVIEW_ONLY` — タイトル/ユーザー名/URL のみ

### API 変更
- `POST /api/share-links` — `permissions` 受付

### 権限強制の設計 (レビュー反映: E2E の reduced blob 方式)

**Personal shares (server-side encryption):**
- サーバー側で `applyPermissions(data, permissions)` によりフィールドを除外してから暗号化 → `encryptedData` に格納
- Public view serving 時は通常通り復号して返却 (既にフィルタ済み)

**Team shares (E2E encryption) — reduced blob 方式:**
- **共有作成時 (クライアント側)**: `permissions` に応じて reduced blob を作成
  - `HIDE_PASSWORD`: `{ ...data, password: undefined, cvv: undefined }` を暗号化
  - `OVERVIEW_ONLY`: `{ title, username, url }` のみを暗号化
  - `VIEW_ALL`: 全フィールドを暗号化 (現行動作)
- 共有者のクライアントが権限に応じたデータを事前にフィルタリングしてから暗号化 → fragment key で保護
- **セキュリティ保証**: サーバーも閲覧者も暗号化前のフィールドにアクセス不可。権限は暗号化の「前」に適用されるため、クライアントサイドバイパスは不可能

### Validation (`src/lib/validations.ts`)
- `createShareLinkSchema` に `permissions` 追加

### UI 変更
- `src/components/share/share-dialog.tsx` — RadioGroup (3 択) を expiry と maxViews の間に追加
  - Team share の場合: 選択した permission に応じて `decryptedData` をフィルタリングしてから暗号化
- `src/components/share/share-entry-view.tsx` — personal share は既にフィルタ済みデータを表示
- `src/components/share/share-e2e-entry-view.tsx` — team share は reduced blob を復号して表示 (追加のマスク不要)

### i18n
- `messages/{en,ja}/Share.json` に ~4 keys 追加

### Tests
- `src/app/api/share-links/route.test.ts` 拡張:
  - `HIDE_PASSWORD` → レスポンスから password フィールドが除外
  - `OVERVIEW_ONLY` → title, username, url のみ
  - `VIEW_ALL` (default) → 全フィールド (後方互換)

---

## Migration 一覧

| Order | Feature | Migration name | Table | 追加 enum |
|-------|---------|---------------|-------|-----------|
| 1 | N-2 | `add_notification_model` | notifications (new) | NotificationType |
| 2 | B-4 | `add_team_policy` | team_policies (new) | AuditAction += POLICY_UPDATE |
| 3 | V-6 | `add_tag_hierarchy` | tags, team_tags (modify) | — |
| 4 | B-3 | `add_team_webhook` | team_webhooks (new) | AuditAction += AUDIT_LOG_DOWNLOAD, WEBHOOK_* |
| 5 | C-2 | `add_share_permissions` | password_shares (modify) | — |

全新規テーブルに RLS ENABLE + FORCE + tenant_isolation policy 必須。
Migration SQL にはテーブル作成、FK 制約、インデックス、RLS ポリシーを全て含める。

---

## Verification

各 Step 完了時に:
1. `npm run db:migrate` 成功
2. 該当 API の手動テスト (curl / Prisma Studio)
3. `npm run lint` パス
4. 既存テスト + 新規テストが全パス
5. `npm run test -- --coverage` で新規ファイルの coverage 確認
6. UI 動作確認 (`npm run dev`)
7. feature-gap-analysis.md の該当行を ~~取り消し線~~ + 完了日付で更新
