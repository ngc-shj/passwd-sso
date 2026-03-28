# Unified Access: AI Agent Identity & MCP Gateway

## Objective

1Password の「Unified Access」に対応し、passwd-sso に人間と AI エージェントのアイデンティティ統一管理機能を段階的に実装する。非人間アクター (サービスアカウント) のファーストクラスサポート、MCP Gateway によるクレデンシャル配信、統合監査ログを実現する。

## Requirements

### Functional
- サービスアカウント (非人間 ID) の CRUD + トークン管理
- サービスアカウントトークンによる API 認証 (`sa_` prefix)
- リソースレベルのスコープ (folder/tag 単位のアクセス制御)
- Just-in-Time アクセス承認ワークフロー (要求→承認→短寿命トークン発行)
- MCP Server (Streamable HTTP) として AI ツールにクレデンシャル提供
- OAuth 2.1 Authorization Server (Authorization Code + PKCE)
- 監査ログの actorType 拡張 (HUMAN / SERVICE_ACCOUNT / MCP_AGENT / SYSTEM)
- テナント管理者向け統合アクティビティダッシュボード

### Non-functional
- E2E 暗号化の維持 (サーバーは平文を見ない原則を崩さない)
- 既存の認証パターン (Session / Extension Token / API Key / SCIM Token) との後方互換
- 全マイグレーションが加算的 (additive) でロールバック可能
- テナント分離の維持 (全モデルに tenantId)
- 各フェーズが独立してリリース可能

## Technical Approach

### Context

現在の passwd-sso の基盤:
- 4種の認証パターン (Session / Extension Token / API Key / SCIM Token)
- `authOrToken()` による Bearer prefix ベースのディスパッチ (`src/lib/auth-or-token.ts`)
- 94 アクションの監査ログ (dual-write: DB + pino JSON) (`src/lib/audit.ts`)
- マルチテナント・チーム管理
- E2E 暗号化 Vault (サーバーは平文を見ない)
- Redis ベースのレート制限 (`src/lib/rate-limit.ts`)

**核心課題**: E2E 暗号化を維持しつつ、AI エージェントにどこまでクレデンシャルアクセスを許可するか。

### Architecture decisions
- MCP Server は Next.js API route として実装 (別プロセスではない) — 既存の Prisma / Redis / auth pipeline を再利用
- MCP Transport: Streamable HTTP at `/api/mcp`
- OAuth 2.1: Authorization Code + PKCE (MCP spec 準拠)
- E2E 暗号化戦略: Phase 3 では暗号化済みデータのみ公開 (Option A)。Delegated Decryption は将来の Phase 5
- Service Account Token prefix: `sa_` (既存の `api_` / `scim_` と衝突しない)

---

## Phase 1: Agent Identity & Service Accounts (v0.4.0)

**目的**: 非人間アクター (サービスアカウント) をファーストクラスのエンティティとして導入。

### Schema

```prisma
enum IdentityType {
  HUMAN
  SERVICE_ACCOUNT
  MCP_AGENT
}

model ServiceAccount {
  id           String       @id @default(uuid(4)) @db.Uuid
  tenantId     String       @map("tenant_id") @db.Uuid
  teamId       String?      @map("team_id") @db.Uuid
  name         String       @db.VarChar(100)
  description  String?      @db.Text
  identityType IdentityType @default(SERVICE_ACCOUNT) @map("identity_type")
  isActive     Boolean      @default(true) @map("is_active")
  createdById  String       @map("created_by_id") @db.Uuid
  createdAt    DateTime     @default(now()) @map("created_at")
  updatedAt    DateTime     @updatedAt @map("updated_at")

  tenant    Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  team      Team?               @relation(fields: [teamId], references: [id], onDelete: SetNull)
  tokens    ServiceAccountToken[]
  auditLogs AuditLog[]

  @@unique([tenantId, name])
  @@index([tenantId, isActive])
  @@map("service_accounts")
}

model ServiceAccountToken {
  id               String    @id @default(uuid(4)) @db.Uuid
  serviceAccountId String    @map("service_account_id") @db.Uuid
  tenantId         String    @map("tenant_id") @db.Uuid
  tokenHash        String    @unique @map("token_hash") @db.VarChar(64)
  prefix           String    @map("prefix") @db.VarChar(8)
  name             String    @db.VarChar(100)
  scope            String    @db.VarChar(1024)
  expiresAt        DateTime  @map("expires_at")
  createdAt        DateTime  @default(now()) @map("created_at")
  revokedAt        DateTime? @map("revoked_at")
  lastUsedAt       DateTime? @map("last_used_at")

  serviceAccount ServiceAccount @relation(fields: [serviceAccountId], references: [id], onDelete: Cascade)
  tenant         Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([serviceAccountId, revokedAt])
  @@index([tenantId])
  @@index([expiresAt])
  @@map("service_account_tokens")
}
```

### Token prefix: `sa_`

既存の `api_` / `scim_` と衝突しない。`authOrToken()` の Bearer dispatch で prefix 判別。

### Token hashing

既存の API Key / Extension Token / SCIM Token と同じ SHA-256 (unsalted) パターンを使用。ベアラートークンは 256-bit エントロピー (48 random bytes → base62) のため、salted hashing は不要 (GitHub, Stripe 等と同じ業界標準)。パスワードハッシュ (bcrypt/Argon2) とは用途が異なる。

### Token lookup

毎リクエストで DB 直接検索 (SHA-256 hash → `tokenHash` unique index)。トークンキャッシュは使用しない。revoke 時は `revokedAt` を即時更新し、次のリクエストから無効になる (キャッシュ不整合のリスクなし)。

### Scope validation (Critical: Review Finding)

SA トークンの scope は **enumerated allowlist** (`z.array(z.enum(SA_ALLOWED_SCOPES))`) で検証する。CSV 文字列を直接受け付けない。

```typescript
// src/lib/constants/service-account.ts
export const SA_TOKEN_SCOPE = {
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
  PASSWORDS_LIST: "passwords:list",
  TAGS_READ: "tags:read",
  VAULT_STATUS: "vault:status",
  FOLDERS_READ: "folders:read",
  FOLDERS_WRITE: "folders:write",
  TEAM_PASSWORDS_READ: "team:passwords:read",
  TEAM_PASSWORDS_WRITE: "team:passwords:write",
} as const;

export const SA_TOKEN_FORBIDDEN_SCOPES = [
  "vault:unlock",
  "vault:setup",
  "vault:reset",
];
```

Zod schema で `z.array(z.enum([...SA_ALLOWED_SCOPES]))` を使い、forbidden scope が DB に永続化されることを構造的に防ぐ。CSV 文字列への変換はバリデーション通過後にサーバー側で行う。

### Auth pipeline 拡張 (Review Finding: dispatch safety)

`src/lib/auth-or-token.ts` の `AuthResult` に追加:
```typescript
| { type: "service_account"; serviceAccountId: string; tenantId: string; tokenId: string; scopes: SaTokenScope[] }
```

**Bearer dispatch の安全性**: `authOrToken()` のプレフィックスディスパッチを prefix table 方式に変更し、未知プレフィックスが Extension Token パスにフォールスルーしないよう `return null` で明示遮断する。

```typescript
// Prefix dispatch table
if (bearer.startsWith("api_")) → validateApiKey()
else if (bearer.startsWith("sa_")) → validateServiceAccountToken()
else if (!bearer.startsWith("api_") && !bearer.startsWith("sa_") && !bearer.startsWith("scim_")) → validateExtensionToken()
else → return null  // unknown prefix
```

### SA isActive check (Review Finding)

`validateServiceAccountToken()` は token 自体の `revokedAt` / `expiresAt` チェックに加えて、親 `ServiceAccount.isActive` もチェックする。`isActive = false` の SA に紐づくトークンは即時無効。

### proxy.ts 更新 (Review Finding: Bearer bypass)

`src/proxy.ts` の `handleApiAuth()` に以下を追加:
- SA トークンが Bearer auth で使用される API ルート (`/api/passwords`, `/api/v1/*`, `/api/tags`, `/api/vault/status`) を Bearer bypass リストに登録
- `/api/tenant/service-accounts` は session 必須ルート (管理者がブラウザ UI から操作)

### API endpoints (tenant admin only)

| Path | Methods | Purpose |
|------|---------|---------|
| `/api/tenant/service-accounts` | GET, POST | List/create |
| `/api/tenant/service-accounts/[id]` | GET, PUT, DELETE | CRUD |
| `/api/tenant/service-accounts/[id]/tokens` | GET, POST | Token list/create |
| `/api/tenant/service-accounts/[id]/tokens/[tokenId]` | DELETE | Revoke token |

### New files
- `src/lib/constants/service-account.ts` — scopes (enumerated allowlist), limits, forbidden scopes
- `src/lib/service-account-token.ts` — validation (SHA-256 hash lookup, expiry, revoked, **SA isActive** check)
- `src/lib/validations/service-account.ts` — Zod schemas (`z.array(z.enum(...))` for scopes)
- `src/app/api/tenant/service-accounts/` — route handlers

### Modified files
- `prisma/schema.prisma` — models + relations on Tenant, Team
- `src/lib/auth-or-token.ts` — AuthResult union + `sa_` prefix dispatch (prefix table pattern)
- `src/lib/constants/audit.ts` — new AuditAction values
- `src/lib/constants/audit-target.ts` — SERVICE_ACCOUNT target type
- `src/proxy.ts` — Bearer bypass list + new session route registration

### Audit actions
`SERVICE_ACCOUNT_CREATE`, `SERVICE_ACCOUNT_UPDATE`, `SERVICE_ACCOUNT_DELETE`, `SERVICE_ACCOUNT_TOKEN_CREATE`, `SERVICE_ACCOUNT_TOKEN_REVOKE`

---

## Phase 2: Enhanced Scoping & Just-in-Time Access (v0.5.0)

**目的**: リソースレベルのスコープと、承認ワークフロー付き短寿命トークン。

### Scope format 拡張

現在: `passwords:read,tags:read` (flat CSV)
拡張: `passwords:read:folder/<folderId>`, `team:<teamId>:passwords:read`

修飾なし = 全リソースアクセス (後方互換)。

#### Parsing rules
1. Scope 文字列は CSV で分割 (`passwords:read,tags:read`)
2. 各トークンは `resource:action` または `resource:action:qualifier` 形式
3. 既存の flat scopes (`passwords:read`) は qualifier なしとしてそのまま有効
4. qualifier 形式: `folder/<uuid>`, `tag/<uuid>`, `team/<uuid>` — UUID 部分は `z.string().uuid()` でバリデーション
5. 不明な scope トークンは無視 (既存の `parseApiKeyScopes` パターンに従う)
6. 既存の API Key / Extension Token は flat scope のまま変更なし (`hasApiKeyScope()` も変更なし)。scope-parser は SA Token と MCP Token にのみ適用

#### Scope evaluation (Review Finding)
scope-parser は **prefix match** 方式: `passwords:read` は `passwords:read:folder/<uuid>` を包含する (上位スコープ)。逆に `passwords:read:folder/abc` は `passwords:read` の部分集合。

### New files
- `src/lib/scope-parser.ts` — unified `resource:action[:qualifier]` parser + matcher

### JIT Access Schema

```prisma
enum AccessRequestStatus {
  PENDING
  APPROVED
  DENIED
  EXPIRED
}

model AccessRequest {
  id               String              @id @default(uuid(4)) @db.Uuid
  tenantId         String              @map("tenant_id") @db.Uuid
  serviceAccountId String              @map("service_account_id") @db.Uuid
  requestedScope   String              @map("requested_scope") @db.Text
  justification    String?             @db.Text
  status           AccessRequestStatus @default(PENDING)
  approvedById     String?             @map("approved_by_id") @db.Uuid
  approvedAt       DateTime?           @map("approved_at")
  grantedTokenId   String?             @map("granted_token_id") @db.Uuid
  grantedTokenTtlSec Int?              @map("granted_token_ttl_sec")
  expiresAt        DateTime            @map("expires_at")
  createdAt        DateTime            @default(now()) @map("created_at")

  tenant         Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  serviceAccount ServiceAccount @relation(fields: [serviceAccountId], references: [id], onDelete: Cascade)

  @@index([tenantId, status, createdAt(sort: Desc)])
  @@index([serviceAccountId, status])
  @@map("access_requests")
}
```

### Workflow
1. SA が `POST /api/tenant/access-requests` でスコープ要求
2. Tenant admin に Notification 通知
3. Admin が `POST /api/tenant/access-requests/[id]/approve` → 短寿命 `ServiceAccountToken` 自動発行 (default TTL: 1h)

### JIT approval atomicity (Review Finding: race condition)

承認処理は単一 DB トランザクション内で実行。楽観的ロックとして `WHERE id = ? AND status = 'PENDING'` の affected rows を確認し、二重承認を防止する。

```typescript
// Pseudo-code
const result = await prisma.$transaction(async (tx) => {
  const updated = await tx.accessRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "APPROVED", approvedById, approvedAt: new Date() },
  });
  if (updated.count === 0) throw new Error("Already processed");
  const token = await tx.serviceAccountToken.create({ ... });
  return token;
});
```

### JIT cross-tenant validation (Review Finding: IDOR prevention)

承認エンドポイントで以下を検証:
1. `accessRequest.tenantId === approver.tenantId` (アプリレベル)
2. JIT トークン発行時は SA のテナントポリシー (`jitTokenMaxTtlSec`) を適用
3. `withBypassRls()` は **JIT ビジネスロジック内では使用しない** (データ操作層の制限)。ただし `logAudit` 内部の `withBypassRls` 使用は例外 — audit.ts は全てのアクションで RLS bypass を使用しており、これは audit 書き込みのインフラ層であるため適用範囲外

### Tenant policy additions
- `jitTokenDefaultTtlSec` (default: 3600)
- `jitTokenMaxTtlSec` (default: 86400)
- `saTokenMaxExpiryDays` (default: 365)

---

## Phase 3: MCP Gateway (v0.6.0)

**目的**: MCP Server として passwd-sso を AI ツール (Claude, Cursor 等) のクレデンシャルプロバイダに。

### Architecture decision

Next.js API route として実装 (別プロセスではない)。既存の Prisma / Redis / auth pipeline を再利用。

Transport: MCP Streamable HTTP at `/api/mcp`

### SSRF prevention (Review Finding)

MCP ツールの引数は Zod で厳密に型定義。URL 型引数を受け付けるツールは Phase 3 では実装しない。将来のツール拡張時は outbound allowlist (許可ホストのみ fetch 可能) を必須とする。

### OAuth 2.1 Authorization Server

MCP spec 準拠の認可フロー (Authorization Code + PKCE)。

```prisma
model McpClient {
  id            String   @id @default(uuid(4)) @db.Uuid
  tenantId      String   @map("tenant_id") @db.Uuid
  clientId      String   @unique @map("client_id") @db.VarChar(64)
  clientSecret  String   @map("client_secret") @db.Text  // SHA-256 hash (not bcrypt)
  name          String   @db.VarChar(100)
  redirectUris  String[] @map("redirect_uris")
  allowedScopes String   @map("allowed_scopes") @db.VarChar(1024)
  isActive      Boolean  @default(true) @map("is_active")
  createdById   String   @map("created_by_id") @db.Uuid
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  @@index([tenantId])
  @@map("mcp_clients")
}

model McpAccessToken {
  id               String    @id @default(uuid(4)) @db.Uuid
  tokenHash        String    @unique @map("token_hash") @db.VarChar(64)
  clientId         String    @map("client_id") @db.Uuid
  userId           String?   @map("user_id") @db.Uuid
  serviceAccountId String?   @map("service_account_id") @db.Uuid
  tenantId         String    @map("tenant_id") @db.Uuid
  scope            String    @db.VarChar(1024)
  expiresAt        DateTime  @map("expires_at")
  revokedAt        DateTime? @map("revoked_at")
  createdAt        DateTime  @default(now()) @map("created_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  @@index([tenantId])
  @@index([expiresAt])
  @@map("mcp_access_tokens")
}
```

**McpAccessToken CHECK constraint (Review Finding)**: DB レベルで `CHECK ((user_id IS NOT NULL) OR (service_account_id IS NOT NULL))` を raw migration で追加。アプリ層でも Zod `z.union()` でいずれか必須を強制。

**McpClient clientSecret (Review Finding: bcrypt → SHA-256)**: `clientSecret` はサーバー側で `randomBytes(32)` で生成し、既存の `hashToken()` (SHA-256) で保存。bcrypt は不要 (高エントロピーランダムトークンのため)。token endpoint の rate limit キーは `client_id` 単位。

(+ `McpAuthorizationCode` for PKCE flow)

### MCP Tools

| Tool | Description |
|------|-------------|
| `list_credentials` | List entries (encrypted overviews + metadata) |
| `get_credential` | Get entry (encrypted blob) |
| `search_credentials` | Search by overview metadata |

全ツールの入力は Zod で厳密型定義。URL 型引数なし (SSRF 防止)。

### E2E encryption strategy

**Phase 3 では Option A: Encrypted data のみ公開**。サーバーは暗号化済みデータを返し、復号はクライアントサイド (vault unlock 状態のアプリ) で行う。サーバーは平文を見ないという原則を維持。

将来の Phase 5 で Delegated Decryption (人間が vault unlock 中に特定エントリの復号済みデータを MCP セッション内で共有) を検討。

### API endpoints

| Path | Methods | Purpose |
|------|---------|---------|
| `/api/mcp` | POST, GET | MCP Streamable HTTP + SSE |
| `/api/mcp/authorize` | GET | OAuth 2.1 authorization page |
| `/api/mcp/token` | POST | OAuth 2.1 token endpoint |
| `/api/mcp/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata |
| `/api/tenant/mcp-clients` | GET, POST | Client management |
| `/api/tenant/mcp-clients/[id]` | GET, PUT, DELETE | Client CRUD |

---

## Phase 4: Unified Audit (v0.5.0, parallel with Phase 2)

**目的**: 人間/エージェント/マシンの全アクションを横断的に追跡。

### Schema changes (existing table)

`AuditLog` に2カラム追加:
```prisma
actorType        ActorType @default(HUMAN) @map("actor_type")
serviceAccountId String?   @map("service_account_id") @db.Uuid
```

```prisma
enum ActorType {
  HUMAN
  SERVICE_ACCOUNT
  MCP_AGENT
  SYSTEM
}
```

### AuditLog userId strategy (Review Finding R1+R2: NOT NULL conflict + silent drop)

現行の `AuditLog.userId` は NOT NULL + FK to User。SA アクターの場合の対応:

**方針: userId に SA の createdById (作成者) を記録し、serviceAccountId で実際のアクターを特定する。**

**重要制約: ServiceAccount は必ず人間の tenant admin が作成する (createdById は常に有効な User UUID)。**「System SA」(createdById なし) の概念は存在しない。SA 作成 API は session 認証 (tenant admin) を必須とし、createdById は `auth().user.id` から取得。これにより `logAudit` の tenantId 解決 (`userId → user.tenantId`) が常に成功する。

**SA アクションは `logAudit` (single) を使用し、`logAuditBatch` は使用しない。** `logAuditBatch` は同一 userId 契約があるため、複数 SA からのイベント混在時に契約違反になるリスクがある。

理由:
- `userId` を nullable に変更すると既存コード・クエリへの影響が大きい (90+ 箇所の userId 参照)
- createdById は常に有効な User UUID (SA 作成は session 必須のため)
- `actorType` + `serviceAccountId` の組み合わせで正確なアクター特定が可能
- 将来の検索は `actorType` フィルターで分離

### Migration (Review Finding: backfill)

```sql
-- Step 1: Add columns with defaults (new rows only)
ALTER TABLE audit_logs ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'HUMAN';
ALTER TABLE audit_logs ADD COLUMN service_account_id UUID NULL;

-- Step 2: Explicit backfill for existing rows (batched)
UPDATE audit_logs SET actor_type = 'HUMAN' WHERE actor_type IS NULL;

-- Step 3: Add indexes
CREATE INDEX idx_audit_logs_actor_type ON audit_logs(actor_type, tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_sa_id ON audit_logs(service_account_id) WHERE service_account_id IS NOT NULL;

-- Step 4: Add FK constraint
ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_logs_service_account
  FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL;
```

大量行がある場合はバッチ更新 (1000行ずつ) で実行。マイグレーション後に `SELECT COUNT(*) FROM audit_logs WHERE actor_type IS NULL` = 0 を事後アサーション。

### logAudit extension

`AuditLogParams` に `actorType?` + `serviceAccountId?` を追加。既存呼び出しは変更不要 (default HUMAN)。

`authOrToken` 結果から actorType を自動推定する `resolveActorType()` helper。

### Unified Dashboard

`src/app/[locale]/dashboard/admin/activity/page.tsx` — tenant admin 向け統合ビュー。actorType フィルター付き。

既存の `(tenantId, scope, createdAt DESC)` インデックスに加えて `(tenantId, actorType, createdAt DESC)` をカバリングインデックスとして追加。cursor-based pagination (既存パターン)。

---

## Implementation Steps

### Phase 1: Agent Identity & Service Accounts (v0.4.0)
1. Prisma schema に `IdentityType` enum、`ServiceAccount`、`ServiceAccountToken` モデル追加 + migration
2. `Tenant` / `Team` モデルにリレーション追加
3. `src/lib/constants/service-account.ts` — scopes (**enumerated allowlist**), limits, forbidden scopes
4. `src/lib/service-account-token.ts` — token validation (SHA-256 hash lookup, expiry, revoked check, **SA isActive check**, lastUsedAt update)
5. `src/lib/validations/service-account.ts` — Zod schemas (`z.array(z.enum(...))` for scopes)
6. `src/lib/auth-or-token.ts` — AuthResult union に `service_account` variant 追加、**prefix table dispatch** (unknown prefix → null)
7. `src/lib/constants/audit.ts` + `audit-target.ts` — new AuditAction values
8. `src/app/api/tenant/service-accounts/` — CRUD route handlers (4 endpoints)
9. `src/proxy.ts` — **Bearer bypass list に SA 対象ルート追加** + session 必須ルート登録
10. Tests (Vitest) — **cross-tenant rejection** ケース含む、`auth-or-token.ts` 80% coverage 維持

### Phase 2: Enhanced Scoping & Just-in-Time Access (v0.5.0)
11. `src/lib/scope-parser.ts` — unified `resource:action[:qualifier]` parser + **prefix match evaluator**
12. Prisma schema に `AccessRequestStatus` enum、`AccessRequest` モデル追加 + migration
13. Tenant policy columns 追加 (jitTokenDefaultTtlSec, jitTokenMaxTtlSec, saTokenMaxExpiryDays)
14. `src/app/api/tenant/access-requests/` — 4 endpoints (list, create, approve, deny)
    - approve: **single transaction + optimistic lock** (`WHERE status='PENDING'`)
    - approve: **cross-tenant IDOR check** (`accessRequest.tenantId === approver.tenantId`)
15. Notification 連携 (既存 Notification モデル利用)
16. Tests — **既存 flat scope の backward compat integration test** 含む

### Phase 3: MCP Gateway (v0.6.0)
17. Prisma schema に `McpClient`、`McpAuthorizationCode`、`McpAccessToken` モデル追加 + migration
    - McpAccessToken: **CHECK constraint** (`user_id IS NOT NULL OR service_account_id IS NOT NULL`)
    - McpClient clientSecret: **SHA-256** (not bcrypt)
18. `src/lib/mcp/oauth-server.ts` — OAuth 2.1 Authorization Code + PKCE
19. `src/lib/mcp/transport.ts` — Streamable HTTP transport
20. `src/lib/mcp/server.ts` — MCP server core (tool definitions, handler dispatch)
21. `src/lib/mcp/tools.ts` — list_credentials, get_credential, search_credentials (**Zod strict input, no URL args**)
22. `src/app/api/mcp/` — MCP endpoint + OAuth endpoints
23. `src/app/api/tenant/mcp-clients/` — client management CRUD
24. Rate limiting per MCP token (**key: client_id**)
25. Tests — **PKCE failure paths** (verifier missing/invalid/code replay) + **stream error handling** (disconnect/timeout)

### Phase 4: Unified Audit (v0.5.0, parallel with Phase 2)
26. AuditLog に `actorType` (DEFAULT HUMAN) + `serviceAccountId` カラム追加 + **explicit backfill** + indexes + migration
27. `ActorType` enum 追加 (HUMAN, SERVICE_ACCOUNT, MCP_AGENT, SYSTEM)
28. `src/lib/audit.ts` — AuditLogParams 拡張 + resolveActorType() helper
29. `src/app/[locale]/dashboard/admin/activity/page.tsx` — unified dashboard (cursor pagination, actorType filter)
30. 既存監査ログ API に actorType filter 追加
31. Tests — **migration backfill verification** (post-migration assertion script)

## Implementation Order & Dependencies

```
Phase 1 (SA基盤) ──→ Phase 2 (JIT) ──→ Phase 3 (MCP)
        │                                    │
        └──→ Phase 4 (Unified Audit) ←───────┘
```

Phase 4 は Phase 1 完了後に着手可能。Phase 2 と並行リリース。

## Release Strategy

| Release | Content |
|---------|---------|
| v0.4.0 | Phase 1: Service Accounts |
| v0.5.0 | Phase 2 + 4: JIT Access + Unified Audit |
| v0.6.0 | Phase 3: MCP Gateway |

## Testing Strategy

### Test file separation (Review Finding R2)
- `src/lib/service-account-token.test.ts` — `validateServiceAccountToken()` の単体テスト (token validation logic)
- `src/lib/auth-or-token.test.ts` — `sa_` dispatch テストを既存ファイルに追加 (dispatch routing のみ)
- `src/app/api/tenant/service-accounts/route.test.ts` — CRUD route handler テスト
- `src/lib/scope-parser.test.ts` — scope parser 単体テスト
- `src/lib/mcp/oauth-server.test.ts` — OAuth 2.1 単体テスト

### Phase 1
- Unit (`service-account-token.test.ts`): valid/expired/revoked/scope-insufficient/**cross-tenant rejection**/SA isActive=false cases
- Unit (`service-account-token.test.ts`): `parseSaTokenScopes()` — parse/unknown-drop/empty
- Unit (`auth-or-token.test.ts`): `sa_` prefix → SA validation 呼び出し、`api_` prefix 既存パス共存、unknown prefix → null。**80% coverage 維持** (SA ブランチ: isActive false / cross-tenant / scope insufficient / valid の 4 分岐をカバー)
- Integration (`route.test.ts`): SA CRUD API — create/list/update/delete with tenant isolation
- Integration: SA token create/revoke + Bearer auth via `sa_` prefix
- E2E: Tenant admin creates SA → issues token → token accesses `/api/v1/passwords` → audit log recorded (actorType=SERVICE_ACCOUNT)
- `npx vitest run` + `npx next build` pass

### Phase 2
- Unit (`scope-parser.test.ts`): `resource:action[:qualifier]` format, **prefix match evaluation**
- Unit (`api-key.test.ts`): 既存の `parseApiKeyScopes` に flat scope backward compat ケース追加 (qualifier 追加後も壊れないこと)
- Integration: AccessRequest workflow — create → approve → JIT token issued → expires
- Integration: Scope qualifier enforcement — folder/tag level filtering
- Tenant policy enforcement — TTL limits
- Integration: **JIT approval race condition** — 楽観的ロックの検証は DB 統合テスト (Prisma の `$transaction` + `updateMany` の affected rows) として実装。Vitest の mock レベルでは並行性を検証できないため、**DB 接続テスト** (`scripts/__tests__/*.test.mjs`) で実施

### Phase 3
- Unit (`oauth-server.test.ts`): authorization code generation, PKCE verification, token exchange
- Unit: **PKCE failure paths** — code_verifier missing (400), code_verifier invalid/hash不一致 (400), authorization_code not found (400), authorization_code 使用済み (400, `usedAt` が non-null の mock で再現)
- Integration: MCP Streamable HTTP transport — tool call round-trip
- Integration: **MCP stream error handling** — `vi.useFakeTimers()` でタイムアウト制御、`ReadableStream` の mock で途中切断をシミュレート
- Integration: MCP tools — list/get/search return encrypted data only, **no URL args accepted**
- Integration (Vitest): MCP client register → OAuth authorize → token → tool call
- Manual: Claude Desktop / Cursor MCP integration test (CI外、手動実施)

### Phase 4
- Migration: **post-migration assertion** — `scripts/__tests__/migration-audit-actor-type.test.mjs` として実装 (実 DB 接続で `SELECT COUNT(*) FROM audit_logs WHERE actor_type IS NULL` = 0 を検証)
- Integration: SA access logs `actorType=SERVICE_ACCOUNT` with correct serviceAccountId
- Dashboard: actorType filter functional test

## Considerations & Constraints

### Security
1. **E2E encryption 維持**: MCP Gateway は暗号化済みデータのみ返す。平文アクセスは Phase 5 以降で検討
2. **Scope validation**: SA Token scope は enumerated allowlist で検証。CSV 直接受付禁止。forbidden scope (`vault:unlock`, `vault:setup`, `vault:reset`) は構造的に除外
3. **Auth dispatch safety**: prefix table 方式で未知プレフィックスのフォールスルーを遮断
4. **OAuth 2.1**: PKCE 必須 (`S256`)、client secret は SHA-256 (高エントロピーランダムトークン)。rate limit key は `client_id` 単位
5. **Rate limiting**: SA token / MCP token ごとに独立制限 (Redis based)
6. **Tenant isolation**: 全モデルに `tenantId`、既存の RLS パターン適用。JIT 承認で `withBypassRls()` 使用禁止
7. **Audit completeness**: 全非人間アクセスに `actorType` + `serviceAccountId` 記録
8. **SSRF prevention**: MCP ツールに URL 型引数なし。将来のツール拡張時は outbound allowlist 必須
9. **JIT atomicity**: 承認は single transaction + optimistic lock で二重承認防止
10. **McpAccessToken actor constraint**: CHECK (userId IS NOT NULL OR serviceAccountId IS NOT NULL)

### Constraints
- 全マイグレーションは加算的 (additive) — 既存テーブルへの変更は Phase 4 の AuditLog 2カラム追加のみ
- MCP Server は Next.js API route 内 — 別プロセスやコンテナの追加は不要。ただし MCP エンドポイントへのレート制限・リクエストサイズ制限で DoS リスクを軽減。将来的にトラフィック増加時はプロセス分離を検討
- Phase 3 の E2E 暗号化制約: エージェントは暗号化済みデータしか取得できない。自律的な平文アクセスは不可能

### Out of scope
- Shadow AI 検知 (ブラウザ拡張でのAIツール使用パターン検出) — Phase 4b として分離
- Delegated Decryption (人間が vault unlock 中に復号済みデータを MCP セッション内で共有) — Phase 5
- Endpoint credential discovery (デバイス上の .env / SSH 鍵スキャン) — 将来検討
