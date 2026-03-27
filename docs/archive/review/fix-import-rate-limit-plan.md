# Plan: fix-import-rate-limit

## Context

KeePassXC XML から 403 件インポートしたところ 30 件しかインポートできない。
原因: `POST /api/passwords` のレートリミッター `createRateLimiter({ windowMs: 60_000, max: 30 })` がインポートの連続 POST をブロックしている。インポートループは 429 エラーを黙って握りつぶすため、ユーザーには 30 件だけインポートされたように見える。

## Requirements

- 数百件規模のインポートが完了すること
- 通常のパスワード作成 API の rate limit (30/min) は維持すること
- インポート操作のレート制御がサーバー側で完結すること（クライアントヘッダーに依存しない）
- 個人・チーム両方のインポートに対応すること

## Technical Approach

**バルクインポートAPIエンドポイント**

- 新規エンドポイント: `POST /api/passwords/bulk-import` (個人), `POST /api/teams/[teamId]/passwords/bulk-import` (チーム)
- リクエストボディ: `createE2EPasswordSchema` の配列（最大50件/リクエスト）
- クライアント: エントリを50件ずつチャンクに分割して直列送信
- レートリミッター: バルクインポートエンドポイント単位（30回/min = 最大1,500件/min相当）
- 通常の `POST /api/passwords` とバルクAPIのレートリミッターは独立。合算制限は設けない（インポートはセッション認証限定の一時的操作であり、通常利用との並行は正当なユースケース）
- 既存の `POST /api/passwords` には一切手を加えない

## Implementation Steps

### Step 0: Prisma schema + 監査定数追加

**File: `prisma/schema.prisma`** — `AuditAction` enum に `ENTRY_BULK_IMPORT` を追加
**File: `src/lib/constants/audit.ts`** — `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_PERSONAL`（TRANSFER グループ）, `AUDIT_ACTION_GROUPS_TEAM`（TRANSFER グループ）に追加
**File: `src/lib/constants/audit.test.ts`** — テスト更新
**Migration:** `npm run db:migrate` で新規マイグレーション作成

### Step 1: バリデーションスキーマ追加

**File: `src/lib/validations/entry.ts`**

```typescript
export const BULK_IMPORT_MAX_ENTRIES = 50;

export const bulkImportSchema = z.object({
  entries: z.array(createE2EPasswordSchema).min(1).max(BULK_IMPORT_MAX_ENTRIES),
  sourceFilename: z.string().max(FILENAME_MAX_LENGTH).optional(),
});

export const bulkTeamImportSchema = z.object({
  entries: z.array(createTeamE2EPasswordSchema).min(1).max(BULK_IMPORT_MAX_ENTRIES),
  sourceFilename: z.string().max(FILENAME_MAX_LENGTH).optional(),
});
```

上限50件の根拠: 1件あたり約5-10KB × 50 = 250-500KB。Next.js デフォルトbody制限（1MB）内に収まる。

### Step 2: 個人用バルクインポートAPI

**File: `src/app/api/passwords/bulk-import/route.ts`** (新規)

```typescript
const importLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();
  const userId = session.user.id;

  const rl = await importLimiter.check(`rl:passwords_bulk_import:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, bulkImportSchema);
  if (!result.ok) return result.response;

  const { entries, sourceFilename } = result.data;

  const created: string[] = [];
  let failedCount = 0;

  await withUserTenantRls(userId, async () => {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    if (!actor) return;

    for (const entry of entries) {
      try {
        // Per-entry folder/tag ownership check + create (same as existing POST /api/passwords)
        // This prevents TOCTOU — check and create in the same scope
        if (entry.folderId) {
          const folder = await prisma.folder.findFirst({ where: { id: entry.folderId, userId } });
          if (!folder) { failedCount++; continue; }
        }
        if (entry.tagIds?.length) {
          const ownedCount = await prisma.tag.count({ where: { id: { in: entry.tagIds }, userId } });
          if (ownedCount !== entry.tagIds.length) { failedCount++; continue; }
        }

        const created_entry = await prisma.passwordEntry.create({ data: { ... } });
        created.push(created_entry.id);
      } catch {
        failedCount++;
      }
    }
  });

  // Audit: bulk parent log
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
    userId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: { requestedCount: entries.length, createdCount: created.length, failedCount, filename: sanitizedFilename },
    ...extractRequestMeta(req),
  });

  // Audit: per-entry child logs
  logAuditBatch(created.map(entryId => ({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: entryId,
    metadata: { source: "bulk-import", parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT },
    ...extractRequestMeta(req),
  })));

  return NextResponse.json({ success: created.length, failed: failedCount }, { status: 201 });
}
```

設計判断:
- **セッション認証のみ** — `auth()` 使用。API key/extension token 不可
- **レートリミッター**: 30回/min × 50件 = 最大1,500件/min
- **部分成功**: 各エントリを個別 create し、失敗はスキップ。全件一括トランザクションだと1件のエラーで全体ロールバックされるため
- **TOCTOU 防止**: folder/tag チェックと create を各エントリごとに実行（事前一括チェックではなく）
- **`withUserTenantRls`**: 1回だけ呼び、その内部で全エントリをループ
- **レスポンス**: `{ success, failed }` のみ返す。個別エントリの失敗理由は含めない（tag/folder ID の存在確認に悪用されるリスクを排除）
- **監査ログ**: 親ログ `ENTRY_BULK_IMPORT` + 子ログ `ENTRY_CREATE` × N（bulk-trash パターン準拠）
- **クライアント側 `fireImportAudit`**: 変更不要 — 全チャンク完了後に1回呼ぶ（既存と同じ）

### Step 3: チーム用バルクインポートAPI

**File: `src/app/api/teams/[teamId]/passwords/bulk-import/route.ts`** (新規)

Step 2 と同様の構造に以下を追加:
- **認証**: `auth()` のみ使用（`authOrToken` は使用しない）
- **権限チェック**: `requireTeamPermission(teamId, userId, TEAM_PERMISSION.WRITE)` でチームメンバーシップ + 書き込み権限を検証
- **レートリミッターキー**: `rl:team_bulk_import:${teamId}:${userId}`（teamId を含める）
- **`isFavorite` 処理**: チームのfavoriteはjoinテーブル経由。バルクAPI内で create 後に `isFavorite: true` なエントリに対して favorite toggle APIを呼ぶ（既存の単一インポートと同じ挙動、失敗はbest-effort）
- **RLS**: `withTeamTenantRls(teamId, ...)` を使用
- **監査ログ**: scope を `AUDIT_SCOPE.TEAM` に変更

### Step 4: API定数追加

**File: `src/lib/constants/api-path.ts`**

```typescript
// API_PATH に追加
PASSWORDS_BULK_IMPORT: "/api/passwords/bulk-import",

// apiPath に追加
passwordsBulkImport: () => API_PATH.PASSWORDS_BULK_IMPORT,
teamPasswordsBulkImport: (teamId: string) => `/api/teams/${teamId}/passwords/bulk-import`,
```

### Step 5: クライアント側 — バルクAPI呼び出しに変更

**File: `src/components/passwords/password-import-importer.ts`**

現在の1件ずつ POST するループを、50件ずつチャンクに分割してバルクAPIに送信するよう変更:

```typescript
const BULK_IMPORT_CHUNK_SIZE = 50;
const MAX_RETRIES_PER_CHUNK = 3;

for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BULK_IMPORT_CHUNK_SIZE) {
  const chunk = entries.slice(chunkStart, chunkStart + BULK_IMPORT_CHUNK_SIZE);

  // Encrypt all entries in the chunk
  const encryptedEntries = [];
  for (const entry of chunk) {
    // Existing encryption logic (personal or team)
    encryptedEntries.push({ ... });
  }

  // Send chunk to bulk API with retry
  let retryCount = 0;
  let chunkSuccess = 0;
  let chunkFailed = chunk.length; // assume all failed until proven otherwise

  while (true) {
    try {
      const res = await fetchApi(bulkImportPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: encryptedEntries, sourceFilename }),
      });

      if (res.ok) {
        const data = await res.json();
        chunkSuccess = data.success;
        chunkFailed = data.failed;
        break;
      }
      if (res.status === 429 && retryCount < MAX_RETRIES_PER_CHUNK) {
        retryCount++;
        const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "2", 10);
        const delayMs = Math.min(Math.max(retryAfterSec * 1000, 1_000), 60_000);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      break; // non-429 error or retries exhausted
    } catch {
      break; // network error
    }
  }

  successCount += chunkSuccess;
  // onProgress is called once per chunk, after result is determined (not during retries)
  onProgress?.(Math.min(chunkStart + chunk.length, entries.length), entries.length);
}
```

設計判断:
- **直列送信**: チャンクは順次送信（並行送信しない）
- **onProgress**: チャンク処理確定後に1回だけ呼ぶ（リトライ中は呼ばない）
- **failedCount**: `entries.length - successCount` で計算（チャンク単位の failed を合算しても同じ結果）
- **429リトライ**: チャンク単位で最大3回。`Retry-After` ヘッダーを尊重

### Step 6: テスト追加

**File: `src/app/api/passwords/bulk-import/route.test.ts`** (新規)

モックパターンは既存の `passwords/route.test.ts` に準拠:
```typescript
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
```

テストケース:
- 正常系: 3件のエントリがバルクインポートされ `{ success: 3, failed: 0 }` を返す
- 上限超過: 51件でバリデーションエラー (400)
- 空配列: バリデーションエラー (400)
- レートリミッター: `mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 })` で 429
- 部分失敗: 3件中1件の folderId が不正 → `{ success: 2, failed: 1 }`
- 認証: セッションなしで 401
- 監査ログ: `logAudit` が `ENTRY_BULK_IMPORT` で呼ばれることを確認
- 監査ログ子: `logAuditBatch` が成功件数分の `ENTRY_CREATE` で呼ばれることを確認

**File: `src/app/api/teams/[teamId]/passwords/bulk-import/route.test.ts`** (新規)

テストケース:
- 正常系: チームエントリのバルクインポート
- 権限エラー: チームメンバーでないユーザーは 403
- レートリミッター: teamId を含むRLキーで check が呼ばれることを確認
- 認証: セッションなしで 401
- isFavorite: favorite toggle が成功エントリに対して呼ばれることを確認

**File: `src/components/passwords/password-import-importer.test.ts`** (更新)

テストヘルパー拡張:
- 既存 `response()` に `status` フィールドを追加: `status: ok ? 201 : 500`
- 新規 `bulkResponse(ok, success, failed)` ヘルパー: `{ ok, status: ok ? 201 : 500, headers: new Headers(), json: async () => ({ success, failed }) }`
- 新規 `response429(retryAfterSec)` ヘルパー: `{ ok: false, status: 429, headers: new Headers({ "Retry-After": String(retryAfterSec) }), json: async () => ({}) }`

テストケース:
- チャンク分割: 120件 → 3チャンク、fetch が3回呼ばれること
- 各チャンクの onProgress: `expect(progress).toHaveBeenNthCalledWith(1, 50, 120)`, `(2, 100, 120)`, `(3, 120, 120)`
- 429リトライ: 1回目 429、2回目成功 → successCount に加算
- リトライ上限: 3回連続 429 → チャンク分を失敗扱い
- 正常レスポンスの success/failed カウント集計

## Testing Strategy

- `npx vitest run` — 全テスト合格
- `npx next build` — ビルド成功
- 手動テスト: KeePassXC XML 403 件のインポートが全件成功すること

## Considerations & Constraints

- 既存の `POST /api/passwords` は一切変更しない — 後方互換性を維持
- 既存の bulk-trash/bulk-archive/bulk-restore パターン（`parseBody` + `withUserTenantRls` + `logAuditBatch`）に準拠
- `MAX_BULK_IDS = 100`（既存）とは独立して `BULK_IMPORT_MAX_ENTRIES = 50` を定義（暗号化データはIDより大きいため）
- チーム用バルクインポートAPIも同時に作成（チーム側にも同じインポート機能がある）
- `x-passwd-sso-source: import` ヘッダーは廃止しない — 既存の監査ログとの後方互換性のため残す。ただしレート制御の判断には使用しない

## Critical Files

**新規作成:**
- `src/app/api/passwords/bulk-import/route.ts` — 個人用バルクインポートAPI
- `src/app/api/passwords/bulk-import/route.test.ts` — テスト
- `src/app/api/teams/[teamId]/passwords/bulk-import/route.ts` — チーム用バルクインポートAPI
- `src/app/api/teams/[teamId]/passwords/bulk-import/route.test.ts` — テスト

**変更:**
- `prisma/schema.prisma` — `AuditAction` enum に `ENTRY_BULK_IMPORT` 追加
- `src/lib/constants/audit.ts` — 定数・グループ追加
- `src/lib/constants/audit.test.ts` — テスト更新
- `src/lib/validations/entry.ts` — `bulkImportSchema`, `bulkTeamImportSchema` 追加
- `src/lib/constants/api-path.ts` — パス定数追加
- `src/components/passwords/password-import-importer.ts` — チャンク分割 + バルクAPI呼び出し
- `src/components/passwords/password-import-importer.test.ts` — テスト更新

**変更なし:**
- `src/app/api/passwords/route.ts` — 既存エンドポイントは変更不要
- `src/lib/rate-limit.ts` — 既存のまま使用

## Review Findings Summary (Round 2)

反映した指摘:
- F-1: `ENTRY_BULK_IMPORT` の Prisma マイグレーション + 定数追加を Step 0 に追加
- F-2: チームの `isFavorite` 処理を Step 3 に明記
- F-3: onProgress は チャンク確定後に1回のみ。failedCount の計算方法を明示
- F-4: `withUserTenantRls` を1回だけ呼ぶ実装パターンを明示
- S-1: 合算制限を設けない設計意図をプランに記録
- S-2: folder/tag チェックをエントリごとに実行（TOCTOU 防止）
- S-3: レスポンスに failedCount のみ返す（個別失敗理由なし）
- S-4: チーム用も `auth()` のみ使用を明記
- T-1: チーム用テストケースを Step 6 に追加
- T-2: `bulkResponse` / `response429` ヘルパーを定義
- T-3: rate-limit モックパターンを明記
- T-4: onProgress の具体的アサーション仕様を明示
- T-5: 部分失敗のアサーション仕様を明示
