# Batch F 実装プラン

## Context

Batch A〜E で P0/P1/P2 の全32機能を実装完了。残りは P3（長期/高工数）の16項目。
Batch F では既存インフラを活用できる8機能を4グループに分けて実装する。

---

## 全体構成

| Group | 機能ID | 機能名 | 工数 | 依存 |
|-------|--------|--------|------|------|
| **A** | D-2 | Secrets Management (CI/CD) | Medium | CLI (P-2) |
| **A** | D-3 | REST API (外部連携) | Medium | 既存API |
| **B** | E-1 | SSH鍵エントリタイプ | High | EntryType |
| **B** | D-1 | SSH Agent 連携 | High | E-1 + CLI |
| **C** | X-6 | TOTP QR キャプチャ | Medium | Extension |
| **C** | U-3 | Travel Mode | Medium | Vault |
| **D** | B-2 | Directory Sync | High | SCIM (B-1) |
| **D** | S-4 | Passkey Vault Unlock (PRF) | High | WebAuthn |

---

## セキュリティ制約

### ApiKey スコープ制限

- `scope` フィールドは Zod enum 配列で型安全にバリデーション（CSV 文字列ではなく `z.array(z.enum([...]))` → CSV 変換）
- 許可スコープ: `passwords:read`, `passwords:write`, `tags:read`, `vault:status`
- **禁止スコープ**: `vault:unlock`, `vault:setup`, `vault:reset` — API キーでの vault 操作は明示的に禁止
- ユーザーあたり最大 10 本の制限 (`MAX_API_KEYS_PER_USER = 10`)
- API キー作成時はセッション認証必須（API キーで API キーは作れない）
- **トークン仕様**: `api_` prefix + 43 文字 Base62 (256-bit entropy)。`crypto.randomBytes(32)` で生成
- **有効期限**: デフォルト 90 日、最大 365 日。永久キーは不許可（`apiKeyCreateSchema` で `expiresAt` 必須 + 最大値バリデーション）
- **ハッシュ**: 既存の `hashToken()` (SHA-256) を流用。256-bit entropy のトークンに対して SHA-256 は十分（探索空間 2^256）。HMAC は不要（既存 Extension/SCIM token と同一パターン維持）

### `/api/v1/*` Rate Limiting

- API キー用独立レート制限: `rl:api_key:${apiKeyId}` キーで Redis カウンター
- デフォルト: 100 req/min/key（既存セッション Rate Limit とは独立）
- `checkRateLimit()` 返却型: `{ allowed: boolean; retryAfterMs?: number }` — ルートハンドラで `Retry-After` ヘッダーに変換
- 429 レスポンス時に `Retry-After` ヘッダー（秒単位、`Math.ceil(retryAfterMs / 1000)`）返却

### proxy.ts 認証ルール

- `handleApiAuth()` 内の `OPTIONS` チェック（`handlePreflight()`）の**後**に `/api/v1/*` fallthrough を配置:
  ```typescript
  // 1. OPTIONS は既存 handlePreflight() で処理（変更なし）
  if (request.method === "OPTIONS") {
    return handlePreflight(request);
  }

  // 2. その後で /api/v1/* を fallthrough
  if (pathname.startsWith("/api/v1/")) {
    // Non-browser API: skip session redirect, assertOrigin
    // Route handlers handle all auth via validateApiKeyOnly()
    return NextResponse.next();
  }
  ```
- これにより `/api/v1/*` への GET/POST 等が `assertOrigin()`, `extensionTokenRoutes` チェックをバイパスし、ルートハンドラに委譲される。OPTIONS は引き続き `handlePreflight()` で処理される
- `/api/v1/openapi.json` は認証不要（スキーマは公開情報、ただし `OPENAPI_PUBLIC=false` 環境変数で認証必須に切替可能）
- `/api/v1/*` のその他エンドポイントは **API キー専用**の `validateApiKeyOnly()` で認証（セッション認証を受け付けない → CSRF 防止）
- proxy.ts のセッション認証必須リスト (L106-118) に `/api/v1/*` を **追加しない**
- proxy.ts のセッション認証必須リストに新規内部 API を追加: `/api/api-keys`, `/api/travel-mode`, `/api/directory-sync`, `/api/webauthn`

### `/api/v1/*` CORS ポリシー

- 非ブラウザクライアント限定と割り切り、CORS ヘッダーはデフォルトで返さない（same-origin 維持）
- 将来的にブラウザ SDK 対応が必要になった場合、`CORS_ALLOWED_ORIGINS` 環境変数で許可オリジンを設定可能にする
- 設計根拠: API キーは CI/CD パイプラインや CLI 等の非ブラウザクライアントが主な利用者。ブラウザからは既存セッション認証で内部 API を使用

### `AuthResult` 型拡張

- `authOrToken()` の返却型 union に `{ type: "api_key"; userId: string; tenantId: string; apiKeyId: string; scopes: ApiKeyScope[] }` を追加
- `requiredScope` パラメータを `ExtensionTokenScope | ApiKeyScope` のユニオン型に拡張
- `/api/v1/*` ルートハンドラでは `validateApiKeyOnly(req, requiredScope)` を使用（セッション・Extension token を受け付けない専用関数）。実装: Bearer 取得後に `api_` prefix を先にチェックし、prefix 不一致なら DB ルックアップなしで `{ ok: false, error: "INVALID_TOKEN_TYPE" }` を返す。エラーコード区分: prefix 不一致/無効トークン → 401 Unauthorized、スコープ不足 → 403 Forbidden（認証成功だが権限不足）。`lastUsedAt` 更新は revoked/expired チェック通過後にのみ実行（失効済みキーの lastUsedAt を更新しない）

### CI/CD セキュリティ注意事項

- `PSSO_PASSPHRASE` は CI シークレットストアに格納（ログ出力禁止）
- CI 用 API キーは最小スコープ (`passwords:read` のみ) で発行推奨
- ドキュメントにリスク明示: passphrase 漏洩時は vault 全体が危殆化

---

## 新規 npm パッケージ

| パッケージ | 対象 | 用途 |
|-----------|------|------|
| `jsqr` | Web + Extension | QR コードデコード |
| `@simplewebauthn/server` | Web (server) | WebAuthn 登録/検証 |
| `@simplewebauthn/browser` | Web (client) | WebAuthn ブラウザ API |

B-2 Directory Sync: SDK 不使用。Microsoft Graph / Google Admin SDK / Okta API に直接 `fetch` する軽量クライアント。

---

## Prisma スキーマ変更

### 既存モデルへの逆リレーション追加

```prisma
// User model に追加
apiKeys               ApiKey[]
webauthnCredentials   WebAuthnCredential[]

// Tenant model に追加
apiKeys               ApiKey[]
webauthnCredentials   WebAuthnCredential[]
directorySyncConfigs  DirectorySyncConfig[]
directorySyncLogs     DirectorySyncLog[]
```

### EntryType enum に SSH_KEY 追加

```prisma
enum EntryType {
  // ... 既存7つ ...
  SSH_KEY
}
```

### User モデルに Travel Mode フィールド追加

```prisma
// User model に追加
travelModeActive      Boolean   @default(false) @map("travel_mode_active")
travelModeActivatedAt DateTime? @map("travel_mode_activated_at")
```

### ApiKey モデル (新規)

```prisma
model ApiKey {
  id          String    @id @default(cuid())
  userId      String    @map("user_id")
  tenantId    String    @map("tenant_id")
  tokenHash   String    @unique @map("token_hash") @db.VarChar(64)
  prefix      String    @map("prefix") @db.VarChar(8)
  name        String    @db.VarChar(100)
  scope       String    @db.VarChar(512)  // CSV
  expiresAt   DateTime  @map("expires_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  revokedAt   DateTime? @map("revoked_at")
  lastUsedAt  DateTime? @map("last_used_at")

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([userId, revokedAt])
  @@index([tenantId])
  @@map("api_keys")
}
```

### WebAuthnCredential モデル (新規)

```prisma
model WebAuthnCredential {
  id                      String    @id @default(cuid())
  userId                  String    @map("user_id")
  tenantId                String    @map("tenant_id")
  credentialId            String    @unique @map("credential_id") @db.Text
  publicKey               String    @map("public_key") @db.Text
  counter                 BigInt    @default(0)
  transports              String[]  @default([])
  deviceType              String    @map("device_type") @db.VarChar(32)
  backedUp                Boolean   @default(false) @map("backed_up")
  nickname                String?   @db.VarChar(100)
  prfEncryptedSecretKey   String?   @map("prf_encrypted_secret_key") @db.Text
  prfSecretKeyIv          String?   @map("prf_secret_key_iv") @db.VarChar(24)
  prfSecretKeyAuthTag     String?   @map("prf_secret_key_auth_tag") @db.VarChar(32)
  prfSupported            Boolean   @default(false) @map("prf_supported")
  createdAt               DateTime  @default(now()) @map("created_at")
  lastUsedAt              DateTime? @map("last_used_at")

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([userId])
  @@index([tenantId])
  @@map("webauthn_credentials")
}
```

### DirectorySyncConfig / DirectorySyncLog モデル (新規)

```prisma
enum DirectorySyncProvider {
  AZURE_AD
  GOOGLE_WORKSPACE
  OKTA
}

enum DirectorySyncStatus {
  IDLE
  RUNNING
  SUCCESS
  ERROR
}

model DirectorySyncConfig {
  id                    String                @id @default(cuid())
  tenantId              String                @map("tenant_id")
  provider              DirectorySyncProvider
  displayName           String                @map("display_name") @db.VarChar(100)
  enabled               Boolean               @default(true)
  syncIntervalMinutes   Int                   @default(60) @map("sync_interval_minutes")
  encryptedCredentials  String                @map("encrypted_credentials") @db.Text
  credentialsIv         String                @map("credentials_iv") @db.VarChar(24)
  credentialsAuthTag    String                @map("credentials_auth_tag") @db.VarChar(32)
  status                DirectorySyncStatus   @default(IDLE)
  lastSyncAt            DateTime?             @map("last_sync_at")
  lastSyncError         String?               @map("last_sync_error") @db.Text
  lastSyncStats         Json?                 @map("last_sync_stats")
  nextSyncAt            DateTime?             @map("next_sync_at")
  createdAt             DateTime              @default(now()) @map("created_at")
  updatedAt             DateTime              @updatedAt @map("updated_at")

  tenant   Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  syncLogs DirectorySyncLog[]

  @@unique([tenantId, provider])  // 設計判断: 初期版は1テナント1プロバイダー。将来の複数設定は @@index に変更 + displayName 区別
  @@index([nextSyncAt, enabled])
  @@map("directory_sync_configs")
}

model DirectorySyncLog {
  id               String              @id @default(cuid())
  configId         String              @map("config_id")
  tenantId         String              @map("tenant_id")
  status           DirectorySyncStatus
  startedAt        DateTime            @map("started_at")
  completedAt      DateTime?           @map("completed_at")
  dryRun           Boolean             @default(false) @map("dry_run")
  usersCreated     Int                 @default(0) @map("users_created")
  usersUpdated     Int                 @default(0) @map("users_updated")
  usersDeactivated Int                 @default(0) @map("users_deactivated")
  groupsUpdated    Int                 @default(0) @map("groups_updated")
  errorMessage     String?             @map("error_message") @db.Text

  config DirectorySyncConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  tenant Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([configId, startedAt(sort: Desc)])
  @@map("directory_sync_logs")
}
```

### AuditAction enum 追加

```
API_KEY_CREATE, API_KEY_REVOKE,
TRAVEL_MODE_ENABLE, TRAVEL_MODE_DISABLE, TRAVEL_MODE_DISABLE_FAILED,
WEBAUTHN_CREDENTIAL_REGISTER, WEBAUTHN_CREDENTIAL_DELETE,
DIRECTORY_SYNC_CONFIG_CREATE, DIRECTORY_SYNC_CONFIG_UPDATE,
DIRECTORY_SYNC_CONFIG_DELETE, DIRECTORY_SYNC_RUN, DIRECTORY_SYNC_STALE_RESET

AUDIT_ACTION_GROUP 追加:
- API_KEYS: API_KEY_CREATE, API_KEY_REVOKE
- TRAVEL_MODE: TRAVEL_MODE_ENABLE, TRAVEL_MODE_DISABLE, TRAVEL_MODE_DISABLE_FAILED
- WEBAUTHN: WEBAUTHN_CREDENTIAL_REGISTER, WEBAUTHN_CREDENTIAL_DELETE
- DIRECTORY_SYNC: DIRECTORY_SYNC_CONFIG_CREATE, DIRECTORY_SYNC_CONFIG_UPDATE, DIRECTORY_SYNC_CONFIG_DELETE, DIRECTORY_SYNC_RUN, DIRECTORY_SYNC_STALE_RESET

AUDIT_ACTION_GROUPS 分類:
- PERSONAL: API_KEYS, TRAVEL_MODE, WEBAUTHN 追加
- TENANT: DIRECTORY_SYNC 追加
```

---

## Group A: Developer Platform (D-2 + D-3)

### 設計方針

- `ApiKey` モデル: `api_` prefix、テナントスコープ、ユーザー紐付け、スコープ制御、任意有効期限
- `authOrToken()` を拡張して Bearer token を prefix で振り分け（`api_` → `validateApiKey()`, それ以外 → `validateExtensionToken()`）。優先順位: session > Bearer token (prefix dispatch) > 未認証エラー
- `/api/v1/` に公開 REST API を配置（内部 `/api/passwords` と DB クエリ・レスポンス構築ロジックを共有）。ただし認証 + RLS コンテキスト設定は `/api/v1/*` 専用パス: `validateApiKeyOnly()` 返却の `tenantId` を直接 `withTenantRls(prisma, tenantId, fn)` に渡す（内部 API の `withUserTenantRls(userId)` による追加 DB クエリを回避）
- CLI に `env` / `run` / `api-key` コマンドを追加
- `scope` は `z.array(z.enum(API_KEY_SCOPES))` で Zod バリデーション → DB 保存時 CSV 変換
- `src/lib/validations.ts` に `apiKeyCreateSchema` を追加

### 新規 API ルート

| ルート | メソッド | 用途 |
|--------|---------|------|
| `/api/api-keys` | GET, POST | API キー一覧・作成 |
| `/api/api-keys/[id]` | DELETE | API キー失効 |
| `/api/v1/passwords` | GET, POST | 公開 REST (パスワード) |
| `/api/v1/passwords/[id]` | GET, PUT, DELETE | 公開 REST (パスワード個別) |
| `/api/v1/tags` | GET | 公開 REST (タグ) |
| `/api/v1/vault/status` | GET | 公開 REST (Vault 状態) |
| `/api/v1/openapi.json` | GET | OpenAPI 3.1 仕様書 |

### 新規 CLI コマンド

| コマンド | 用途 |
|---------|------|
| `passwd-sso env [-c config] [--format shell\|dotenv\|json]` | Vault secrets を環境変数として出力 |
| `passwd-sso run [-c config] -- <command>` | 環境変数注入してコマンド実行 (`child_process.execFile`, shell 非経由)。注入キーブロックリスト: `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `NODE_PATH` の上書き禁止（case-insensitive 照合: `key.toUpperCase()` でブロックリストと比較） |
| `passwd-sso api-key list\|create\|revoke` | API キー管理 |

CI/CD モデル: `PSSO_API_KEY` (認証) + `PSSO_PASSPHRASE` (復号) を CI シークレットに格納。

### 新規/変更ファイル

**サーバー側:**
- `src/lib/api-key.ts` — NEW: `validateApiKey()` + `validateApiKeyOnly()` (SHA-256 ハッシュ、`extension-token.ts` と同パターン) + `parseApiKeyScopes(csv: string): ApiKeyScope[]`
- `src/lib/auth-or-token.ts` — MOD: Bearer token prefix dispatch (`api_` → validateApiKey, else → validateExtensionToken) 追加、`AuthResult` union に `api_key` タイプ追加
- `src/lib/constants/api-key.ts` — NEW: スコープ・prefix 定数
- `src/lib/constants/audit.ts` — MOD: 全新規 AuditAction 追加 (API_KEY_*, TRAVEL_MODE_*, WEBAUTHN_*, DIRECTORY_SYNC_*) + AUDIT_ACTION_GROUP 追加 + GROUPS_PERSONAL/TENANT 分類
- `src/lib/openapi-spec.ts` — NEW: OpenAPI 3.1 仕様定義（レスポンス例で `encryptedBlob` 等の内部フィールドは抽象化、`data` プロパティとして表現）
- `src/app/api/api-keys/route.ts` — NEW
- `src/app/api/api-keys/[id]/route.ts` — NEW
- `src/app/api/v1/passwords/route.ts` — NEW
- `src/app/api/v1/passwords/[id]/route.ts` — NEW
- `src/app/api/v1/tags/route.ts` — NEW
- `src/app/api/v1/vault/status/route.ts` — NEW
- `src/app/api/v1/openapi.json/route.ts` — NEW
- `src/proxy.ts` — MOD: `/api/v1/*` をセッションリダイレクト除外、`/api/v1/openapi.json` を publicPaths 追加
- `src/lib/validations.ts` — MOD: `apiKeyCreateSchema` 追加 (Zod enum スコープ)
- `src/lib/rate-limit.ts` — MOD: API キー用独立レート制限 (`rl:api_key:${id}`, 100 req/min)

**UI:**
- `src/components/settings/api-key-manager.tsx` — NEW (`team-scim-token-manager.tsx` パターン)
- `src/app/[locale]/dashboard/settings/page.tsx` — MOD: ApiKeyManager 追加
- `messages/en/ApiKey.json`, `messages/ja/ApiKey.json` — NEW

**CLI:**
- `cli/src/commands/env.ts` — NEW
- `cli/src/commands/run.ts` — NEW
- `cli/src/commands/api-key.ts` — NEW
- `cli/src/lib/secrets-config.ts` — NEW: `.passwd-sso-env.json` ローダー。認証フロー選択: `apiKey` フィールドあり → `/api/v1/passwords` (Bearer api_key)、なし → インタラクティブ Extension token で `/api/passwords`。設定ファイルスキーマ: `{ "server": "https://...", "apiKey?": "api_...", "secrets": { "ENV_VAR_NAME": { "entry": "<entryId>", "field": "password" } } }`
- `cli/src/index.ts` — MOD: 新コマンド登録 (Commander サブコマンド)。インタラクティブモード: `env`, `api-key list` を追加。`agent`, `run` は非インタラクティブ専用（長期実行/外部プロセス起動のため）

---

## Group B: SSH Key Ecosystem (E-1 + D-1)

### 設計方針

- `SSH_KEY` エントリタイプ (8番目): 秘密鍵は `encryptedBlob` のみ、公開鍵・指紋は `encryptedOverview` にも格納
- ブラウザ側 PEM パーサ (`src/lib/ssh-key.ts`): OpenSSH バイナリ形式を直接解析、Web Crypto API で指紋計算。秘密鍵は `Uint8Array` で処理し使用後 `.fill(0)` でベストエフォート消去。JavaScript GC の制約上、完全なメモリ消去は保証不可（ドキュメントに明記）
- CLI SSH Agent (`cli/src/lib/ssh-agent-socket.ts`): Unix ドメインソケット、SSH agent プロトコル実装
- `EntryType` enum 追加時に exhaustive check パターンを維持（`satisfies Record<EntryType, EntryType>`）
- `src/lib/validations.ts` の Zod スキーマに SSH_KEY 関連フィールドを追加

### SSH Agent セキュリティ制約

- ソケットファイルパーミッション: `chmod 0o600` (作成直後に設定)
- ソケットディレクトリ: `$XDG_RUNTIME_DIR/passwd-sso/` 優先、未設定時のみ `/tmp/passwd-sso-${uid}/`。作成時 `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` + 作成後に `fs.statSync(dir)` でオーナーが `process.getuid()` かつ mode が `0o40700` であることを検証（TOCTOU/シンボリックリンク攻撃防止）
- メモリ上秘密鍵のゼロクリア: `Buffer.fill(0)` で使用後に消去、`process.on('exit')` でも実行
- Vault ロック連動: CLI の vault がロックされたら agent の鍵一覧をクリア、新規署名要求を拒否
- プロトコル処理はピュア関数として分離 (`ssh-agent-protocol.ts`) — テスト容易性確保
- **Windows 非サポート**: Unix ドメインソケット使用のため `process.platform === 'win32'` 時は明示的エラーメッセージで終了。将来的に Windows named pipe 対応可

### E-1: SSH_KEY エントリタイプ

**暗号化 Blob 構造:**
```json
// fullBlob
{ "title", "privateKey" (PEM), "publicKey", "fingerprint", "keyType", "keySize", "comment", "passphrase", "notes", "tags" }
// overviewBlob
{ "title", "keyType", "fingerprint", "publicKey", "comment", "tags" }
```

**新規/変更ファイル:**

新規:
- `src/lib/ssh-key.ts` — ブラウザ PEM パーサ (detectKeyType, parseSshPrivateKey, computeSshFingerprint)
- `src/components/entry-fields/ssh-key-fields.tsx` — 表示コンポーネント
- `src/components/passwords/personal-ssh-key-form.tsx` — 個人 Vault フォーム
- `src/components/team/team-ssh-key-form.tsx` — チーム Vault フォーム
- `messages/en/SshKeyForm.json`, `messages/ja/SshKeyForm.json`

変更:
- `prisma/schema.prisma` — EntryType に SSH_KEY 追加
- `src/lib/constants/entry-type.ts` — ENTRY_TYPE/VALUES に追加
- `src/components/passwords/password-detail-inline.tsx` — SSH_KEY 詳細セクション追加
- `src/components/passwords/password-card.tsx` — SSH_KEY カード表示
- `src/components/passwords/password-dashboard.tsx` — カテゴリ/ドロップダウン追加
- `src/components/layout/sidebar-sections.tsx` — サイドバーカテゴリ追加
- `src/components/passwords/personal-password-new-dialog.tsx` — フォーム接続
- `src/components/passwords/personal-password-edit-dialog.tsx` — フォーム接続
- `src/components/team/team-new-dialog.tsx` — チームフォーム接続
- `src/components/team/team-entry-kind.ts` — sshKey 追加
- `src/components/passwords/entry-history-keys.ts` — DISPLAY_KEYS, SENSITIVE_KEYS 追加
- `src/lib/export-format-common.ts` — SSH_KEY エクスポート処理
- `src/components/passwords/password-import-payload.ts` — SSH_KEY blob ビルダー
- `src/components/passwords/password-import-parsers.ts` — SSH_KEY パーサー

### D-1: SSH Agent

**新規 CLI ファイル:**
- `cli/src/lib/ssh-agent-protocol.ts` — プロトコル定数 + フレーミングヘルパー
- `cli/src/lib/ssh-key-agent.ts` — Node.js `crypto.createPrivateKey()` で PEM パース + SSH 署名
- `cli/src/lib/ssh-agent-socket.ts` — Unix ドメインソケットサーバー
- `cli/src/commands/agent.ts` — `passwd-sso agent` コマンド

**サポートするプロトコル操作:**
- `SSH2_AGENTC_REQUEST_IDENTITIES` → 鍵一覧返却
- `SSH2_AGENTC_SIGN_REQUEST` → 署名実行 (Ed25519, RSA-SHA2-256/512, ECDSA)
- その他 → `SSH_AGENT_FAILURE`

**使い方:** `eval $(passwd-sso agent --eval)` → `ssh-add -l` で確認 → `ssh`, `git commit -S` で使用

---

## Group C: Extension + UX Polish (X-6 + U-3)

### X-6: TOTP QR キャプチャ

**設計:** クライアントサイド完結。`jsqr` で QR デコード → `otpauth://` URI パース → TOTP フィールド自動入力。入力画像サイズは 4096x4096px 以下に制限（DoS 防止）。

**メモリクリーンアップ:** `getDisplayMedia` で取得した MediaStream は `finally` ブロックで確実に `track.stop()`（例外/タイムアウト時も保証）。Canvas の ImageData と ObjectURL は `URL.revokeObjectURL()` + 参照解放。QR デコード後の TOTP secret は JavaScript string（イミュータブル）のため直接メモリ消去は不可 — 変数参照の即時解放と GC への委任のみ（ドキュメントに明記）。

**getDisplayMedia UX:** ブラウザの画面共有ダイアログで「画面全体」「ウィンドウ」「タブ」を選択可能。TOTP QR が表示されている画面/タブのみを選択するよう UI で注意喚起テキストを表示。Extension の manifest.json に `"desktopCapture"` permission は不要（`captureVisibleTab` は既存の `activeTab` で可）。

**Web UI 変更:**
- `src/lib/qr-scanner-client.ts` — NEW: `scanImageForQR()`, `parseOtpauthUri()` (totp-field.tsx から抽出)
- `src/components/passwords/qr-capture-dialog.tsx` — NEW: スクリーンキャプチャ (`getDisplayMedia`) + ファイルアップロード
- `src/components/passwords/totp-field.tsx` — MOD: QR スキャンボタン追加
- `messages/en/TOTP.json`, `messages/ja/TOTP.json` — MOD: QR 関連キー追加

**Extension 変更:**
- `extension/src/lib/qr-scanner.ts` — NEW: `scanQRFromImageData()`, `extractTotpFromQR()`
- `extension/src/types/messages.ts` — MOD: `CAPTURE_VISIBLE_TAB_FOR_QR` メッセージ追加
- `extension/src/background/index.ts` — MOD: `chrome.tabs.captureVisibleTab` ハンドラ

### U-3: Travel Mode

**設計:** `travelSafe` フラグは暗号化 blob (full + overview) 内に格納。サーバーはフィルタ不可 → クライアントサイドフィルタ。アクティブ状態は `User.travelModeActive` に保存（監査 + クロスデバイス一貫性）。

**セキュリティ制約:**
- **サーバーサイド漏洩リスク**: travelSafe フラグは暗号化 blob 内のため、サーバーは travel-unsafe なエントリを区別できない。UI に「Travel Mode はクライアントサイドフィルタであり、暗号化データ自体はサーバーに存在する」旨の注意テキストを表示。
- **無効化にパスフレーズ再入力必須**: Travel Mode OFF 時に vault パスフレーズの再入力を要求。既存の `passphraseVerifierHmac` パターン（`computePassphraseVerifier()` → サーバー側 HMAC 比較）を使用。`/api/travel-mode/disable` は `verifierHash` を検証。
- **パスフレーズオラクル防止**: Travel Mode disable API も既存の `failedUnlockAttempts` / `accountLockedUntil` カウンターを共有。失敗時に監査ログ (`TRAVEL_MODE_DISABLE_FAILED`) を記録。
- **CLI 対応**: `passwd-sso travel-mode status|enable|disable` コマンドを追加。CLI でも無効化時はパスフレーズ入力を要求。
- **フィルタ関数のピュア関数化**: `filterTravelSafe(entries, travelModeActive)` をピュア関数として `src/lib/travel-mode.ts` に抽出。テスト容易性確保。blob 内に `travelSafe` フィールドが存在しない既存エントリはデフォルト `true`（旅行安全）として扱う（既存ユーザーが Travel Mode 有効化時に全エントリが非表示になる UX 問題を防止）。

**新規 API:**

| ルート | メソッド | 用途 |
|--------|---------|------|
| `/api/travel-mode` | GET | 状態取得 |
| `/api/travel-mode/enable` | POST | 有効化 |
| `/api/travel-mode/disable` | POST | 無効化 |

**新規/変更ファイル:**

新規:
- `src/lib/travel-mode.ts` — ピュア関数 `filterTravelSafe()` 抽出
- `src/app/api/travel-mode/route.ts`
- `src/app/api/travel-mode/enable/route.ts`
- `src/app/api/travel-mode/disable/route.ts` — passphraseHash 検証必須
- `src/hooks/use-travel-mode.ts`
- `src/components/passwords/travel-mode-indicator.tsx`
- `src/components/settings/travel-mode-card.tsx` — サーバーサイド漏洩リスク注意テキスト表示
- `cli/src/commands/travel-mode.ts` — CLI: `travel-mode status|enable|disable`
- `messages/en/TravelMode.json`, `messages/ja/TravelMode.json`

変更:
- `src/lib/personal-entry-payload.ts` — MOD: fullBlob + overviewBlob に `travelSafe` 追加
- `src/components/passwords/personal-login-form.tsx` 等 — MOD: travelSafe Switch 追加
- `src/components/passwords/password-list.tsx` — MOD: travel mode 時クライアントサイドフィルタ
- `extension/src/background/index.ts` — MOD: travel mode フィルタリング。`travelModeActive` 状態と entries を同一リクエストチェーンで取得（別々の非同期呼び出しによるレースコンディション防止）。パターン: `GET /api/travel-mode` → active なら entries 復号後にクライアントサイドフィルタ適用
- `extension/src/types/messages.ts` — MOD: `DecryptedEntry` に `travelSafe` 追加

---

## Group D: Enterprise Directory + Modern Auth (B-2 + S-4)

### B-2: Directory Sync

**設計:** 既存 SCIM 基盤 (`ScimExternalMapping`, `TenantMember.scimManaged`) を再利用。IdP からプルする同期エンジン。プロバイダー SDK 不使用 — REST API に直接 `fetch`。

**プロバイダー認証情報 (SSRF 対策: URL ホワイトリスト検証):**
- Azure AD: `tenantId` (UUID 形式のみ: `/^[0-9a-f-]{36}$/i`), `clientId`, `clientSecret` → `https://graph.microsoft.com/v1.0/` + `https://login.microsoftonline.com/${tenantId}/` に固定
- Google Workspace: `serviceAccountJson`, `domain` (RFC5321 ドメイン形式のみ) → `https://admin.googleapis.com/` に固定。JWT 署名は `node:crypto` で実装 (RS256: サービスアカウント PEM → `crypto.sign('sha256', payload, privateKey)`)
- Okta: `orgUrl` (`/^https:\/\/[a-zA-Z0-9-]+\.okta(preview)?\.com\/$/` 形式のみ), `apiToken` → 入力 URL のホスト部分を正規表現検証後に使用

**暗号化キー:** `DIRECTORY_SYNC_MASTER_KEY` 環境変数（専用キー）。`NODE_ENV=production` ではフォールバック禁止（未設定時にエラー）。開発環境でのみ `MASTER_KEY` にフォールバック。`getVerifierPepper()` と同パターン。

**RBAC:** Directory Sync API は `TenantRole.ADMIN` 以上のみアクセス可。`requireTenantRole("ADMIN")` ガードを全ルートに適用。`/api/directory-sync/[id]/*` ルートハンドラでは `configId` からテナント所有権を検証（`WHERE id = configId AND tenantId = session.tenantId`）。configId が他テナントのものなら 404 Not Found を返却（存在の漏洩防止）。

**並行実行制御:** 楽観的ロック方式。CAS チェック: `WHERE (status = 'IDLE' OR (status = 'RUNNING' AND started_at < NOW() - INTERVAL '30 minutes'))` で原子的に処理。既に `RUNNING`（30分以内）なら 409 Conflict を返却。stale リセット時は監査ログ (`DIRECTORY_SYNC_STALE_RESET`) を記録。

**定期実行:** 初期バージョンでは手動実行のみ。`syncIntervalMinutes` / `nextSyncAt` は将来の自動化用フィールドとして保持（nullable）。UI に「自動同期は将来対応」と表示。将来的に外部 cron または Vercel Cron Functions で `/api/directory-sync/[id]/run` を定期呼出し。

**エラーメッセージのサニタイズ:** `sanitizeSyncError(error: unknown): string` 関数で統一処理。(1) `Error.message` 抽出、(2) URL クエリパラメータ除去 (`url.replace(/\?.*$/, '?[REDACTED]')`)、(3) 既知の秘密値パターン (`Bearer `, `token=`, `client_secret=`) をマスク、(4) 最大 1000 文字で truncate。

**大規模誤削除の安全ガード:** 1 回の同期で deactivate 対象がアクティブユーザーの 20% を超える場合、自動実行を中断し管理者に確認を要求。dryRun で結果をプレビュー → 管理者が `force: true` で実行。

**新規 API:**

| ルート | メソッド | 用途 |
|--------|---------|------|
| `/api/directory-sync` | GET, POST | 設定一覧・作成 |
| `/api/directory-sync/[id]` | GET, PUT, DELETE | 設定 CRUD |
| `/api/directory-sync/[id]/run` | POST | 手動同期 (dryRun オプション) |
| `/api/directory-sync/[id]/logs` | GET | 同期ログ一覧 |

**新規ファイル:**
- `src/lib/directory-sync/azure-ad.ts` — MS Graph fetch クライアント
- `src/lib/directory-sync/google-workspace.ts` — Google Admin SDK fetch クライアント
- `src/lib/directory-sync/okta.ts` — Okta API fetch クライアント
- `src/lib/directory-sync/engine.ts` — 同期オーケストレーション (diff → upsert/deactivate)。DB への errorMessage/lastSyncError 書き込みはすべて `sanitizeSyncError()` を経由する内部ヘルパー `writeSyncError()` に集約（ルートハンドラからの直接書き込み禁止）
- `src/lib/directory-sync/credentials.ts` — 認証情報暗号化/復号 (`DIRECTORY_SYNC_MASTER_KEY` 優先、フォールバック `MASTER_KEY`)。`encryptServerData()` の AAD に `configId + tenantId` を指定（暗号文の別テナント/レコードへのコピー防止。WebAuthn PRF の AAD パターンと統一）
- `src/app/api/directory-sync/route.ts`
- `src/app/api/directory-sync/[id]/route.ts`
- `src/app/api/directory-sync/[id]/run/route.ts`
- `src/app/api/directory-sync/[id]/logs/route.ts`
- `src/components/settings/directory-sync-card.tsx`
- `src/components/settings/directory-sync-dialog.tsx`
- `src/components/settings/directory-sync-log-sheet.tsx`
- `messages/en/DirectorySync.json`, `messages/ja/DirectorySync.json`

### S-4: Passkey Vault Unlock (WebAuthn PRF)

**設計:** PRF 出力 (32 bytes) で wrapping key を置換。既存パスフレーズパスと並行する第2アンロックパス。

**PRF フロー:**
1. 登録（**前提: vault が unlock 状態であること**）: `navigator.credentials.create({ extensions: { prf: {} } })` → PRF サポート検出 → PRF 出力で secretKey をラップ → サーバーに保存。`passkey-register-dialog.tsx` で vault locked 時はボタン無効化 + 「Vault のアンロックが必要です」メッセージ表示
2. 認証: `/api/webauthn/authenticate/options` レスポンスに `prfSalt` を含める → クライアントが `navigator.credentials.get({ extensions: { prf: { eval: { first: prfSalt } } } })` に使用 → PRF 出力で secretKey アンラップ → HKDF → encryptionKey
3. PRF salt 導出（サーバーサイドで計算、クライアントには `prfSalt` のみ返却）:
   ```
   prfSalt = HKDF-SHA256(
     ikm: WEBAUTHN_PRF_SECRET (hex decode → 32 bytes),
     salt: rpId + ":" + userId (UTF-8),
     info: "prf-vault-unlock-v1" (UTF-8),
     length: 32 bytes
   )
   ```

**WebAuthn チャレンジ保存:**
- Redis に保存: `webauthn:challenge:${userId}` キー、TTL 5 分
- Consume-once: 検証成功後に即削除（リプレイ攻撃防止）
- チャレンジ未存在時は 400 Bad Request
- **レート制限**: options エンドポイント（register/authenticate 両方）にセッションベースレート制限を適用。`rl:webauthn_options:${userId}` キー、10 req/min。Redis 書き込み + チャレンジ生成の DoS を防止

**PRF 暗号化詳細:**
- AES-256-GCM で secretKey をラップ。AAD (Additional Authenticated Data) に `credentialId + userId` を設定 → 他の credential/user による unwrap を防止
- PRF 非対応ブラウザ: 登録時に `prf` extension が未サポートなら明示的エラー表示（暗黙フォールバック禁止）。ロック画面では "Use Passkey" ボタン表示条件: `prfSupported = true` の credential が1つ以上存在する場合のみ表示。PRF 対応 Passkey 削除時に残りの PRF 対応 credential が0になる場合は「Passkey アンロックが利用不可になる」旨の追加警告を表示

**WebAuthn カウンター更新:**
- `$transaction` でカウンター検証 + 更新をアトミックに実行
- カウンター不一致時は credential を無効化し、ユーザーに再登録を促す

**新規 API:**

| ルート | メソッド | 用途 |
|--------|---------|------|
| `/api/webauthn/register/options` | POST | 登録オプション生成 |
| `/api/webauthn/register/verify` | POST | 登録検証 + 保存 |
| `/api/webauthn/authenticate/options` | POST | 認証オプション生成 |
| `/api/webauthn/authenticate/verify` | POST | 認証検証 + PRF 鍵返却 |
| `/api/webauthn/credentials` | GET | 登録済み一覧 |
| `/api/webauthn/credentials/[id]` | DELETE, PATCH | 削除・リネーム |

**新規/変更ファイル:**

新規:
- `src/lib/webauthn-server.ts` — `@simplewebauthn/server` ラッパー、PRF salt 導出
- `src/app/api/webauthn/register/options/route.ts`
- `src/app/api/webauthn/register/verify/route.ts`
- `src/app/api/webauthn/authenticate/options/route.ts`
- `src/app/api/webauthn/authenticate/verify/route.ts`
- `src/app/api/webauthn/credentials/route.ts`
- `src/app/api/webauthn/credentials/[id]/route.ts` — DELETE/PATCH で `WHERE id = credentialId AND userId = session.userId` 所有権検証。他ユーザーの credential なら 404 返却
- `src/components/settings/passkey-credentials-card.tsx`
- `src/components/vault/passkey-register-dialog.tsx`
- `messages/en/WebAuthn.json`, `messages/ja/WebAuthn.json`

変更:
- `src/lib/vault-context.tsx` — MOD: `unlockWithPasskey()`, `registerPasskey()` 追加
- `src/components/vault/vault-lock-screen.tsx` — MOD: "Use Passkey" ボタン追加
- `src/app/[locale]/dashboard/settings/page.tsx` — MOD: Passkey 管理カード追加

**ブラウザサポート:** Chrome 116+ (完全), Safari 17.5+ (部分)。PRF 非対応時はパスフレーズにフォールバック。

**環境変数:** `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_PRF_SECRET` (PRF salt 導出用サーバー秘密値)

**RP ID 不変性:** `WEBAUTHN_RP_ID` は一度設定したら変更不可。変更すると既存の全 Passkey が無効化される。起動時に既存 credential が存在する場合、RP ID の一貫性を検証。ドキュメントに明記。

**`WEBAUTHN_PRF_SECRET` 漏洩時対応:** ローテーション不可と割り切る。漏洩時の手順: 全 Passkey を無効化（`WebAuthnCredential` テーブルの該当レコード削除）→ ユーザーに Passkey 再登録を案内。パスフレーズでのアンロックは引き続き可能なため vault データは失われない。ドキュメントに明記。

**Passkey 削除時の保護:** 最後の Passkey を削除しようとした場合、確認ダイアログを表示。Recovery key 未設定の場合は追加の警告表示。

**`OPENAPI_PUBLIC=false` 時:** ルートハンドラ内で `authOrToken()` を呼び出し、API キー認証（スコープ不問）またはセッション認証のいずれかで OK。

---

## 実装順序

### Step 1: Prisma スキーマ + マイグレーション
- 全モデル・enum 追加を一括マイグレーション
- `npm run db:migrate`
- RLS bypass allowlist 更新 — `.github/workflows/ci.yml` の `bypass-rls` ジョブに以下を追加:
  - `api_keys`
  - `webauthn_credentials`
  - `directory_sync_configs`
  - `directory_sync_logs`
- マイグレーション SQL で `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + RLS ポリシー作成

### Step 2: 定数・共通インフラ
- `src/lib/constants/api-key.ts`, `entry-type.ts` 更新 (ENTRY_TYPE + ENTRY_TYPE_VALUES に SSH_KEY 追加), `audit.ts` 更新 (全新規 AuditAction + グループ分類)
- `messages/en/AuditLog.json`, `messages/ja/AuditLog.json` — MOD: 新規 AuditAction 12件の i18n キー追加 (既存 `audit-log-keys.test.ts` が自動検証)
- `src/lib/env.ts` — `envSchema` に追加: `WEBAUTHN_RP_ID` (optional, デフォルト空文字。WebAuthn API 呼出時に未設定なら runtime エラー), `WEBAUTHN_RP_NAME` (optional, デフォルト APP_NAME), `WEBAUTHN_PRF_SECRET` (hex64, optional。WebAuthn API 呼出時に未設定なら runtime エラー), `DIRECTORY_SYNC_MASTER_KEY` (hex64, optional), `OPENAPI_PUBLIC` (boolean, optional, デフォルト true)
- `src/lib/api-key.ts` — validateApiKey() + validateApiKeyOnly()
- `src/lib/auth-or-token.ts` — api_ prefix 分岐、AuthResult union に api_key タイプ追加
- `scripts/check-bypass-rls.mjs` — `ALLOWED_FILES` に `src/lib/api-key.ts`, `src/lib/directory-sync/credentials.ts` を追加

### Step 3: Group A — Developer Platform
1. API キー管理ルート (`/api/api-keys`)
2. 公開 REST API (`/api/v1/*`) — 既存ハンドラロジック共有
3. OpenAPI 仕様
4. API キー管理 UI
5. CLI: `env`, `run`, `api-key` コマンド
6. i18n (ApiKey)

### Step 4: Group B — SSH Key Ecosystem
1. `src/lib/ssh-key.ts` — ブラウザ PEM パーサ
2. SSH_KEY エントリフォーム + 表示コンポーネント
3. ダイアログ・ダッシュボード・サイドバー接続
4. チーム Vault 対応
5. Import/Export 対応
6. CLI: `agent` コマンド + SSH agent プロトコル実装
7. i18n (SshKeyForm)

### Step 5: Group C — Extension + UX Polish
1. `jsqr` インストール
2. `qr-scanner-client.ts` + `qr-capture-dialog.tsx`
3. `totp-field.tsx` に QR ボタン追加
4. Travel Mode API ルート
5. 暗号化 blob に `travelSafe` 追加
6. Travel Mode UI + フィルタリング
7. Extension 対応 (QR + travel mode)
8. i18n (TravelMode, TOTP 追加キー)

### Step 6: Group D — Enterprise + Auth
1. `@simplewebauthn/*` インストール
2. WebAuthn サーバーライブラリ
3. WebAuthn API ルート (register/authenticate/credentials)
4. `vault-context.tsx` に passkey unlock パス追加
5. Passkey UI (ロック画面ボタン + 設定管理)
6. Directory Sync プロバイダークライアント (Azure AD / Google / Okta)
7. 同期エンジン
8. Directory Sync API ルート + UI
9. i18n (WebAuthn, DirectorySync)

### Step 7: テスト + ビルド検証

**テストファイル一覧:**

Group A (Developer Platform):
- `src/__tests__/api-key.test.ts` — `validateApiKey()` + `validateApiKeyOnly()` 境界テスト (有効/失効/期限切れ/スコープ不一致/不正prefix/SHA-256検証) + `parseApiKeyScopes()` テスト + `lastUsedAt` 更新条件テスト (revoked → 未更新、expired → 未更新、valid → 更新確認)
- `src/__tests__/auth-or-token.test.ts` — NEW: `api_` prefix dispatch テスト (api_ → validateApiKey, else → validateExtensionToken)、session > Bearer 優先順位、AuthResult `api_key` タイプフィールド検証
- `src/__tests__/api/api-keys.test.ts` — API キー CRUD + 本数上限 (10本) + 有効期限バリデーション (最大365日) + 禁止スコープ (`vault:unlock`, `vault:setup`, `vault:reset`) 拒否テスト + セッション認証排他テスト (Bearer api_ トークンで POST → 拒否、Extension token で POST → 拒否、セッション Cookie のみ成功)
- `src/__tests__/api/v1/passwords.test.ts` — 公開 REST API 認証・スコープ検証 + セッション認証拒否 (CSRF防止) テスト + Extension token 拒否テスト + Cookie のみリクエスト拒否テスト + rate limit 統合テスト (100 req 超過 → 429 + Retry-After ヘッダー秒単位検証、異なる API キー間の独立性確認)
- `src/__tests__/api/v1/openapi.test.ts` — デフォルト: 認証なし200 / `OPENAPI_PUBLIC=false`: 認証なし401、API キーあり200
- `src/__tests__/lib/rate-limit.test.ts` — MOD: API キー用キーパターン (`rl:api_key:${id}`)、100回超過後の制限発動、`Retry-After` ヘッダー検証
- `src/__tests__/proxy.test.ts` — MOD: `/api/v1/passwords` Bearer token 通過、`/api/v1/openapi.json` 認証なし通過、`/api/v1/passwords` 認証なし → ルートハンドラに委譲、OPTIONS `/api/v1/*` で CORS ヘッダー未付与確認、`assertOrigin()` 非呼出確認 + 新規保護ルート 401 テスト (`/api/api-keys`, `/api/travel-mode`, `/api/directory-sync`, `/api/webauthn/*` のセッション未認証時 → 401)
- `cli/src/__tests__/unit/env-command.test.ts` — env コマンド出力フォーマットテスト + secrets-config.ts 認証フロー分岐テスト (apiKey あり → /api/v1/ パス、なし → Extension token パス)
- `cli/src/__tests__/unit/run-command.test.ts` — run コマンド環境変数注入テスト (execFile使用確認) + ブロックリスト拒否テスト (PATH/LD_PRELOAD/NODE_OPTIONS 等の上書き試行 → エラー)

Group B (SSH Key):
- `src/__tests__/ssh-key.test.ts` — PEM パーサテスト (既知テストベクター: Ed25519/RSA/ECDSA 指紋検証)
- `src/__tests__/components/ssh-key-fields.test.tsx` — SSH_KEY 表示コンポーネント
- `cli/src/__tests__/unit/ssh-agent-protocol.test.ts` — プロトコルフレーミングのピュア関数テスト
- `cli/src/__tests__/unit/ssh-key-agent.test.ts` — SSH 署名テスト (Ed25519, RSA-SHA2-256/512)
- `cli/src/__tests__/unit/ssh-agent-socket.test.ts` — ソケットパーミッション検証 (0o600) + Windows 環境エラーテスト

Group C (TOTP QR + Travel Mode):
- `src/__tests__/qr-scanner-client.test.ts` — `scanImageForQR()`, `parseOtpauthUri()` テスト
- `src/__tests__/travel-mode.test.ts` — `filterTravelSafe()` ピュア関数テスト
- `src/__tests__/api/travel-mode.test.ts` — enable/disable API + パスフレーズ検証テスト + failedUnlockAttempts 共有ロックアウトテスト

Group D (Directory Sync + WebAuthn):
- `src/__tests__/api/webauthn/register.test.ts` — WebAuthn 登録フロー (`@simplewebauthn/server` の `verifyRegistrationResponse` / `generateRegistrationOptions` を `vi.mock` でモック)、PRF 非対応時の 400 エラー検証 + options レート制限テスト (同一ユーザー 10 req 超過 → 429)
- `src/__tests__/api/webauthn/authenticate.test.ts` — WebAuthn 認証 + PRF テスト + consume-once チャレンジ検証 (同一チャレンジ2回目 → 400、TTL 後 → 400) + カウンター不一致時の credential 無効化テスト + 無効化 credential での再認証拒否テスト + PRF AAD 不一致テスト (異なる credentialId/userId での unwrap 失敗検証)。Redis モック: `vi.mock` で `ioredis`
- `src/__tests__/directory-sync/engine.test.ts` — 同期エンジンテスト (外部 API モック + diff ロジック) + CAS 並行実行制御テスト (`status=RUNNING` → 409、30分 stale → IDLE リセット) + 安全ガードテスト (20% 超過 → 中断、`force: true` → 実行) + dryRun テスト (DB 変更なし確認 + プレビュー統計返却確認) + sanitize 経由 DB 書き込み統合テスト (外部 API が `Bearer token` 含むエラー返却 → DB の errorMessage がマスク済み確認)
- `src/__tests__/directory-sync/azure-ad.test.ts` — MS Graph モックテスト + tenantId UUID バリデーション境界テスト (SSRF バイパス試行)
- `src/__tests__/directory-sync/google-workspace.test.ts` — Google API モックテスト + domain バリデーション境界テスト + JWT クレーム (iat/exp/iss/aud/scope) 検証テスト
- `src/__tests__/directory-sync/okta.test.ts` — Okta API モックテスト + orgUrl 正規表現境界テスト (subdomain 偽装試行)
- `src/__tests__/directory-sync/credentials.test.ts` — 暗号化/復号テスト + production フォールバック禁止テスト
- `src/__tests__/directory-sync/sanitize.test.ts` — `sanitizeSyncError()` テスト (URL クエリ除去, Bearer マスク, client_secret マスク, 1000文字 truncate, null/undefined 安全性)

共通:
- `src/__tests__/i18n/entry-form-translation-keys.test.ts` — MOD: 新規 namespace 登録 (ApiKey, SshKeyForm, TravelMode, WebAuthn, DirectorySync, TOTP 追加キー)

**CI bypass-rls allowlist 追記:** `.github/workflows/ci.yml` に以下テーブルを追加:
```
api_keys, webauthn_credentials, directory_sync_configs, directory_sync_logs
```

**テスト設定更新:**
- `vitest.config.ts` の `coverage.include` に追加: `src/lib/api-key.ts`, `src/lib/auth-or-token.ts`, `src/lib/travel-mode.ts`, `src/lib/directory-sync/**/*.ts`, `src/lib/webauthn-server.ts`, `src/lib/ssh-key.ts`
- `src/__tests__/setup.ts` に追加: `WEBAUTHN_RP_ID=localhost`, `WEBAUTHN_RP_NAME=Test App`, `WEBAUTHN_PRF_SECRET="c".repeat(64)`, `DIRECTORY_SYNC_MASTER_KEY="d".repeat(64)`

**テスト実行:**
- `npm run lint`
- `npm run build`
- `npx vitest run`

---

## 検証

### Group A
- `curl -H "Authorization: Bearer api_xxx" http://localhost:3000/api/v1/passwords` → 暗号化エントリ一覧返却
- `passwd-sso env --format json` → JSON で secrets 出力
- `passwd-sso run -- env | grep DATABASE_PASSWORD` → 注入確認

### Group B
- SSH_KEY エントリ作成: PEM ペースト → 自動パース → 指紋・公開鍵表示
- `eval $(passwd-sso agent --eval)` → `ssh-add -l` → Vault の SSH 鍵一覧表示
- `ssh -T git@github.com` → agent 経由で認証成功

### Group C
- TOTP 設定画面: QR 画像アップロード → secret 自動入力
- Travel Mode ON → travelSafe=false エントリ非表示 → OFF で復元
- Extension でも同様のフィルタ動作

### Group D
- Passkey 登録 → ロック → Passkey でアンロック → エントリ閲覧可能
- PRF 非対応デバイス → パスフレーズへフォールバック表示
- Directory Sync: Azure AD 接続設定 → Dry Run → ユーザー作成プレビュー → 実行
