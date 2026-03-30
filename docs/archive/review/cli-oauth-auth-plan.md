# Plan: cli-oauth-auth

CLI 認証を手動トークン貼り付けから OAuth 2.1 Authorization Code + PKCE に移行し、deprecated な keytar を除去する。

## Context

現在の CLI `login` は Web UI でトークンをコピーして貼り付ける方式。トークンは ExtensionToken（15分寿命）で、keytar（deprecated、prebuild-install 警告発生）または plaintext ファイルに保存される。一方、MCP 向けに OAuth 2.1 (DCR + PKCE + refresh token rotation) が完全実装済み。CLI もこの OAuth 基盤を再利用し、セキュアで自動更新可能な認証に移行する。

## Objective

1. CLI login を OAuth 2.1 Authorization Code + PKCE フローに移行
2. MCP OAuth エンドポイントを CLI から再利用（新規エンドポイント不要）
3. keytar 依存を完全除去
4. ヘッドレス/CI 環境向けに手動トークン貼り付けをフォールバックとして維持

## Requirements

### Functional
- `passwd-sso login` でブラウザが開き、OAuth consent → コールバックで認証完了
- アクセストークン (1hr) + リフレッシュトークン (7d) を安全に保存
- リフレッシュトークンによる自動更新（REPL セッション中も途切れない）
- `passwd-sso login --token` で従来の手動トークン貼り付けを維持
- ヘッドレス環境では URL を表示してユーザーに手動でブラウザを開かせる

### Non-functional
- keytar 除去により prebuild-install 警告解消、ネイティブビルド不要に
- 新規ランタイム依存なし（Node.js 組み込み API のみ）
- 既存ユーザーの移行: `passwd-sso login` を再実行するだけ

## Technical Approach

### CLI は MCP OAuth クライアントとして動作

CLI は `mcp_` トークンを使う。サーバーから見れば CLI は「もう一つの public OAuth client」。

- DCR で `client_name: "passwd-sso-cli"` として自動登録（`token_endpoint_auth_method: "none"`）
- 同名 DCR re-registration で古い client を自動置換（実装済み）
- Loopback redirect: `http://127.0.0.1:<ephemeral-port>/callback`

### サーバー側拡張: `mcp_` トークンを REST API で受け入れる

**重要な発見**: 現在 `auth-or-token.ts` は `mcp_` prefix をディスパッチしない。`mcp_` トークンは extension token validator にフォールスルーし、拒否される。

必要な変更:
1. `MCP_SCOPES` に CLI 必須スコープを追加: `vault:unlock-data`, `passwords:read`, `passwords:write`
2. `src/lib/scope-parser.ts` の `VALID_RESOURCE_ACTIONS` に `vault:unlock-data` を追加
3. `auth-or-token.ts` に `mcp_` prefix のディスパッチ分岐を追加
4. scope チェックで MCP トークンのスコープを検証（MCP_SCOPE に追加するスコープ値は extension token スコープと同一文字列を使用）
5. `src/lib/audit.ts` の `resolveActorType()` に `mcp_token` ケース追加（→ `MCP_AGENT`）
6. `src/lib/check-auth.ts` の `enforceAccessRestriction` で `mcp_token` を `service_account` と同様に除外（`userId: null` の場合への対処）

**設計方針**: CLI OAuth では consent フローでログイン済みユーザーが認可するため、`McpTokenData.userId` は常に non-null。ただし SA OAuth のケースを安全にするため、`mcp_token` + `userId: null` は `service_account` と同等の制限を適用する。

### トークン保存: 暗号化ファイルのみ

keytar を除去し、`$XDG_DATA_HOME/passwd-sso/credentials` に JSON 形式で保存（mode 0o600）:
```json
{ "accessToken": "mcp_...", "refreshToken": "mcpr_...", "clientId": "mcpc_...", "expiresAt": "ISO8601" }
```

## Implementation Steps

### Phase A: サーバー側拡張

**Step 1**: `src/lib/constants/mcp.ts` — CLI 必須スコープ追加
- `MCP_SCOPE` に `VAULT_UNLOCK_DATA`, `PASSWORDS_READ`, `PASSWORDS_WRITE` を追加
- `MCP_SCOPES` 配列に反映
- スコープ値は extension token スコープと同一文字列を使用（`"vault:unlock-data"`, `"passwords:read"`, `"passwords:write"`）

**Step 1b**: `src/lib/scope-parser.ts` — `VALID_RESOURCE_ACTIONS` 更新
- `vault:unlock-data` を `VALID_RESOURCE_ACTIONS` に追加（`parseScope()` が null を返さないようにする）

**Step 2**: `src/lib/auth-or-token.ts` — `mcp_` トークンディスパッチ
- `MCP_TOKEN_PREFIX` を import し `KNOWN_PREFIXES` に追加
- `mcp_` prefix 検出時に `validateMcpToken()` を呼び出す
- `AuthResult` union に `mcp_token` type を追加（`userId: string | null`, `serviceAccountId: string | null`, `scopes: string[]`）
- scope チェック用の `hasMcpScope()` 関数を追加

**Step 3**: `src/lib/check-auth.ts` — `mcp_token` type を受け入れ
- `allowTokens` パスで `mcp_token` を許可
- `enforceAccessRestriction` 分岐: `mcp_token` + `userId: null` を `service_account` と同様に除外

**Step 3a**: `authOrToken` 直接呼び出しハンドラの guard 追加
- `src/app/api/passwords/route.ts` 等、`checkAuth` を使わず `authOrToken` を直接呼ぶハンドラで、`mcp_token` + `userId: null` を `service_account` と同等に除外する guard を追加
- 実装前に `authOrToken` を直接呼ぶ全ハンドラを grep で洗い出し、漏れなく対処
- **guard 条件式（実装時の参考）**: 既存の `service_account` 除外に `mcp_token` + `userId: null` を追加:
  ```typescript
  if (!authResult || authResult.type === "service_account" ||
      (authResult.type === "mcp_token" && !authResult.userId)) {
    return unauthorized();
  }
  // ここ以降 authResult.userId は string（TypeScript narrowing で保証）
  ```

**Step 3b**: `src/lib/audit.ts` — `resolveActorType()` 更新
- `mcp_token` ケースを追加 → `ActorType.MCP_AGENT` を返す
- `default` フォールスルーを削除し、TypeScript exhaustive check（`never` assertion）を導入して将来の型追加漏れを防止

**Step 4**: 関連テスト（新規作成 + 更新）
- `src/__tests__/lib/auth-or-token.test.ts`（新規）:
  - `mcp_` prefix ディスパッチ
  - scope チェック
  - `sa_`/`api_`/ext との共存
  - `mcp_token` + `userId: null` ケースで `check-auth.ts` の `enforceAccessRestriction` がスキップされること
  - `KNOWN_PREFIXES` に `MCP_TOKEN_PREFIX` が含まれることの検証（S-9 実装 gate）
- `src/lib/scope-parser.test.ts`: `vault:unlock-data` のパース検証
- `src/__tests__/audit.test.ts`: `resolveActorType` describe に `mcp_token` → `MCP_AGENT` テストケースを追加

### Phase B: CLI OAuth ライブラリ（新規ファイル）

**Step 5**: `cli/src/lib/oauth.ts` — PKCE + DCR + コールバックサーバー
- `generateCodeVerifier()`: `crypto.randomBytes(32).toString("base64url")`
- `computeCodeChallenge(verifier)`: SHA-256 → base64url
- `findFreePort()`: `http.Server` を port 0 で bind → OS 割当ポート取得
- `startCallbackServer(port)`: `127.0.0.1:port` で GET `/callback` を待機、code + state を返す、60 秒タイムアウト
  - **state 検証（CSRF 対策）**: コールバック受信時に query `state` と生成値を constant-time 比較、不一致は即時エラー（RFC 9700 §2.1.2）
- `registerClient(serverUrl, redirectUri)`: DCR POST
- `openBrowser(url)`: platform 別 (`open`/`xdg-open`/`start`)、ヘッドレス時は URL 表示
- `runOAuthFlow(serverUrl)`: 全体オーケストレーション
  - state = `crypto.randomBytes(16).toString("hex")` を生成 → 認可 URL に含める → callback 検証
  - `serverUrl` の HTTPS スキーム強制（`http://localhost` / `http://127.0.0.1` のみ開発例外として許可）
- **CLI 要求スコープ**: `credentials:list credentials:use vault:status vault:unlock-data passwords:read passwords:write`

### Phase C: CLI config 変更

**Step 6**: `cli/src/lib/config.ts` — keytar 除去 + 新 credential スキーマ
- `tryKeytar()`, `KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` を削除
- `PSSO_NO_KEYCHAIN` チェックを削除
- `saveToken()` → `saveCredentials(creds: StoredCredentials)`
- `loadToken()` → `loadCredentials(): StoredCredentials | null`
- `deleteToken()` → `deleteCredentials()`
- レガシー形式（非 JSON 文字列）検出 → null 返却 + 再ログイン促し
- `CliConfig` から `tokenExpiresAt` を削除

**Step 7**: `cli/package.json` — keytar 除去
- `optionalDependencies` から `keytar` を削除

### Phase D: CLI コマンド更新

**Step 8**: `cli/src/commands/login.ts` — OAuth フロー統合
- `--token` オプション追加
- デフォルト: `runOAuthFlow()` → `saveCredentials()` → `setTokenCache()`
- `--token`: 従来の手動貼り付け（credentials JSON にラップ、refresh なし注記）

**Step 9**: `cli/src/lib/api-client.ts` — refresh エンドポイント変更
- `cachedRefreshToken`, `cachedClientId` フィールド追加
- `getToken()`: `loadCredentials()` から全フィールドを読み込み
- `refreshToken()`: `/api/mcp/token` (grant_type=refresh_token) を呼び出し
  - `cachedRefreshToken` が null/空の場合は early return（`--token` パスのフォールバック）
- `clearTokenCache()`: refresh token/clientId もクリア
- `BG_REFRESH_INTERVAL_MS`: 10 分 → 動的（有効期限の 5 分前）
- `config.tokenExpiresAt` への書き込みを削除（expiry は credentials ファイルに移動済み）

**Step 10**: `cli/src/index.ts` — login コマンド定義更新
- `--token` オプションと `--server` オプションを追加

### Phase E: テスト

**Step 11**: テスト更新・追加
- `cli/src/__tests__/unit/oauth.test.ts`（新規）:
  - PKCE: RFC 7636 Appendix B の既知テストベクトルで S256 検証
  - DCR: fetch mock、リクエスト形式検証
  - コールバックサーバー: `vi.useFakeTimers()` で 60 秒タイムアウトの reject 検証
  - state 検証: 一致・不一致・state パラメータ欠如ケース → すべて reject
- `cli/src/__tests__/unit/config.test.ts`:
  - `saveCredentials`/`loadCredentials` JSON round-trip（全フィールド存在と値検証）
  - `deleteCredentials()` のテスト（ファイル削除検証）
  - レガシー形式（非 JSON）→ null 返却検証
  - credentials ファイルの permissions 0o600 検証
- `cli/src/__tests__/unit/api-client.test.ts`:
  - mock を `loadCredentials`/`saveCredentials` に完全置換
  - refresh mock を OAuth `/api/mcp/token` 形式（`{ access_token, refresh_token, expires_in }`）に更新
  - refresh 後の `saveCredentials` アサーション: `accessToken`（新値）、`refreshToken`（rotation 後の新値）、`expiresAt`（計算値）、`clientId`（維持）の 4 フィールド全検証
  - `cachedRefreshToken` null 時の refresh skip テスト

## Testing Strategy

### Unit Tests (vitest)
- PKCE: verifier → challenge の S256 検証（既知ベクトル）
- DCR: fetch mock、リクエスト形式検証
- Credentials: JSON round-trip、レガシー形式検出、ファイルパーミッション
- Token refresh: `/api/mcp/token` mock、grant_type=refresh_token

### Manual Integration Test
1. `passwd-sso login` → ブラウザ起動 → consent → コールバック → 認証完了
2. `passwd-sso status` → MCP トークンで接続成功
3. `passwd-sso unlock` → vault データ取得成功
4. REPL で 55 分以上待機 → background refresh 発火確認
5. `passwd-sso login --token` → 手動貼り付けフロー動作確認
6. SSH セッション（DISPLAY なし）→ URL 表示 → 手動ブラウザ確認

### Server-side Tests
- `auth-or-token` テスト: `mcp_` prefix ディスパッチ
- scope チェック: 新スコープの検証

## Considerations & Constraints

- **バージョン**: feature ブランチでは変更しない（release-please が管理）
- **Extension token**: 既存エンドポイントは削除しない（ブラウザ拡張が使用中）
- **DCR client cap**: テナント 10 件制限。同名 re-registration で蓄積しないが、複数マシンからの login は各々 client を作成。将来 `logout` コマンドで revoke 可能に
- **`PSSO_NO_KEYCHAIN`**: no-op になる。既存スクリプトでエラーにはならない
- **DB マイグレーション**: 不要（MCP テーブルは既存）
- **セキュリティトレードオフ（credentials ファイル）**: keytar 除去により OS キーチェーン保存がなくなり、refresh token（7 日有効）が plaintext ファイルに保存される。ただし keytar 時代も同一 UID からは読み取り可能であり、実質的なリスク差は小さい。O_NOFOLLOW + 0o600 で symlink 攻撃・他ユーザーアクセスを防止
- **Out of scope**: `logout` コマンド（将来の PR）、Device Authorization Grant (RFC 8628)

## User Operation Scenarios

### Scenario 1: 通常ログイン（デスクトップ）
```
$ passwd-sso login
Server URL [https://vault.example.com]: ↵
Opening browser for authentication...
✔ Logged in to https://vault.example.com
```

### Scenario 2: ヘッドレス環境（SSH）
```
$ passwd-sso login
Server URL [https://vault.example.com]: ↵
Cannot open browser. Please visit:
  https://vault.example.com/api/mcp/authorize?client_id=mcpc_...&...
Waiting for authorization... (press Ctrl+C to cancel)
✔ Logged in to https://vault.example.com
```

### Scenario 3: CI/手動トークン
```
$ passwd-sso login --token
Server URL [https://vault.example.com]: ↵
Paste your token (from Dashboard > Settings):
Token: ****
⚠ Manual token will not auto-refresh. Use `passwd-sso login` for persistent sessions.
✔ Logged in to https://vault.example.com
```

### Scenario 4: セッション中の自動 refresh
```
passwd-sso> list
[entries...]
# ... 55 min later ...
[Background: Token refreshed via OAuth]
passwd-sso> get abc123
[entry details]  ← seamless, no re-auth needed
```

### Scenario 5: Refresh token 期限切れ（7 日以上放置）
```
$ passwd-sso status
⚠ Session expired. Run `passwd-sso login` to re-authenticate.
```

## Critical Files

### Server side
- `src/lib/constants/mcp.ts` — scope 追加
- `src/lib/scope-parser.ts` — `VALID_RESOURCE_ACTIONS` に `vault:unlock-data` 追加
- `src/lib/auth-or-token.ts` — `mcp_` dispatch
- `src/lib/check-auth.ts` — `mcp_token` type 許可 + `enforceAccessRestriction` 除外
- `src/lib/audit.ts` — `resolveActorType()` に `mcp_token` ケース追加
- `src/app/api/passwords/route.ts` — `authOrToken` 直接呼び出し、`mcp_token` guard 追加
- `src/lib/mcp/oauth-server.ts` — 既存（変更なし、参照のみ）
- `src/__tests__/lib/auth-or-token.test.ts` — 新規テスト
- `src/__tests__/audit.test.ts` — `resolveActorType` テスト追加
- `src/lib/scope-parser.test.ts` — テスト追加

### CLI side
- `cli/src/lib/oauth.ts` — 新規: PKCE + DCR + callback
- `cli/src/lib/config.ts` — keytar 除去 + credentials JSON
- `cli/src/lib/api-client.ts` — refresh endpoint 変更
- `cli/src/commands/login.ts` — OAuth フロー
- `cli/src/index.ts` — コマンド定義
- `cli/package.json` — keytar 除去
