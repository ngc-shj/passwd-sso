# Phase 6: Dynamic Client Registration (DCR) + Native OAuth Flow

## Context

Phase 1-5 (Machine Identity) は main にマージ済み (v0.4.0 + v0.4.1)。現在の MCP 接続は手動5ステップ（クライアント登録 → PKCE 生成 → ブラウザ認可 → コード交換 → config 編集）が必要。Phase 6 により Claude Code / Claude Desktop が URL だけで接続可能になる:

```json
{ "mcpServers": { "passwd-sso": { "url": "https://sso.example.com/api/mcp" } } }
```

MCP 仕様 (2025-03-26) が RFC 7591 DCR を要求しており、これに準拠する。

---

## Design Decisions

### D1: DCR クライアントのテナント解決

**方式: McpClient.tenantId / createdById を nullable にし、/authorize 時にユーザーセッションからバインド（"claiming"）**

- DCR 登録時点ではユーザー未認証のため tenantId は不明（鶏と卵問題）
- 別モデル (DcrClient) は下流の authorize / token / validate すべてで2テーブル参照が必要になり複雑
- "システムテナント" はドメインモデルを汚染し RLS を複雑化
- nullable が最小変更かつ現実を正確に表現

**不変条件**: `tenantId = null` の DCR クライアントはトークン発行不可。/authorize で必ず claiming が先行。
**claiming の順序保証**: consent ページで claiming (tenantId 設定) → createAuthorizationCode() の順序で実行。createAuthorizationCode() にはユーザーの tenantId を渡す（null を渡さない）。exchangeCodeForToken() に `if (!authCode.tenantId || !authCode.mcpClient.tenantId) return { error: "invalid_client" }` の null ガードを追加。

### D2: DCR クライアントのライフサイクル

- 未 claim の DCR クライアントは 24 時間後に自動期限切れ
- claim 済みは通常の McpClient ライフサイクル（active/inactive、管理者削除可）
- レート制限: IP あたり 20 登録/時間
- グローバル上限: 未 claim DCR クライアント 100 件
- `isDcr` フラグで管理者作成クライアントと区別

### D3: Refresh Token

**方式: 新規 `McpRefreshToken` モデル**

- アクセストークンとはライフサイクルが異なる（長い TTL、ローテーション、親チェーン追跡）
- 分離によりクリーンアップ・失効・監査が簡潔
- アクセストークンテーブルはバリデーションのホットパスなので軽量維持

### D4: Consent UI

**パス: `/[locale]/mcp/authorize`** — Next.js ページ（API route ではない）

- 既存の `/api/mcp/authorize` はこのページにリダイレクト（auto-approve を廃止）
- 既存パターン（emergency access invite、team invite）と同じ Card ベースの中央配置 UI
- Allow/Deny ボタン → POST `/api/mcp/authorize/consent` でコード発行＋リダイレクト

---

## Implementation Steps

### Step 1: Prisma Schema 変更 + Migration

**File: `prisma/schema.prisma`**

McpClient 変更:
- `tenantId`: `String` → `String?` (nullable)
- `createdById`: `String` → `String?` (nullable)
- 追加: `isDcr Boolean @default(false) @map("is_dcr")`
- 追加: `dcrExpiresAt DateTime? @map("dcr_expires_at")`
- tenant / createdBy リレーションを optional に
- `@@unique([tenantId, name])` は PostgreSQL で NULL を distinct 扱いするためそのまま維持可能（unclaimed DCR クライアント同名は許容）
- claiming ロジック内でテナント内 name ユニーク性を明示チェック（`findFirst({ where: { tenantId, name } })`）
- DCR クライアント数はグローバルキャップ (100) で管理。claiming 後は `MAX_MCP_CLIENTS_PER_TENANT` (10) にもカウント

**nullable 化による影響ファイル** (既存コードで `tenantId` / `createdById` を non-null 前提で参照):
- `src/app/api/tenant/mcp-clients/route.ts` — 一覧取得 (tenantId フィルタ)。DCR 未 claim クライアントは除外
- `src/app/api/tenant/mcp-clients/[id]/route.ts` — 詳細・更新・削除。tenantId null チェック追加
- `src/components/settings/mcp-client-card.tsx` — UI 表示。isDcr フラグで表示分岐
- `src/app/api/mcp/authorize/route.ts` — 既存テナント境界チェックを DCR claiming 対応に修正
- `src/lib/mcp/oauth-server.ts` — `exchangeCodeForToken` のテナント比較ロジック修正
- `src/app/api/mcp/token/route.ts` — client lookup で tenantId null 許容
- `src/app/api/tenant/mcp-clients/route.ts` (POST) — redirect_uri バリデーションに `http://127.0.0.1:PORT/` も許可 (既存は `localhost` のみ)

新規 McpRefreshToken モデル:
```prisma
model McpRefreshToken {
  id               String    @id @default(uuid(4)) @db.Uuid
  tokenHash        String    @unique @map("token_hash") @db.VarChar(64)
  familyId         String    @map("family_id") @db.Uuid
  accessTokenId    String    @map("access_token_id") @db.Uuid
  clientId         String    @map("client_id") @db.Uuid
  tenantId         String    @map("tenant_id") @db.Uuid
  userId           String?   @map("user_id") @db.Uuid
  serviceAccountId String?   @map("service_account_id") @db.Uuid
  scope            String    @db.VarChar(1024)
  expiresAt        DateTime  @map("expires_at")
  revokedAt        DateTime? @map("revoked_at")
  rotatedAt        DateTime? @map("rotated_at")
  replacedByHash   String?   @map("replaced_by_hash") @db.VarChar(64)
  createdAt        DateTime  @default(now()) @map("created_at")

  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  mcpClient McpClient      @relation(fields: [clientId], references: [id], onDelete: Cascade)
  accessToken McpAccessToken @relation(fields: [accessTokenId], references: [id], onDelete: Cascade)

  @@index([familyId, revokedAt])
  @@index([tenantId])
  @@index([expiresAt])
  @@map("mcp_refresh_tokens")
}
```

- `familyId`: 同一ローテーションチェーンの全トークンが共有する UUID。リプレイ検出時に `WHERE familyId = ? AND revokedAt IS NULL` で一括失効 (O(1))
- `onDelete: Cascade` on mcpClient: クライアント削除時にリフレッシュトークンも削除
- アクセストークン失効時: 同トランザクション内で対応する refresh token も失効

McpClient / McpAccessToken / Tenant にリレーション追加。

### Step 2: IPv6 /64 プレフィックスベース rate limit キー関数

**File: `src/lib/ip-access.ts`**

新規ユーティリティ `rateLimitKeyFromIp(ip: string): string` を追加:
- IPv6: 先頭4グループ (`::/64`) に正規化してキー生成
- IPv4: そのまま返す

```typescript
export function rateLimitKeyFromIp(ip: string): string {
  if (ip.includes(":")) {
    const full = expandIpv6(ip);
    return full.split(":").slice(0, 4).join(":") + "::/64";
  }
  return ip;
}
```

**既存 IP ベース rate limit キーの一括リファクタ** — 以下のファイルで `${ip}` → `${rateLimitKeyFromIp(ip)}` に変更:
- `src/app/api/auth/passkey/options/route.ts` — `rl:webauthn_signin_opts`
- `src/app/api/auth/passkey/options/email/route.ts` — `rl:webauthn_email_signin_opts`
- `src/app/api/auth/passkey/verify/route.ts` — `rl:webauthn_signin_verify`
- `src/app/api/share-links/[id]/content/route.ts` — `rl:share_content`
- `src/app/api/share-links/verify-access/route.ts` — `rl:share_verify_ip`
- `src/app/s/[token]/download/route.ts` — `rl:send_download`
- `src/app/api/csp-report/route.ts` — `rl:csp_report`

**File: `src/lib/ip-access.test.ts`** — `rateLimitKeyFromIp` のテスト追加 (IPv4 passthrough, IPv6 /64 正規化, IPv4-mapped IPv6)

### Step 3: scope-parser.ts に resource/action allowlist 追加 (defense-in-depth)

**File: `src/lib/scope-parser.ts`**

レビュー指摘への対応。現在 `parseScope()` は任意の resource:action を受け入れるが、DCR 導入により外部入力経路が増えるため、既知の resource:action ペアの allowlist を追加する。

```typescript
// SA + MCP の全 resource:action ペアを統合した allowlist
const VALID_RESOURCE_ACTIONS = new Set([
  // SA scopes (from service-account.ts)
  "passwords:read", "passwords:write", "passwords:list",
  "tags:read", "folders:read", "folders:write",
  "vault:status",
  "access-request:create",
  // MCP scopes (from mcp.ts)
  "credentials:decrypt",
  // team-scoped は resource が "team:<uuid>:passwords" 等になるため別処理
]);

// team-scoped の resource:action 部分の allowlist
const VALID_TEAM_RESOURCE_ACTIONS = new Set([
  "passwords:read", "passwords:write",
  "credentials:read",
]);
```

`parseScope()` のパース後に allowlist チェック:
- 通常スコープ: `${resource}:${action}` が `VALID_RESOURCE_ACTIONS` に含まれなければ `null`
- team スコープ: team:<uuid> 後の resource:action が `VALID_TEAM_RESOURCE_ACTIONS` に含まれなければ `null`

**File: `src/lib/scope-parser.test.ts`** — allowlist 外のスコープが `null` になるテスト追加

### Step 4: Constants 追加

**File: `src/lib/constants/mcp.ts`**

```typescript
export const MCP_REFRESH_TOKEN_PREFIX = "mcpr_";
export const MCP_REFRESH_TOKEN_EXPIRY_SEC = 604800; // 7 days
export const MCP_DCR_UNCLAIMED_EXPIRY_SEC = 86400;  // 24 hours
export const MAX_UNCLAIMED_DCR_CLIENTS = 100;
export const DCR_RATE_LIMIT_WINDOW_MS = 3_600_000;  // 1 hour
export const DCR_RATE_LIMIT_MAX = 20;                // per IP
```

### Step 5: DCR Registration Endpoint (RFC 7591)

**New: `src/app/api/mcp/register/route.ts`**

POST /api/mcp/register:
1. IP レート制限 — 既存の `createRateLimiter` (`src/lib/rate-limit.ts`) を再利用 (20/hour)。IPv6 は `/64` プレフィックスでキー生成（サブネット単位）、IPv4 は `/32`（個別アドレス）
2. Zod バリデーション:
   - `client_name`: required, max 100
   - `redirect_uris`: required, `https://` or `http://127.0.0.1:PORT/...` (ポート番号必須、`localhost` 拒否 — RFC 8252 §7.3)
   - `grant_types`: optional, must include `authorization_code`
   - `response_types`: optional, must include `code`
   - `token_endpoint_auth_method`: optional, default `client_secret_post`
3. 未 claim DCR クライアント数をチェック (MAX_UNCLAIMED_DCR_CLIENTS) — `$transaction` 内で count → create をシリアライズ (TOCTOU 防止)
4. clientId (`mcpc_` + 16 hex) + clientSecret (32 bytes base64url) 生成
5. McpClient 作成 (tenantId=null, createdById=null, isDcr=true, dcrExpiresAt=now+24h)
6. RFC 7591 レスポンス (201)

認証不要（RFC 7591 準拠）。レート制限 + グローバル上限で悪用防止。

### Step 6: Discovery Endpoint 更新

**File: `src/app/api/mcp/.well-known/oauth-authorization-server/route.ts`**

追加:
- `registration_endpoint`: `/api/mcp/register`
- `grant_types_supported`: `["authorization_code", "refresh_token"]` に更新
- `scopes_supported`: MCP_SCOPES 配列

### Step 7: Consent UI ページ

**New files:**
- `src/app/[locale]/mcp/authorize/page.tsx` — Server Component
- `src/app/[locale]/mcp/authorize/consent-form.tsx` — Client Component (Allow/Deny)
- `src/app/[locale]/mcp/layout.tsx` — 最小レイアウト

**i18n:**
- `messages/en.json` / `messages/ja.json` に `McpConsent` セクション追加

フロー:
1. OAuth query params 受信
2. `auth()` でセッション確認 → 未認証なら login リダイレクト
3. McpClient 検索
4. DCR クライアント (isDcr=true, tenantId=null) → claiming (tenantId + createdById 設定、dcrExpiresAt クリア、テナント内 name ユニーク性チェック)
5. redirect_uri / scope バリデーション。**`grantedScopes.length === 0` → `invalid_scope` エラー** (空スコープガード)
6. クライアント名 + スコープ説明を Card UI で表示
7. Allow → form POST to `/api/mcp/authorize/consent` (`state` を hidden input として引き継ぎ)
8. Deny → redirect_uri に `error=access_denied&state={state}` リダイレクト

UI パターン: 既存の emergency access invite / team invite ページと同じ Card + Button 構成。

### Step 8: Authorization Endpoint リファクタ

**File: `src/app/api/mcp/authorize/route.ts`**

変更: auto-approve を削除し、consent ページへリダイレクト:
1. セッション確認（未認証 → login リダイレクト、既存通り）
2. 基本パラメータバリデーション
3. `/{locale}/mcp/authorize?{all_oauth_params}` にリダイレクト

**SA フローへの影響**: SA は `/api/mcp/authorize` を直接呼ばず、管理者が手動でクライアント登録＋トークン発行を行うため変更なし（DCR は人間ユーザーの Claude Code/Desktop 接続用）。既存テストの `/api/mcp/authorize` 呼び出しはリダイレクトレスポンス (302) に変わるためテスト更新が必要。

**New: `src/app/api/mcp/authorize/consent/route.ts`**

POST /api/mcp/authorize/consent — consent form の送信先:
1. セッション確認
2. OAuth パラメータバリデーション（既存 authorize ロジック移植）+ `state` パラメータの存在確認
3. McpClient 検索 + テナント境界チェック
4. DCR クライアント: claimed 済み + テナント一致を確認
5. `grantedScopes.length === 0` → `invalid_scope` エラー (空スコープガード)
6. `createAuthorizationCode()` で認可コード発行（tenantId はユーザーセッションから取得、null を渡さない）
7. redirect_uri に code + state でリダイレクト
8. 監査ログ (MCP_CONSENT_GRANT)

### Step 9: Refresh Token サポート

**File: `src/lib/mcp/oauth-server.ts`**

新規関数:

`createRefreshToken(params)`:
- `mcpr_` プレフィックス + 32 bytes random 生成
- ハッシュして McpRefreshToken に保存
- 7 日間有効

`exchangeRefreshToken(params)`:
- ハッシュでリフレッシュトークン検索
- バリデーション: 未期限切れ、未失効、未ローテーション
- **リプレイ検出**: ローテーション済みトークン再利用時 → `familyId` で同一チェーン全体を一括失効 (`WHERE familyId = ? AND revokedAt IS NULL`)。対応するアクセストークンも失効
- トランザクション内で:
  - 旧トークンに rotatedAt 設定 + replacedByHash 記録
  - 新リフレッシュトークン発行 (同じ familyId を継承)
  - 新アクセストークン発行
  - 両方返却

### Step 10: Token Endpoint 拡張

**File: `src/app/api/mcp/token/route.ts`**

- `grant_type=refresh_token` サポート追加
- `authorization_code` 交換成功時にリフレッシュトークンも発行 (新規 familyId 生成)
- レスポンスに `refresh_token` フィールド追加
- **Rate limiter キー**: IP ベースのプライマリ limiter を追加 (`rl:mcp:token:ip:${ip}`)。IPv6 は `/64` プレフィックスでキー生成。既存の `client_id` ベースはセカンダリとして併用（ユーザー制御値による DoS 防止）
- スコープ区切り文字: リクエストはスペース区切り (RFC 6749)、内部保存はカンマ区切り（既存パターン踏襲）

### Step 11: Audit Constants

**File: `src/lib/constants/audit.ts`**

追加:
- `MCP_CLIENT_DCR_REGISTER` — DCR 登録時
- `MCP_CLIENT_DCR_CLAIM` — テナントバインド時
- `MCP_CONSENT_GRANT` — ユーザー承認時
- `MCP_CONSENT_DENY` — ユーザー拒否時
- `MCP_REFRESH_TOKEN_ROTATE` — ローテーション時
- `MCP_REFRESH_TOKEN_REPLAY` — リプレイ検出時（セキュリティイベント）

**Downstream invariants** (全て更新必須):
- `AUDIT_ACTION` オブジェクトに新アクション追加
- `AUDIT_ACTION_VALUES` 配列に追加 (audit.test.ts の alignment テストが検証)
- `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MCP_CLIENT]` に追加
- `messages/en.json` の AuditLog セクションに i18n ラベル追加
- `messages/ja.json` の AuditLog セクションに i18n ラベル追加
- `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` への追加要否を判断（DCR_REGISTER は webhook 不要、CONSENT_GRANT/DENY は有用）

**監査イベント dispatch 箇所** (各エンドポイントで `createAuditLog()` を呼ぶ):
- `POST /api/mcp/register` → `MCP_CLIENT_DCR_REGISTER` (IP, client_name)
- consent ページの claiming 処理 → `MCP_CLIENT_DCR_CLAIM` (clientId, tenantId)
- `POST /api/mcp/authorize/consent` (Allow) → `MCP_CONSENT_GRANT` (clientId, scopes)
- consent ページの Deny → `MCP_CONSENT_DENY` (clientId)
- `exchangeRefreshToken()` 成功時 → `MCP_REFRESH_TOKEN_ROTATE`
- `exchangeRefreshToken()` リプレイ検出時 → `MCP_REFRESH_TOKEN_REPLAY`

### Step 12: DCR クリーンアップ

**New: `src/app/api/maintenance/dcr-cleanup/route.ts`**

- `ADMIN_API_TOKEN` ベアラー認証（既存の purge-history / rotate-master-key と同パターン）
- `McpClient` where `isDcr=true AND tenantId IS NULL AND dcrExpiresAt < now()` を削除
- DCR 登録エンドポイント内でもピギーバック実行（10 回に 1 回）

### Step 13: RLS バイパス allowlist 更新

**File: `scripts/check-bypass-rls.mjs`**

`ALLOWED_USAGE` に Phase 6 の新ファイルを追加:
- `src/app/api/mcp/register/route.ts` → `["mcpClient"]`
- `src/app/api/mcp/authorize/consent/route.ts` → `["mcpClient", "user"]`
- `src/app/api/maintenance/dcr-cleanup/route.ts` → `["mcpClient"]`

既存エントリの更新:
- `src/lib/mcp/oauth-server.ts` → `["mcpAuthorizationCode", "mcpAccessToken", "mcpRefreshToken"]` (mcpRefreshToken 追加)

### Step 14: Tests

**New:**
- `src/app/api/mcp/register/route.test.ts` — DCR (正常登録、レート制限、バリデーション、グローバル上限)
  - グローバルキャップ: `prisma.mcpClient.count({})` (テナントフィルタなし) を `MAX_UNCLAIMED_DCR_CLIENTS` でスタブ
- `src/app/api/mcp/authorize/consent/route.test.ts` — Consent POST
  - Allow → code + state 付きリダイレクト検証
  - **Deny → `error=access_denied` + 元の `state` 付きリダイレクト検証**
  - 空スコープ → `invalid_scope` エラー
- `src/__tests__/lib/mcp/refresh-token.test.ts` — リフレッシュトークン交換、ローテーション、リプレイ検出
  - **チェーン失効テスト必須**: (1) 使用済みトークン再利用 → `invalid_grant` + familyId 全トークン失効検証、(2) 正常ローテーション後の旧トークン再利用 → 新トークンも失効

**Update:**
- `src/app/api/mcp/token/route.test.ts` — refresh_token grant_type 追加。`VALID_REFRESH_BODY` を独立定数として定義（既存 `VALID_BODY` と混用しない）
- `src/__tests__/integration/mcp-oauth-flow.test.ts` (Scenario 7) — discovery endpoint に `registration_endpoint`、更新後の `grant_types_supported` 検証追加
- `src/lib/scope-parser.test.ts` — allowlist 外のスコープが `null` になるテスト追加（テスト配置は scope-parser.test.ts に統一）

**vitest.config.ts**: `coverage.include` に `"src/lib/mcp/**/*.ts"` を追加

### Step 15: UI 一貫性改修 (Webhook/API Key パターンに統一)

既存の Webhook / API Key カードは「Active 先頭 + Inactive 折りたたみ」パターンだが、MCP Client / Service Account はソートなし・分離なしで不一致。Phase 6 で MCP Client に isDcr バッジ等を追加するタイミングで統一する。

**File: `src/components/settings/mcp-client-card.tsx`**
- Active クライアントを先頭表示、Inactive を折りたたみセクションに分離
- 空状態を多段化: "No MCP clients" / "No active MCP clients"
- isDcr バッジ追加（claim 済み DCR クライアント識別）
- DCR クライアントの clientId / redirectUris は編集不可

**File: `src/components/settings/service-account-card.tsx`**
- Active アカウントを先頭表示、Inactive を折りたたみセクションに分離
- 空状態を多段化: "No service accounts" / "No active service accounts"

**Access Request (`access-request-card.tsx`)** — 現行のステータスドロップダウンフィルタで適切（ステータス4種のため別パターンが妥当）。変更なし。

### Step 16: Documentation

**File: `docs/architecture/machine-identity.md`**
- DCR フロー図 + Native OAuth 接続ガイド追加
- Refresh token rotation フロー（familyId ベース）
- Consent UI フロー

**File: `docs/operations/audit-log-reference.md`**
- Phase 1-5 で追加済みだが未記載の MCP/SA 監査アクション追加（MCP_CLIENT_CREATE/UPDATE/DELETE, DELEGATION_READ 等）
- Phase 6 の新アクション追加（MCP_CLIENT_DCR_REGISTER, MCP_CLIENT_DCR_CLAIM, MCP_CONSENT_GRANT/DENY, MCP_REFRESH_TOKEN_ROTATE/REPLAY）
- 総数カウント更新（現在 "94 total" → 更新後の数に変更）

**File: `docs/security/threat-model.md`**
- D1 "Distributed attacks from many IPs" の残存リスクに IPv6 /64 プレフィックスベース rate limiting 対策を追記
- DCR 悪用の脅威シナリオ追加（rate limit + global cap + 24h expiry による緩和）

**File: `CLAUDE.md`**
- エンドポイントテーブルに `/api/mcp/register`, `/api/mcp/authorize/consent`, `/api/maintenance/dcr-cleanup` 追加
- consent ページ (`/[locale]/mcp/authorize`) 追記
- refresh token フロー追記

---

## Security Considerations

| 脅威 | 対策 |
|------|------|
| 不正スコープ注入 | scope-parser.ts に resource/action allowlist (defense-in-depth)。DCR は MCP_SCOPES で直接制限 |
| DCR 悪用 (大量登録) | IP レート制限 20/hour + 未 claim 上限 100 件 + 24h 自動期限切れ |
| リダイレクト URI 改ざん | DCR は `127.0.0.1:PORT` (ポート必須) or HTTPS のみ。`localhost` 拒否 (RFC 8252 §7.3)。完全一致必須 |
| リフレッシュトークン窃取 | familyId ベースのローテーション + リプレイ検出 → familyId 単位で一括失効 |
| Consent CSRF | セッション Cookie (SameSite) + state hidden input + OAuth パラメータ一致検証 |
| 空スコープによるバイパス | `grantedScopes.length === 0` → `invalid_scope` エラー |
| Token endpoint DoS | IP ベースプライマリ limiter + client_id セカンダリ limiter |
| IPv6 rate limit バイパス | IPv6 は `/64` プレフィックスでレート制限キー生成（サブネット内ローテーション防止） |
| DCR クライアントの cross-tenant 乗っ取り | claiming は 1 回限り。claim 済みクライアントのテナント変更不可 |
| 未 claim クライアント経由の RLS バイパス | tenantId=null のクライアントは withBypassRls で登録・claiming 時のみアクセス |

---

## Verification

1. `npx prisma migrate dev` — マイグレーション成功
2. `npx vitest run` — 全テスト pass
3. `npx next build` — ビルド成功
4. E2E 手動テスト:
   - `curl POST /api/mcp/register` → client_id + client_secret 取得
   - `GET /.well-known/oauth-authorization-server` → registration_endpoint 含む
   - ブラウザで `/api/mcp/authorize?...` → consent 画面表示
   - Allow クリック → redirect_uri に code 付きリダイレクト
   - `POST /api/mcp/token` (authorization_code) → access_token + refresh_token 取得
   - `POST /api/mcp/token` (refresh_token) → 新 access_token + 新 refresh_token
   - 旧 refresh_token 再利用 → エラー + チェーン失効確認

---

## Critical Files

| File | Action |
|------|--------|
| `prisma/schema.prisma` | McpClient nullable化 + McpRefreshToken 追加 |
| `src/lib/ip-access.ts` | `rateLimitKeyFromIp()` 追加 + 既存7箇所の IP rate limit キー一括リファクタ |
| `src/lib/scope-parser.ts` | resource/action allowlist 追加 (defense-in-depth) |
| `src/lib/constants/mcp.ts` | DCR / refresh token 定数追加 |
| `src/lib/constants/audit.ts` | 監査アクション追加 |
| `src/lib/mcp/oauth-server.ts` | refresh token 関数 + DCR claim ロジック |
| `src/app/api/mcp/register/route.ts` | **新規** DCR エンドポイント |
| `src/app/api/mcp/authorize/route.ts` | consent ページへリダイレクトに変更 |
| `src/app/api/mcp/authorize/consent/route.ts` | **新規** consent 処理 |
| `src/app/[locale]/mcp/authorize/page.tsx` | **新規** consent UI |
| `src/app/[locale]/mcp/authorize/consent-form.tsx` | **新規** consent フォーム |
| `src/components/settings/mcp-client-card.tsx` | isDcr バッジ + Active/Inactive 分離 (Webhook パターン統一) |
| `src/components/settings/service-account-card.tsx` | Active/Inactive 分離 (Webhook パターン統一) |
| `src/app/api/mcp/token/route.ts` | refresh_token grant 追加 |
| `src/app/api/mcp/.well-known/oauth-authorization-server/route.ts` | registration_endpoint 追加 |
| `src/app/api/tenant/mcp-clients/route.ts` | redirect_uri バリデーション更新 (127.0.0.1:PORT 許可) |
| `vitest.config.ts` | coverage.include に src/lib/mcp 追加 |
| `docs/architecture/machine-identity.md` | DCR フロー + refresh token + consent UI |
| `docs/operations/audit-log-reference.md` | MCP/SA 監査アクション追記 (Phase 1-5 未記載分 + Phase 6 新規) |
| `docs/security/threat-model.md` | IPv6 /64 rate limit + DCR 脅威シナリオ追記 |
| `scripts/check-bypass-rls.mjs` | DCR 新ファイル + mcpRefreshToken を allowlist に追加 |
