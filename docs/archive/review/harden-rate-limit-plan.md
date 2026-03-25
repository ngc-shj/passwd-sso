# Plan: harden-rate-limit

## Objective

Rate limiting の実装を体系的に強化する。レビュー（`docs/archive/review/rate-limit-review.md`）で検出された Major 12 件 / Minor 8 件の指摘に対処し、コアライブラリ・エンドポイント適用・テストの3層すべてを改善する。

## Requirements

### Functional
- Redis 設定検証をサーバー起動時に実行し、レイジー検証を廃止する
- Redis 障害時にエラーログを出力する（サイレントフォールバックを排除）
- 全 429 レスポンスに `Retry-After` ヘッダーを統一的に返す
- 未保護の高リスクエンドポイント 8 箇所に rate limit を追加する
- キープレフィックスを `rl:` に統一する
- CSP report の手製リミッターを `createRateLimiter()` に置換する

### Non-functional
- 既存テストが全て通ること
- `npx next build` が成功すること
- rate-limit 関連のテストカバレッジを改善する

## Technical Approach

### Step 1: コアライブラリ修正 (`src/lib/rate-limit.ts`)

**1a. `validateRedisConfig()` を `instrumentation.ts` に移動**

`src/instrumentation.ts` の `register()` 内で `validateRedisConfig()` を呼ぶ。`rate-limit.ts` 内のレイジー検証（`redisConfigValidated` フラグ + `check()` 内の呼び出し）を削除する。

```typescript
// src/instrumentation.ts — register() 内、既存の NEXT_RUNTIME ブロックに追加
if (process.env.NEXT_RUNTIME === "nodejs") {
  const { validateRedisConfig } = await import("@/lib/redis");
  validateRedisConfig(); // production で REDIS_URL 未設定の場合のみ throw
  // ... 既存の getKeyProvider() 等
}
```

`rate-limit.ts` から `redisConfigValidated` 変数と `check()` 内の検証ブロックを削除。

**注意**: `validateRedisConfig()` は「REDIS_URL が設定されているか」のみを検証する（接続テストではない）。Redis への接続性は readiness probe (`/api/health/ready`) が担当しており、起動時の Redis 到達不能でサービスが abort することはない。

**1b. Redis エラー時のログ出力追加**

`checkRedis()` の `catch` ブロックでログを出力する。頻度制限のため、エラーログの重複出力を抑制する（30秒に1回）。

```typescript
let lastRedisErrorLog = 0;
const REDIS_ERROR_LOG_INTERVAL = 30_000;

function logRedisError(): void {
  const now = Date.now();
  if (now - lastRedisErrorLog < REDIS_ERROR_LOG_INTERVAL) return;
  lastRedisErrorLog = now;
  getLogger().error("rate-limit.redis.fallback");
}
```

**セキュリティ**: `err` オブジェクトをログに渡さない（`REDIS_URL` に認証情報が含まれる場合の平文漏洩を防止）。固定メッセージ `"rate-limit.redis.fallback"` のみを出力する。

```typescript
catch {
  logRedisError();
  return null;
}
```

**1c. `rateLimited()` プリセットを `api-response.ts` に追加**

```typescript
// src/lib/api-response.ts
export const rateLimited = (retryAfterMs?: number) => {
  const headers: Record<string, string> = {};
  if (retryAfterMs != null && retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  }
  return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429, undefined, headers);
};
```

`errorResponse()` に `headers` パラメータを追加（オプショナル4番目引数）:

```typescript
export function errorResponse(
  code: ApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    details ? { error: code, ...details } : { error: code },
    { status, headers },
  );
}
```

**後方互換性**: 4番目の `headers` パラメータはオプショナルであり、既存の `errorResponse(code, status)` や `errorResponse(code, status, details)` 呼び出しは変更不要。`NextResponse.json()` の `init.headers` は `undefined` 許容のため、既存動作に影響しない。

### Step 2: 全 429 レスポンスを `rateLimited()` に統一

既存の全 `errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429)` 呼び出しを `rateLimited(result.retryAfterMs)` に置換する。対象は約 30 ファイル。

REST API v1 の手動 `Retry-After` 設定も `rateLimited()` に統一し、各ルートの `retryAfterHeaders()` ヘルパーを削除。

### Step 3: キープレフィックス統一

WebAuthn 系のキーを `rl:` プレフィックスに変更:
- `webauthn:signin-opts:` → `rl:webauthn_signin_opts:`
- `webauthn:email-signin-opts:` → `rl:webauthn_email_signin_opts:`
- `webauthn:signin-verify:` → `rl:webauthn_signin_verify:`
- `webauthn:reg-opts:` → `rl:webauthn_reg_opts:`
- `webauthn:reg-verify:` → `rl:webauthn_reg_verify:`
- `webauthn:auth-opts:` → `rl:webauthn_auth_opts:`
- `webauthn:auth-verify:` → `rl:webauthn_auth_verify:`

Magic link:
- `magic-link:email:` → `rl:magic_link:`

**移行の安全性**: Redis 上の rate limit キーは全て TTL 付き（最長 24 時間）で自動的に期限切れになる。キー名変更により一時的にカウンターがリセットされるが、これは rate limit が一瞬緩くなるだけであり、セキュリティ上の問題はない。データ移行は不要。

### Step 4: CSP report リファクタ (`src/app/api/csp-report/route.ts`)

手製の `Map` ベースリミッターを `createRateLimiter({ windowMs: RATE_WINDOW_MS, max: CSP_REPORT_RATE_MAX })` に置換。

**実装パターン**: rate limit チェックは body 読み込みの前（現行と同じ順序）に行う。超過時は `rateLimited()` ではなく 204 を直接返す:

```typescript
const cspLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: CSP_REPORT_RATE_MAX });

async function handlePOST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
  const rl = await cspLimiter.check(`rl:csp_report:${ip}`);
  if (!rl.allowed) return new NextResponse(null, { status: 204 });
  // ... body processing
}
```

**IP 抽出**: CSP report は未認証エンドポイントのため、IP を直接ヘッダーから取得する現行パターンを維持する（`extractClientIp` は `NextRequest` 型を前提としており、CSP report の `Request` 型と互換しない）。

### Step 5: 未保護エンドポイントへの rate limit 追加

| エンドポイント | キー | windowMs | max | 根拠 |
|---|---|---|---|---|
| `GET /api/vault/unlock/data` | `rl:vault_unlock_data:${userId}` | 5min | 20 | 暗号化キー素材の取得頻度制限 |
| `POST /api/vault/admin-reset` | `rl:vault_admin_reset:${userId}` | 15min | 3 | `/api/vault/reset` と同等。userId キーは「同一ユーザーへの操作頻度制限」が目的 |
| `POST /api/api-keys` | `rl:api_key_create:${userId}` | 60min | 5 | 永続トークン発行の制限 |
| `POST /api/tenant/scim-tokens` | `rl:scim_token_create:${tenantId}` | 60min | 5 | テナント単位で管理されるため tenantId キー。`requireTenantPermission()` の戻り値から取得 |
| `POST /api/directory-sync/[id]/run` | `rl:dirsync_run:${id}` | 60s | 1 | 高コスト同期操作の制限。`id` はパスパラメータ |
| `POST /api/passwords/[id]/attachments` | `rl:attachment_upload:${userId}` | 60s | 30 | ストレージ枯渇防止 |
| `POST /api/teams/[teamId]/passwords/[id]/attachments` | `rl:team_attachment_upload:${userId}` | 60s | 30 | 同上 |
| `POST /api/teams/[teamId]/rotate-key` | `rl:team_rotate_key:${teamId}` | 5min | 1 | DB ロック独占防止 |

**認証状態の確認**: 上記エンドポイントは全てセッション認証（proxy middleware または route handler 内の `checkAuth()`）で保護されており、`userId` / `tenantId` / `teamId` / `id` は認証後に必ず取得可能。未認証リクエストは rate limit チェックの前に 401 で拒否される。

**Rate limit 挿入位置**:
- 認証チェックの**後**、メインロジック（DB 操作・ロック取得）の**前**に配置する
- `directory-sync/[id]/run`: 認証 + メンバーチェック後、`runDirectorySync()` 呼び出し前に挿入。`dryRun=true` もカウント対象とする（rate limit の目的はエンドポイント呼び出し頻度の制限であり、操作の種類に依存しない）

**重要**: 全ての `createRateLimiter()` 呼び出しは **module スコープ**（ルートハンドラ関数の外）で行うこと。ハンドラ内で呼ぶとリクエストごとに新しい in-memory Map が生成され、Redis 障害時のフォールバックが完全に無効化される。既存エンドポイントは全てこのパターンに従っている。

### Step 6: Recovery key フローの rate limit 分離

`src/app/api/vault/recovery-key/recover/route.ts` の rate limit を verify と reset で分離:
- verify: `rl:recovery_verify:${userId}` — **5 req / 15 min**（現行と同等の制限を維持。HMAC 検証＋暗号化キー返却のため緩和しない）
- reset: `rl:recovery_reset:${userId}` — 3 req / 15 min
- reset 成功時に `resetLimiter.clear(`rl:recovery_reset:${userId}`)` のみを呼ぶ。`verifyLimiter`（キー: `rl:recovery_verify:${userId}`）は clear **しない**（理由: reset 後もパスフレーズが変わっているだけで recovery key 自体は同一のため、verify の試行回数制限は維持すべき）

### Step 7: Magic link サイレントドロップのログ追加

`src/auth.config.ts` の magic link rate limit 超過時に `getLogger().warn()` を追加。メールアドレスはログに含めない（列挙防止維持）。

```typescript
if (!rl.allowed) {
  getLogger().warn("auth.magic-link.rate-limited");
  return; // silent drop
}
```

### Step 8: テスト修正

**8a. 重複テストファイル解消**

`src/__tests__/api/share-links/verify-access.test.ts` を削除。`src/app/api/share-links/verify-access/route.test.ts` が正式テスト。

**8b. `instrumentation.ts` のテスト追加**

Step 1a で `redisConfigValidated` が消滅する。`rate-limit.test.ts` 内の `validateRedisConfig` describe ブロックは直接呼び出しのテストのみで構成されており、`check()` 経由のテストは存在しないため削除対象はなし（そのまま維持）。

新規テストとして `src/__tests__/instrumentation.test.ts` を作成し、`register()` が `validateRedisConfig()` を呼び出すことを検証する:

```typescript
vi.mock("@/lib/redis", () => ({ validateRedisConfig: vi.fn() }));
vi.mock("@/lib/key-provider", () => ({
  getKeyProvider: vi.fn().mockResolvedValue({ validateKeys: vi.fn() }),
}));

describe("register()", () => {
  it("calls validateRedisConfig when NEXT_RUNTIME is nodejs", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { validateRedisConfig } = await import("@/lib/redis");
    const { register } = await import("@/instrumentation");
    await register();
    expect(validateRedisConfig).toHaveBeenCalled();
  });

  it("does not call validateRedisConfig when NEXT_RUNTIME is edge", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { validateRedisConfig } = await import("@/lib/redis");
    const { register } = await import("@/instrumentation");
    await register();
    expect(validateRedisConfig).not.toHaveBeenCalled();
  });
});
```

**注意**: `validateRedisConfig` 自体の挙動テスト（production で throw するか等）は `src/__tests__/lib/rate-limit.test.ts` の既存 describe ブロックに残す（`check()` 経由でなく直接呼び出しのテストのため影響なし）。

**8c. `Retry-After` ヘッダーのアサーション追加**

**前提**: Step 1c（`rateLimited()` 実装）+ Step 2（全 429 レスポンスの置換）が完了していること。ルート側が `Retry-After` を返すようになった後に適用する。

全ルートの 429 テストで以下を実施:
1. mock の戻り値に `retryAfterMs` を含める: `{ allowed: false, retryAfterMs: 30_000 }`
2. アサーション追加: `expect(res.headers.get("Retry-After")).toBe("30")`

対象ファイル（既存の 429 テストがあるもの全て）:
- `vault/unlock/route.test.ts`
- `share-links/verify-access/route.test.ts`
- `share-links/route.test.ts` (`src/__tests__/api/` 側)
- `share-links/[id]/content/route.test.ts` (`src/__tests__/api/` 側)
- `emergency-access/route.test.ts`
- `emergency-access/[id]/accept/route.test.ts`
- `emergency-access/accept/route.test.ts`
- `maintenance/purge-history/route.test.ts`
- `watchtower/alert/route.test.ts`
- `audit-logs/download/route.test.ts`
- `webauthn/register/options/route.test.ts`
- `sends/route.test.ts` (`src/__tests__/api/` 側)
- `sends/file/route.test.ts` (`src/__tests__/api/` 側)
- `s/[token]/download` (`src/__tests__/api/` 側)
- `scim/v2/Groups/route.test.ts`
- `tenant/breakglass` (`src/__tests__/api/` 側)
- `tenant/tenant-policy` (`src/__tests__/api/` 側)
- `passwords/history-reencrypt` (`src/__tests__/api/` 側)
- `teams/team-history-reencrypt` (`src/__tests__/api/` 側)
- `v1/passwords/route.test.ts`（既存の Retry-After テストを `rateLimited()` パターンに更新）
- `v1/tags/route.test.ts`
- `v1/vault/status/route.test.ts`
- `sessions/sessions-list.test.ts`（rate limit テスト追加が必要な場合）

**8d. インメモリエビクションテスト追加**

`src/__tests__/lib/rate-limit.test.ts` にエビクションテストを追加。`RATE_LIMIT_MAP_MAX_SIZE` は `vi.mock` でモジュール読み込み前にオーバーライドする:

```typescript
vi.mock("@/lib/validations/common.server", () => ({
  RATE_LIMIT_MAP_MAX_SIZE: 3,
}));

describe("in-memory eviction", () => {
  it("evicts expired entries when map is full", async () => { ... });
  it("clears all entries when map is full and none expired", async () => { ... });
});
```

**注意**: このテストは別ファイル（`src/__tests__/lib/rate-limit-eviction.test.ts`）に分離する。`vi.mock` のスコープが他のテストに影響しないようにするため。

**8e. カバレッジ設定追加**

`vitest.config.ts` の `coverage.include` に `"src/lib/rate-limit.ts"` と `"src/lib/redis.ts"` を追加。`coverage.thresholds` にファイル別閾値を追加:

```typescript
"src/lib/rate-limit.ts": { lines: 80 },
```

**8f. verify-access テストの mock パターン修正**

`src/app/api/share-links/verify-access/route.test.ts` の `callCount` クロージャを、`createRateLimiter` 自体の `mockReturnValueOnce` チェーンに置換。2つのリミッターインスタンスを個別に制御できるようにする:

```typescript
const { mockIpCheck, mockTokenCheck } = vi.hoisted(() => ({
  mockIpCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockTokenCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn()
    .mockReturnValueOnce({ check: mockIpCheck, clear: vi.fn() })   // 1st call = ipLimiter
    .mockReturnValueOnce({ check: mockTokenCheck, clear: vi.fn() }), // 2nd call = tokenLimiter
}));
```

**注意**: `vi.mock()` はファイル先頭にホイストされるため、ファクトリー内で参照する変数は必ず `vi.hoisted()` で定義すること。これはプロジェクト全体の確立したパターン。

これにより「IP リミッターは通過するがトークンリミッターでブロック」のシナリオを正確にテスト可能。

**8g. 新規 rate limit エンドポイントの 429 テスト追加**

Step 5 で追加する 8 エンドポイント全てに rate-limit mock と 429 テストを追加する。

**重要**: rate limit を新規追加するルートの既存テストファイルには `@/lib/rate-limit` の mock が存在しない。mock を追加しないと、テスト実行時に実際の `createRateLimiter()` が呼ばれ、Redis 未接続でインメモリリミッターが動作してしまう。以下の 2 点を同時に行うこと:

1. **mock 追加**（ファイルの先頭、他の vi.mock と並べて配置。`vi.hoisted()` 必須）:
```typescript
const { mockRateLimitCheck } = vi.hoisted(() => ({
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
```

2. **429 テストケース追加**:
```typescript
it("returns 429 when rate limited", async () => {
  mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
  const res = await handler(req);
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("30");
});
```

`beforeEach` で `mockRateLimitCheck.mockResolvedValue({ allowed: true })` をリセットし、通常テストケースは rate limit を通過させる。

対象ファイル（route.test.ts と `__tests__` 側の両方に mock を追加すること）:
- `src/app/api/vault/unlock/data/route.test.ts`
- `src/app/api/vault/admin-reset/route.test.ts`
- `src/app/api/api-keys/route.test.ts`
- `src/app/api/tenant/scim-tokens/route.test.ts` + `src/__tests__/api/tenant/scim-tokens.test.ts`
- `src/app/api/directory-sync/[id]/run/route.test.ts`
- `src/app/api/passwords/[id]/attachments/route.test.ts` + `src/__tests__/api/passwords/attachments.test.ts`
- `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.test.ts` + `src/__tests__/api/teams/team-attachments.test.ts`
- `src/app/api/teams/[teamId]/rotate-key/route.test.ts`

**8h. Recovery key 分離テスト追加**

`src/app/api/vault/recovery-key/recover/route.test.ts` に 2 リミッター分離の検証を追加。8f と同様の `mockReturnValueOnce` パターンで verify リミッターと reset リミッターを個別制御:

既存の単一 mock (`createRateLimiter: () => mockRateLimiter`) を 2 リミッターパターンに変更する。既存の 429 テストケースは `mockVerifyCheck` を使うように更新する（現行の verify step で rate limit チェックが走るため）。

```typescript
const { mockVerifyCheck, mockResetCheck, mockResetClear } = vi.hoisted(() => ({
  mockVerifyCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockResetCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockResetClear: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn()
    .mockReturnValueOnce({ check: mockVerifyCheck, clear: vi.fn() })   // verifyLimiter
    .mockReturnValueOnce({ check: mockResetCheck, clear: mockResetClear }), // resetLimiter
}));

// beforeEach でリセット
beforeEach(() => {
  mockVerifyCheck.mockResolvedValue({ allowed: true });
  mockResetCheck.mockResolvedValue({ allowed: true });
});

it("blocks verify independently from reset", async () => { ... });
it("blocks reset independently from verify", async () => { ... });
it("calls resetLimiter.clear() on successful reset", async () => { ... });
```

**8i. CSP report テストの mock 化**

`src/app/api/csp-report/route.test.ts` の rate limit テスト（ループベース）を `createRateLimiter` mock パターンに書き換え:

```typescript
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCspCheck, clear: vi.fn() }),
}));

it("returns 204 (not 429) when rate limited", async () => {
  mockCspCheck.mockResolvedValueOnce({ allowed: false });
  const res = await POST(req);
  expect(res.status).toBe(204); // CSP-specific: 204, not 429
});
```

ループベースのテストは削除する。

**実装順序の注意**: CSP report の `createRateLimiter()` 置換（Step 4）とテストの mock 化（8i）は同一コミットで行うこと。中間状態（ルートは `createRateLimiter` 使用、テストは mock なし）ではテストがフラキーになる。

## Implementation Steps

1. コアライブラリ修正: `validateRedisConfig()` 起動時移動 + `redisConfigValidated` 削除 (Step 1a)
2. コアライブラリ修正: Redis エラーログ追加 (Step 1b)
3. `api-response.ts` に `rateLimited()` プリセット追加 + `errorResponse` 拡張 (Step 1c)
4. 全 429 レスポンスを `rateLimited()` に統一 (Step 2)
5. キープレフィックス統一 (Step 3)
6. CSP report リファクタ (Step 4)
7. 未保護エンドポイントへの rate limit 追加 (Step 5)
8. Recovery key フローの rate limit 分離 (Step 6)
9. Magic link ログ追加 (Step 7)
10. テスト修正 (Step 8a-8i)
11. `npx vitest run` + `npx next build` で検証

## Testing Strategy

- 既存テスト: 全パス必須（リグレッション防止）
- 新規テスト:
  - `rateLimited()` ヘルパーの単体テスト（`Retry-After` ヘッダー有無）
  - `instrumentation.ts` の `validateRedisConfig()` 呼び出しテスト（nodejs / edge 分岐）
  - 8 新規 rate limit エンドポイントの 429 + `Retry-After` テスト（8g）
  - Recovery key 2 リミッター独立性テスト（8h）
  - CSP report mock 化テスト（8i）
  - インメモリエビクションのユニットテスト（別ファイル: `rate-limit-eviction.test.ts`）
- 全既存 429 テストに `retryAfterMs` mock 値 + `Retry-After` ヘッダーアサーション追加（8c）
- `npx next build` での SSR/型チェック必須
- `src/lib/rate-limit.ts` のカバレッジ閾値: lines 80%

## Considerations & Constraints

- **Breaking change なし**: 429 レスポンスに `Retry-After` ヘッダーが追加されるのは additive change であり、既存クライアントに影響しない
- **Fixed-window vs Sliding-window (S4)**: 今回は対象外。コアアルゴリズム変更は別タスクとして扱う（影響範囲が全エンドポイントに及ぶため）
- **`/api/passwords` CRUD への rate limit (一般エンドポイント)**: 今回は対象外。セッション認証済みの通常操作に対する rate limit はユーザー体験への影響が大きいため、別途検討が必要
- **CSP report の 429 vs 204**: CSP report はブラウザが自動送信するものであり、429 を返してもリトライされるだけなので 204 を維持する
- **Redis 障害時の in-memory fallback リスク**: Redis 障害中は rate limit が per-process in-memory に劣化し、実効的な制限値は `max × プロセス数` になる。ブルートフォース感度の高いエンドポイント（`vault/unlock`: 5/5min, `vault/change-passphrase`: 3/15min）については、アカウントロックアウト機構（`src/lib/account-lockout.ts` — 5 回失敗で 24 時間ロック）が補完する。Step 1b のエラーログにより運用者は Redis 障害を検知可能。本 PR では fail-open を維持し、fail-close への変更は別タスクとして扱う
