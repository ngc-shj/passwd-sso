# B-1: SCIM 2.0 Provisioning — Implementation Plan

## Context

passwd-sso の Organization 機能には手動招待しかなく、エンタープライズ IdP (Okta, Azure AD, Google Workspace) からの自動プロビジョニングができない。SCIM 2.0 Service Provider を実装し、ユーザー/グループの自動同期を可能にする。P1 唯一の未完了項目。

## Design Decisions

| 決定 | 選択 | 理由 |
|------|------|------|
| URL 構造 | `/api/scim/v2/...` | org は Bearer トークンで識別 (パスパラメータ不要) |
| トークン | 新規 `ScimToken` モデル | ExtensionToken は user-scoped / 短命。SCIM は org-scoped / 長命 |
| User マッピング | User + OrgMember | SCIM User 作成 = User find/create + OrgMember 追加 |
| Group マッピング | OrgRole ベース (MVP) + 決定論的 UUID | ADMIN / MEMBER / VIEWER の3グループ。`uuid5(orgId + roleName)` で IdP 互換 UUID 生成 |
| 非活性化 | `OrgMember.deactivatedAt` ソフトデリート | IdP の active=false → 再有効化可能。監査証跡を保持 |
| Content-Type | `application/scim+json` 返却、`application/json` も受理 | RFC 7644 準拠 + 互換性 |
| proxy.ts | 変更なし | `/api/scim/*` は session-required リストに含まれず既に通過。ルートハンドラで SCIM トークン検証 |
| 監査 userId | `ScimToken.createdById ?? SCIM_SYSTEM_USER_ID` | createdById が null (作成者脱退済み) の場合はシステム定数にフォールバック |
| User 属性更新スコープ | 初回プロビジョニング時のみ User テーブル更新 | マルチ org で他 org への副作用を防止。以降は OrgMember 属性のみ |
| orgId 識別 | トークンの orgId を唯一の識別子として使用 | URL パラメータとの不一致による IDOR を防止 |
| SCIM 属性マッピング | `userName` → `User.email`, `name.formatted` → `User.name` | MVP では `name.givenName`/`name.familyName` フィルタは非サポート (400 返却)。User.name は単一文字列 |
| userName 正規化 | `toLowerCase()` で正規化してから DB 操作 | PostgreSQL は case-sensitive。大文字/小文字で別 User が作成されることを防止 |
| scimManaged メンバーの手動招待 | `SCIM_MANAGED_MEMBER` エラーで拒否 | IdP との状態フリップフロップを防止。IdP 側で再有効化を案内 |

---

## Phase 1: Foundation (ライブラリ層)

### 1-1. Prisma schema 変更

**`prisma/schema.prisma`**

新規モデル:

```prisma
model ScimToken {
  id          String    @id @default(cuid())
  orgId       String    @map("org_id")
  tokenHash   String    @unique @map("token_hash") @db.VarChar(64)
  description String?   @db.VarChar(255)
  expiresAt   DateTime? @map("expires_at")  // デフォルト1年、UI で選択可能
  createdAt   DateTime  @default(now()) @map("created_at")
  revokedAt   DateTime? @map("revoked_at")
  lastUsedAt  DateTime? @map("last_used_at")
  createdById String?   @map("created_by_id")  // nullable: onDelete: SetNull

  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  createdBy User?        @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@index([orgId, revokedAt])
  @@map("scim_tokens")
}

model ScimExternalMapping {
  id           String   @id @default(cuid())
  orgId        String   @map("org_id")
  externalId   String   @map("external_id")
  resourceType String   @map("resource_type") @db.VarChar(20)  // "User" | "Group"
  internalId   String   @map("internal_id")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, externalId, resourceType])
  @@unique([orgId, internalId, resourceType])
  @@map("scim_external_mappings")
}
```

**onDelete ポリシー**:

- `ScimToken.org`: `Cascade` — org 削除時はトークンも不要
- `ScimToken.createdBy`: `SetNull` — `createdById` は `String?` (nullable)。トークン作成者が org を脱退してもトークンは存続。監査ログでは `createdById ?? SCIM_SYSTEM_USER_ID` にフォールバック
- `ScimExternalMapping.org`: `Cascade` — org 削除時はマッピングも不要

既存モデル変更:

- `OrgMember`: `deactivatedAt DateTime?` + `scimManaged Boolean @default(false)` 追加
- `Organization`: `scimTokens ScimToken[]` + `scimExternalMappings ScimExternalMapping[]` relation 追加
- `User`: `createdScimTokens ScimToken[]` relation 追加
- `AuditAction` enum: `SCIM_TOKEN_CREATE`, `SCIM_TOKEN_REVOKE`, `SCIM_USER_CREATE`, `SCIM_USER_UPDATE`, `SCIM_USER_DEACTIVATE`, `SCIM_USER_REACTIVATE`, `SCIM_USER_DELETE`, `SCIM_GROUP_UPDATE` 追加 (8件)

マイグレーション: `npm run db:migrate`

### 1-2. SCIM トークン検証

**新規: `src/lib/scim-token.ts`** (extension-token.ts パターン踏襲)

```typescript
/** SCIM 操作の監査ログで userId が null にならないためのフォールバック定数 */
const SCIM_SYSTEM_USER_ID = "system:scim";

export interface ValidatedScimToken {
  tokenId: string;
  orgId: string;
  createdById: string | null;  // nullable (createdBy が SetNull の場合)
  auditUserId: string;         // createdById ?? SCIM_SYSTEM_USER_ID (監査ログ用、常に non-null)
}
export async function validateScimToken(req: NextRequest): Promise<ScimTokenValidationResult>
// Bearer ヘッダー抽出 → SHA-256 ハッシュ → DB lookup → revokedAt チェック → expiresAt チェック
// → lastUsedAt 更新 (best-effort, 前回更新から5分以内は skip)
// → auditUserId を createdById ?? SCIM_SYSTEM_USER_ID で解決
```

**lastUsedAt 間引き**: `token.lastUsedAt` と現在時刻の差が5分未満の場合、DB 更新をスキップ。IdP の高頻度同期 (5分毎) による大量更新を防止。

### 1-3. SCIM ライブラリモジュール群

**新規: `src/lib/scim/` ディレクトリ**

| ファイル | 責務 |
|---------|------|
| `response.ts` | `scimResponse()`, `scimError()`, `scimListResponse()` — Content-Type: application/scim+json。429 も SCIM エラー形式 (`urn:ietf:params:scim:api:messages:2.0:Error`) で返却 |
| `serializers.ts` | `userToScimUser()`, `roleToScimGroup()` — DB → SCIM リソース変換。`deactivatedAt` 有無 → `active` true/false 変換含む。`User.name` → `name.formatted` マッピング |
| `filter-parser.ts` | `parseScimFilter()`, `filterToPrismaWhere()` — MVP: `eq`, `co`, `sw`, `and`, `or`。**filter 文字列は最大256文字に制限** (ReDoS 防止)。**明示的なホワイトリスト**: `ALLOWED_FILTER_ATTRIBUTES = new Set(["userName", "active", "externalId"])`。リストにない属性は即座に 400 返却 |
| `patch-parser.ts` | `parsePatchOperations()` — SCIM PATCH `Operations` 配列パース。純粋関数として実装、`ORG_ROLE_VALUES` 定数のみに依存 (@prisma/client 非依存) |
| `validations.ts` | Zod スキーマ: `scimUserSchema` (`.transform(v => ({ ...v, userName: v.userName.toLowerCase() }))` で email 正規化), `scimPatchOpSchema`, `scimGroupSchema` |
| `token-utils.ts` | `generateScimToken()` — 32バイト (256-bit) エントロピー + `scim_` プレフィックス付与。`validateScimToken()` 側でプレフィックス検証 |
| `rate-limit.ts` | `scimLimiter` — 既存の `createRateLimiter({ windowMs: 60_000, max: 200 })` を再利用。キーは `rl:scim:${orgId}` プレフィックス付き |

### 1-4. 定数・エラーコード更新

| ファイル | 変更 |
|---------|------|
| `src/lib/constants/api-path.ts` | `SCIM_V2: "/api/scim/v2"`, `orgScimTokens()`, `orgScimTokenById()` 追加 |
| `src/lib/constants/audit.ts` | 8 SCIM アクション追加 (`SCIM_USER_DELETE` 含む) + `AUDIT_ACTION_GROUP.SCIM` + groups 登録 |
| `src/lib/constants/audit-target.ts` | `SCIM_TOKEN`, `SCIM_EXTERNAL_MAPPING` 追加 |
| `src/lib/constants/org-permission.ts` | `SCIM_MANAGE: "scim:manage"` 追加 |
| `src/lib/org-auth.ts` | OWNER + ADMIN に `SCIM_MANAGE` 追加 |
| `src/lib/api-error-codes.ts` | SCIM 系エラーコード 8 件 (`SCIM_MANAGED_MEMBER` 含む) + i18n マッピング追加 |

### 1-5. OrgMember deactivatedAt 対応

`getOrgMembership()` を `findFirst` に変更する理由: Prisma の `findUnique` は `where` 句に unique index 外のフィールド (`deactivatedAt`) を含められないため。`@@unique([orgId, userId])` 制約は維持 (同一 org + user の組み合わせは1件のみ)。

**deactivatedAt フィルタ追加チェックリスト**:

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `src/lib/org-auth.ts` | `getOrgMembership()` を `findFirst({ where: { orgId, userId, deactivatedAt: null } })` に変更 |
| 2 | `src/app/api/orgs/[orgId]/members/route.ts` | findMany に `deactivatedAt: null` 追加 |
| 3 | `src/app/api/orgs/route.ts` | org 一覧の `findMany({ where: { userId } })` に `deactivatedAt: null` 追加 |
| 4 | `src/app/api/orgs/favorites/route.ts` | roleMap 構築の findMany に `deactivatedAt: null` 追加 |
| 5 | `src/app/api/orgs/archived/route.ts` | findMany に `deactivatedAt: null` 追加 |
| 6 | `src/app/api/orgs/trash/route.ts` | findMany に `deactivatedAt: null` 追加 |
| 7 | `src/app/api/orgs/pending-key-distributions/route.ts` | admin membership 取得 + pending members の両方に `deactivatedAt: null` 追加 |
| 8 | `src/app/api/orgs/[orgId]/member-key/route.ts` | findUnique → findFirst + `deactivatedAt: null` |
| 9 | `src/app/api/orgs/[orgId]/members/[memberId]/route.ts` | GET/PATCH/DELETE の findUnique に deactivatedAt チェック追加 |
| 10 | `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts` | L36 (tx外) findUnique → findFirst + `deactivatedAt: null`。**L88 (tx内) findUnique にも `deactivatedAt: null` を追加** (TOCTOU: tx外チェック後に SCIM deactivate が走る可能性) |
| 11 | `src/app/api/orgs/[orgId]/rotate-key/route.ts` | **tx 内** の `findMany({ where: { orgId } })` に `deactivatedAt: null` 追加 (deactivated メンバーへの鍵再暗号化を防止) |
| 12 | `src/app/api/orgs/invitations/accept/route.ts` | `findUnique` → `findFirst`。アクティブメンバー存在 → `ALREADY_A_MEMBER`。deactivated メンバー存在 → **scimManaged チェック**: `scimManaged: true` なら `SCIM_MANAGED_MEMBER` エラー (IdP で再有効化を案内)、`scimManaged: false` なら `deactivatedAt: null` にリセットして再参加許可。`upsert` の `update` 句に `deactivatedAt: null, scimManaged: false` 追加 |
| 13 | `src/app/api/orgs/[orgId]/invitations/route.ts` | POST の既存メンバーチェック: deactivated メンバー (`deactivatedAt !== null`) に対しては `ALREADY_A_MEMBER` を返さず招待作成を許可。ただし `scimManaged: true` の場合は `SCIM_MANAGED_MEMBER` エラー |

---

## Phase 2: SCIM API ルート

### 2-1. Discovery エンドポイント (認証要)

| ルート | ファイル |
|-------|---------|
| GET `/api/scim/v2/ServiceProviderConfig` | `src/app/api/scim/v2/ServiceProviderConfig/route.ts` |
| GET `/api/scim/v2/ResourceTypes` | `src/app/api/scim/v2/ResourceTypes/route.ts` |
| GET `/api/scim/v2/Schemas` | `src/app/api/scim/v2/Schemas/route.ts` |

### 2-2. Users エンドポイント

**`src/app/api/scim/v2/Users/route.ts`**

- **GET** — ユーザー一覧 (filter, pagination: startIndex/count)
- **POST** — ユーザー作成 (User find/create + OrgMember 追加 + ScimExternalMapping)。**`$transaction` でアトミック化**。**userName を `toLowerCase()` で正規化**

**`src/app/api/scim/v2/Users/[id]/route.ts`**

- **GET** — 単一ユーザー取得
- **PUT** — ユーザー全置換更新 (OrgMember 属性のみ。User テーブルは更新しない)
- **PATCH** — 部分更新 (active=false で deactivate, **OWNER 保護チェック含む**)
- **DELETE** — OrgMember ハードデリート + **`$transaction` 内で OrgMemberKey + ScimExternalMapping も同時削除**

User 作成フロー:

1. SCIM token 検証 → orgId + auditUserId 取得
2. userName (email) を `toLowerCase()` で正規化後、User find/create (User テーブル更新は User 未存在時のみ)
3. OrgMember 存在チェック (deactivated なら reactivate, active なら 409)
4. OrgMember 作成: `role: MEMBER`, `scimManaged: true`, `keyDistributed: false`
5. ScimExternalMapping 作成 (`@@unique` 制約で冪等性保証、既存なら 409)
6. 全操作を `$transaction` でアトミック化
7. 監査ログ: `SCIM_USER_CREATE` (userId = `auditUserId`)
8. 201 + SCIM User リソース返却

User DELETE フロー:

1. SCIM token 検証 → orgId + auditUserId 取得
2. ScimExternalMapping で SCIM ID → internalId (OrgMember.userId) を解決
3. OWNER 保護チェック
4. `$transaction` 内で OrgMemberKey (orgId + userId) → ScimExternalMapping → OrgMember を削除
5. 監査ログ: `SCIM_USER_DELETE` (userId = `auditUserId`)
6. 204 返却

**OWNER 保護**: SCIM で org OWNER の deactivate/delete を禁止 → `SCIM_OWNER_PROTECTED` エラー。**PATCH active=false パスにも同保護を適用**。

**サポートする PATCH op**:

- Users: `replace` (active, name.givenName, name.familyName), `add` (同左)
- 未対応 op には RFC 7644 §3.12 に従い 400 返却

**SCIM User 属性マッピング**:

| SCIM 属性 | DB フィールド | 備考 |
|-----------|-------------|------|
| `userName` | `User.email` | 必須。一意識別子。`toLowerCase()` 正規化 |
| `name.formatted` | `User.name` | 表示名 |
| `name.givenName` | — | MVP 非サポート (フィルタ時 400) |
| `name.familyName` | — | MVP 非サポート (フィルタ時 400) |
| `active` | `OrgMember.deactivatedAt` の有無 | true = null, false = Date |
| `externalId` | `ScimExternalMapping.externalId` | IdP 側の識別子 |

### 2-3. Groups エンドポイント

**`src/app/api/scim/v2/Groups/route.ts`**

- **GET** — グループ一覧 (ADMIN, MEMBER, VIEWER の3グループ。各グループに決定論的 UUID を `uuid5(orgId + roleName)` で生成、`displayName` は人間可読形式)
- **POST** — グループ作成 (外部マッピング登録のみ、ロールは固定)

**`src/app/api/scim/v2/Groups/[id]/route.ts`**

- **GET** — グループ + メンバー取得
- **PATCH** — メンバー追加/削除 (OrgMember role 変更)。**OWNER ロールへの追加を明示的に禁止**。**OWNER メンバーのロール変更 (降格含む) もブロック** (`CANNOT_CHANGE_OWNER_ROLE` と同等の保護)
- **PUT** — メンバー全置換。**OWNER ロールへの追加を明示的に禁止**。**OWNER メンバーのロール変更 (降格含む) もブロック**
- **DELETE** — 405 (ロールベースグループは削除不可)

**サポートする Groups PATCH op**:

- `add members` — メンバーをグループ (ロール) に追加。OWNER メンバーの場合はブロック
- `remove members` — メンバーをグループから削除。OWNER メンバーの場合はブロック (デフォルト MEMBER への降格も禁止)
- 未対応 op には RFC 7644 §3.12 に従い 400 返却

---

## Phase 3: Proxy 統合

**変更なし。**

`/api/scim/*` は既存の session-required リスト (`/api/passwords`, `/api/tags`, `/api/vault`, `/api/orgs`) に含まれないため、`src/proxy.ts` の `handleApiAuth()` を通過時に NextResponse.next() が返る。SCIM エンドポイントのルートハンドラが `validateScimToken()` を直接呼び出して認証する。

proxy.ts に変更を加えないことで:

- Bearer なしリクエストの意図しない通過を防止
- 実装がシンプルに

---

## Phase 4: トークン管理 API

**`src/app/api/orgs/[orgId]/scim-tokens/route.ts`** (session 認証, OWNER/ADMIN)

- **GET** — トークン一覧 (description, createdAt, lastUsedAt, expiresAt, revokedAt)
- **POST** — トークン生成 (plaintext は 1 回だけ返却)。expiresAt デフォルト1年、リクエストで指定可能

**`src/app/api/orgs/[orgId]/scim-tokens/[tokenId]/route.ts`**

- **DELETE** — トークン失効。**`token.orgId === orgId` を検証** (管理 API 側の IDOR 防止。既存 `members/[memberId]/route.ts` の `target.orgId !== orgId` パターンに準拠)

---

## Phase 5: UI + i18n

### 5-1. Org Settings に SCIM セクション追加

**`src/app/[locale]/dashboard/orgs/[orgId]/settings/page.tsx`** — OWNER/ADMIN のみ表示

**新規: `src/components/org/scim-token-manager.tsx`**

- アクティブ/失効済みトークン一覧 (有効期限表示含む)
- トークン生成ボタン → ダイアログで plaintext 表示 (コピーボタン付き)。有効期限選択 (90日/180日/1年/無期限)
- 「無期限」選択時にセキュリティリスク警告を表示
- SCIM エンドポイント URL 表示 (`{origin}/api/scim/v2`)
- トークン失効ボタン (確認ダイアログ)
- `scimManaged` バッジをメンバー一覧に表示

### 5-2. i18n

6 ファイルに SCIM 関連キー追加:

- `messages/{en,ja}/Org.json` — UI テキスト (SCIM_MANAGED_MEMBER エラーメッセージ含む)
- `messages/{en,ja}/ApiErrors.json` — エラーメッセージ
- `messages/{en,ja}/AuditLog.json` — 監査ログアクション名

---

## 新規ファイル一覧

| # | ファイル | 用途 |
|---|---------|------|
| 1 | `src/lib/scim-token.ts` | SCIM トークン検証 |
| 2 | `src/lib/scim/response.ts` | SCIM レスポンスヘルパー |
| 3 | `src/lib/scim/serializers.ts` | DB → SCIM リソース変換 |
| 4 | `src/lib/scim/filter-parser.ts` | SCIM フィルタパーサー |
| 5 | `src/lib/scim/patch-parser.ts` | SCIM PATCH パーサー |
| 6 | `src/lib/scim/validations.ts` | Zod スキーマ |
| 7 | `src/lib/scim/rate-limit.ts` | レートリミッター |
| 8 | `src/app/api/scim/v2/ServiceProviderConfig/route.ts` | Discovery |
| 9 | `src/app/api/scim/v2/ResourceTypes/route.ts` | Discovery |
| 10 | `src/app/api/scim/v2/Schemas/route.ts` | Discovery |
| 11 | `src/app/api/scim/v2/Users/route.ts` | Users CRUD |
| 12 | `src/app/api/scim/v2/Users/[id]/route.ts` | Users CRUD |
| 13 | `src/app/api/scim/v2/Groups/route.ts` | Groups CRUD |
| 14 | `src/app/api/scim/v2/Groups/[id]/route.ts` | Groups CRUD |
| 15 | `src/app/api/orgs/[orgId]/scim-tokens/route.ts` | トークン管理 |
| 16 | `src/app/api/orgs/[orgId]/scim-tokens/[tokenId]/route.ts` | トークン失効 |
| 17 | `src/components/org/scim-token-manager.tsx` | トークン管理 UI |

## 変更ファイル一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `prisma/schema.prisma` | 新モデル2つ + OrgMember 変更 + AuditAction enum 追加 (8件) |
| 2 | `src/lib/org-auth.ts` | SCIM_MANAGE 権限 + `getOrgMembership()` を `findFirst` に変更 + deactivatedAt チェック |
| 3 | `src/lib/constants/api-path.ts` | SCIM パス定数 |
| 4 | `src/lib/constants/audit.ts` | 8 SCIM 監査アクション (`SCIM_USER_DELETE` 含む) |
| 5 | `src/lib/constants/audit-target.ts` | SCIM ターゲットタイプ |
| 6 | `src/lib/constants/org-permission.ts` | SCIM_MANAGE |
| 7 | `src/lib/api-error-codes.ts` | SCIM エラーコード 8 件 (`SCIM_MANAGED_MEMBER` 含む) |
| 8 | `src/app/api/orgs/[orgId]/members/route.ts` | deactivatedAt フィルタ |
| 9 | `src/app/api/orgs/route.ts` | deactivatedAt フィルタ |
| 10 | `src/app/api/orgs/favorites/route.ts` | deactivatedAt フィルタ |
| 11 | `src/app/api/orgs/archived/route.ts` | deactivatedAt フィルタ |
| 12 | `src/app/api/orgs/trash/route.ts` | deactivatedAt フィルタ |
| 13 | `src/app/api/orgs/pending-key-distributions/route.ts` | deactivatedAt フィルタ (2箇所) |
| 14 | `src/app/api/orgs/[orgId]/member-key/route.ts` | deactivatedAt フィルタ |
| 15 | `src/app/api/orgs/[orgId]/members/[memberId]/route.ts` | deactivatedAt フィルタ |
| 16 | `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts` | deactivatedAt フィルタ |
| 17 | `src/app/api/orgs/[orgId]/rotate-key/route.ts` | tx 内 findMany に deactivatedAt フィルタ |
| 18 | `src/app/api/orgs/invitations/accept/route.ts` | findUnique → findFirst + deactivated メンバー再参加フロー + scimManaged チェック |
| 19 | `src/app/api/orgs/[orgId]/invitations/route.ts` | POST の既存メンバーチェックに deactivatedAt + scimManaged 考慮 |
| 20 | `src/app/[locale]/dashboard/orgs/[orgId]/settings/page.tsx` | SCIM セクション追加 |
| 21 | `messages/{en,ja}/Org.json` | i18n キー |
| 22 | `messages/{en,ja}/ApiErrors.json` | i18n キー |
| 23 | `messages/{en,ja}/AuditLog.json` | i18n キー |
| 24 | `vitest.config.ts` | coverage.include に `src/lib/scim-token.ts` + `src/lib/scim/*.ts` 追加 (SCIM ルートハンドラは既存 `src/app/api/**/*.ts` で暗黙包含) |
| 25 | `src/__tests__/helpers/fixtures.ts` | `makeOrgMember()` に `deactivatedAt`/`scimManaged`/`keyDistributed` 追加 + `makeScimToken()`/`makeScimExternalMapping()` 追加 |
| 26 | `src/__tests__/helpers/mock-org-auth.ts` | `MockMembership` に `deactivatedAt`/`scimManaged` 追加 |
| 27 | `src/lib/org-auth.test.ts` | `findUnique` → `findFirst` モック書き換え + `deactivatedAt: null` assertion + `SCIM_MANAGE` 権限テスト |

---

## テスト戦略

### ユニットテスト (各 `*.test.ts`)

| テストファイル | カバレッジ |
|-------------|----------|
| `src/lib/scim-token.test.ts` | トークン検証: valid / revoked / expired / missing / **createdById: null (作成者脱退済み)** → auditUserId = SCIM_SYSTEM_USER_ID / **`scim_` プレフィックス不一致 → 401** (プレフィックスなし・別プレフィックスの両方)。**lastUsedAt 間引きテスト** (`vi.useFakeTimers()` + `vi.setSystemTime()` で時刻制御): 5分以上前→更新、5分以内→スキップ、null(初回)→更新。vi.hoisted + vi.mock パターン |
| `src/lib/scim/token-utils.test.ts` | `generateScimToken()` の出力形式検証: `scim_` プレフィックス存在、トークン長 (プレフィックス + 64文字hex = 70文字)、文字セット (hex) |
| `src/lib/scim/filter-parser.test.ts` | フィルタ: eq, co, sw, and, or, invalid。**インジェクション境界値テスト**: embedded quotes, unknown attributes, 256文字超入力。**ホワイトリスト外属性 → 400**。**非サポート属性 (name.givenName) → 400** |
| `src/lib/scim/patch-parser.test.ts` | PATCH: add/replace/remove, path 検証。@prisma/client 非依存を確認 |
| `src/lib/scim/serializers.test.ts` | User/Group シリアライズ。**deactivatedAt → active:false 変換テスト含む**。User.name → name.formatted マッピング |
| `src/lib/scim/response.test.ts` | Content-Type (`application/scim+json`), ListResponse, error format, **429 SCIM エラー形式** |

### ルートハンドラテスト

| テストファイル | カバレッジ |
|-------------|----------|
| `src/app/api/scim/v2/ServiceProviderConfig/route.test.ts` | Content-Type, schemas フィールド検証 |
| `src/app/api/scim/v2/ResourceTypes/route.test.ts` | レスポンス構造、Content-Type 検証 |
| `src/app/api/scim/v2/Schemas/route.test.ts` | User/Group スキーマ返却検証 |
| `src/app/api/scim/v2/Users/route.test.ts` | GET (list/filter/pagination), POST (create/duplicate/invalid/**email 正規化**)。**`application/scim+json` と `application/json` 両方の受理テスト** |
| `src/app/api/scim/v2/Users/[id]/route.test.ts` | GET, PUT, PATCH (active toggle, OWNER 保護), DELETE (**OrgMemberKey + ScimExternalMapping 同時削除**) |
| `src/app/api/scim/v2/Groups/route.test.ts` | GET list, POST |
| `src/app/api/scim/v2/Groups/[id]/route.test.ts` | GET, PATCH (member add/remove, **OWNER グループへの add ブロック**, **OWNER メンバーの remove ブロック (降格禁止)**, **PUT で OWNER メンバーのロール変更ブロック**) |
| `src/app/api/orgs/[orgId]/scim-tokens/route.test.ts` | CRUD ライフサイクル, 認証チェック |
| `src/app/api/orgs/[orgId]/scim-tokens/[tokenId]/route.test.ts` | トークン失効テスト, **orgId 不一致 IDOR テスト** |

### 既存テスト更新

| テストファイル | 変更内容 |
|-------------|---------|
| `src/lib/org-auth.test.ts` | `findUnique` → `findFirst` モック書き換え + `deactivatedAt: null` assertion + **SCIM_MANAGE 権限テスト (OWNER/ADMIN: true, MEMBER/VIEWER: false)** |
| `src/app/api/orgs/invitations/accept/route.test.ts` | **deactivated メンバー再参加テスト**: deactivated + scimManaged:false → 再参加成功、deactivated + scimManaged:true → SCIM_MANAGED_MEMBER エラー |
| `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts` | **tx内 deactivatedAt チェックテスト**: tx外チェック通過後に deactivated されたメンバーへの鍵配布が tx内で拒否されること (TOCTOU 防止) |
| 既存ルートハンドラテスト (チェックリスト対応6ファイル) | `findMany`/`findFirst` の `where` 句に `deactivatedAt: null` が含まれることを `toHaveBeenCalledWith` で assertion |

### モックパターン

全 SCIM テストで統一: `vi.hoisted(() => ({ ... }))` + `vi.mock()` パターン。rate-limit.ts のモックパスは `@/lib/scim/rate-limit` を明示的に指定し、既存の `@/lib/rate-limit` モックとの混在を防止。

### 検証手順

1. `npm run db:migrate` — マイグレーション成功
2. `npx vitest run` — 全テスト通過
3. `npm run build` — ビルド成功
4. `npm run lint` — lint 通過
5. Okta SCIM コネクタで手動テスト (assign → OrgMember 作成, unassign → deactivate)

### CI 対応

- `vitest.config.ts` の `coverage.include` に `src/lib/scim-token.ts` + `src/lib/scim/*.ts` パス追加 (SCIM ルートハンドラは既存の `src/app/api/**/*.ts` で暗黙包含)
- CI の `e2e` ジョブ (PostgreSQL サービスあり) で `prisma migrate deploy` は既に実行済み。`app-ci` ジョブはモックベースのユニットテストのため `migrate deploy` 不要 (`prisma generate` のみ)

---

## リスクと対策

| リスク | 対策 |
|-------|------|
| SCIM トークン漏洩 | SHA-256 ハッシュ保存、plaintext 1 回表示のみ、失効可能、レート制限、**expiresAt デフォルト1年**、無期限選択時 UI 警告 |
| フィルタインジェクション | トークナイザーベースパーサー + Prisma パラメータ化クエリ + **filter 最大256文字制限** + **属性名ホワイトリスト** |
| OWNER の意図しない削除/非活性化/降格 | Users: OWNER の deactivate/delete をブロック。Groups: **OWNER ロールへの追加も、OWNER メンバーの降格/削除も全てブロック** |
| 既存クエリの deactivatedAt 漏れ | **13箇所のチェックリスト** (Phase 1-5) で網羅。特に rotate-key tx 内と pending-key-distributions を優先 |
| E2E 鍵配布ギャップ | SCIM は `keyDistributed: false` で作成、管理者が Web UI で配布 |
| マルチ org User 属性の副作用 | User テーブル更新は初回プロビジョニング時 (User 未存在) のみ。以降は OrgMember 属性のみ |
| IdP at-least-once 配信で重複 POST | `@@unique([orgId, externalId, resourceType])` + `$transaction` で冪等性保証 |
| IDOR (orgId 不一致) | SCIM API: `validateScimToken()` の orgId のみ使用。管理 API: `token.orgId === orgId` 検証 |
| lastUsedAt 高頻度更新 | 前回更新から5分以内は skip する間引き処理 |
| DELETE 時のデータ孤児 | `$transaction` 内で OrgMemberKey + ScimExternalMapping + OrgMember を同時削除 |
| トークン作成者の脱退 | `ScimToken.createdBy` は `onDelete: SetNull`。トークンは存続。監査 userId は `auditUserId` (フォールバック付き) |
| email ケース混在 | userName を `toLowerCase()` で正規化してから DB 操作 |
| scimManaged メンバーの手動招待 | `SCIM_MANAGED_MEMBER` エラーで拒否、IdP での再有効化を案内 |
