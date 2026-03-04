# SCIM トークン管理: チームスコープからテナントスコープへの移行

## Context

SCIM プロビジョニングはテナント単位の機能（IdP がテナントにユーザー/グループを同期）だが、
現在のトークン管理 API が `/api/teams/[teamId]/scim-tokens` にあり、チーム権限で認可されている。
SCIM v2 のデータ操作は既にテナント単位で正しいが、管理層に不整合がある。

Issue: #142

---

## Step 1: DB スキーマ変更 + マイグレーション

`ScimToken.teamId` と `ScimExternalMapping.teamId` を削除する。
`ScimGroupMapping.teamId` はチーム×ロールマッピングに必要なので残す。

### 1A: `prisma/schema/` — ScimToken

- `teamId` カラム、`team` リレーション、`@@index([teamId, revokedAt])` を削除
- `tenant` リレーション（Restrict）は維持

### 1B: `prisma/schema/` — ScimExternalMapping

- `teamId` カラム、`team` リレーションを削除
- ユニーク制約 `@@unique([tenantId, externalId, resourceType])` は変更なし

### 1C: Team モデル

- `scimTokens ScimToken[]` と `scimExternalMappings ScimExternalMapping[]` リレーション削除
- `scimGroupMappings ScimGroupMapping[]` は維持

### 1D: マイグレーション実行

マイグレーション前に `tenantId` が NULL のトークンがないことを確認し、必要に応じてバックフィル:

```sql
-- 事前チェック
SELECT COUNT(*) FROM scim_tokens WHERE tenant_id IS NULL;
-- 必要に応じてバックフィル
UPDATE scim_tokens st
SET tenant_id = t.tenant_id
FROM teams t
WHERE st.team_id = t.id AND st.tenant_id IS NULL;
```

```bash
npm run db:migrate
```

**注意**: `ScimToken` と `ScimExternalMapping` の `Cascade` delete（チーム削除時に自動削除）が消える。
テナントスコープではチーム削除でこれらが消えるのは不適切なので、これは意図通り。

---

## Step 2: テナント権限 + 新 API ルート

### 2A: `src/lib/constants/tenant-permission.ts`

`SCIM_MANAGE: "tenant:scim:manage"` 追加

### 2B: `src/lib/tenant-auth.ts`

`ROLE_PERMISSIONS` の OWNER/ADMIN に `SCIM_MANAGE` 追加

### 2C: 新規 `src/app/api/tenant/scim-tokens/route.ts` (GET/POST)

既存パターン（`/api/tenant/members/route.ts`）に準拠:

- `requireTenantPermission(userId, TENANT_PERMISSION.SCIM_MANAGE)` で認可
- `actor.tenantId` で直接クエリ（`resolveTeamTenantId` 不要）
- POST: トークン生成、10件/テナント上限チェック
- 監査ログ: `AUDIT_SCOPE.TENANT`

### 2D: 新規 `src/app/api/tenant/scim-tokens/[tokenId]/route.ts` (DELETE)

- テナント権限チェック + `token.tenantId === actor.tenantId` 検証
- `token.revokedAt !== null` の場合は 409 ALREADY_REVOKED を返す（重複操作防止）
- トークン未発見 or テナント不一致 → 404（IDOR 防止）
- 監査ログ: `AUDIT_SCOPE.TENANT`

### 2E: `src/lib/constants/api-path.ts`

```typescript
TENANT_SCIM_TOKENS: "/api/tenant/scim-tokens",

tenantScimTokens: () => API_PATH.TENANT_SCIM_TOKENS,
tenantScimTokenById: (tokenId: string) => `${API_PATH.TENANT_SCIM_TOKENS}/${tokenId}`,
```

### 2F: テスト

- `src/app/api/tenant/scim-tokens/route.test.ts` — 新規
  - GET: 未認証 → 401、権限不足 → 403、予期しないエラーの再 throw、トークン一覧正常系
  - POST: 未認証 → 401、権限不足 → 403、トークン上限超過 → 409、Cache-Control: no-store、expiresInDays バリデーション（0, 上限超過, null=永久）、無効 JSON → 400、正常系
- `src/app/api/tenant/scim-tokens/[tokenId]/route.test.ts` — 新規
  - DELETE: 未認証 → 401、権限不足 → 403、トークン未発見 → 404、テナント不一致 → 404（IDOR 防止）、既に失効済み → 409、正常系
- `src/lib/tenant-auth.test.ts` — SCIM_MANAGE 権限テスト追加
  - OWNER/ADMIN has SCIM_MANAGE → true、MEMBER has no SCIM_MANAGE → false
  - requireTenantPermission: OWNER/ADMIN returns membership、MEMBER throws 403
- `src/lib/constants/api-path.test.ts` — 新パステスト追加
  - `API_PATH.TENANT_SCIM_TOKENS` 定数値、`tenantScimTokens()` / `tenantScimTokenById(tokenId)` ヘルパー

---

## Step 3: UI をテナントスコープに変更

### 3A: `src/components/settings/scim-provisioning-card.tsx`

- チーム一覧取得 + チームロールフィルタ を削除
- `useTenantRole()` フックで `isAdmin` 判定（既存フック再利用）
- チーム選択 UI を削除
- `ScimTokenManager` の Props から `teamId` を削除

### 3B: `src/components/team/team-scim-token-manager.tsx`

- Props: `{ teamId: string; locale: string }` → `{ locale: string }`
- API パス: `apiPath.teamScimTokens(teamId)` → `apiPath.tenantScimTokens()`
- API パス: `apiPath.teamScimTokenById(teamId, tokenId)` → `apiPath.tenantScimTokenById(tokenId)`

---

## Step 4: `validateScimToken()` から teamId 削除

### 4A: `src/lib/scim-token.ts`

- `ValidatedScimToken` から `teamId` フィールド削除
- DB select から `teamId`, `team` リレーション削除
- `tenantId` 取得: `token.tenantId` のみ（フォールバック `token.team?.tenantId` 削除）
- 戻り値から `teamId` 削除

### 4B: SCIM v2 API — Users 系

対象: `src/app/api/scim/v2/Users/route.ts`, `src/app/api/scim/v2/Users/[id]/route.ts`

- `const { teamId: scopedTeamId, tenantId } = result.data` → `const { tenantId } = result.data`
- `ScimExternalMapping` 作成の `teamId: scopedTeamId` 削除（Step 1 で DB カラム削除済）
- 監査ログ: `scope: AUDIT_SCOPE.TENANT`, `teamId` → `tenantId`

### 4C: SCIM v2 API — Groups POST

対象: `src/app/api/scim/v2/Groups/route.ts`

現在: `scopedTeamId` でチーム解決 → `parseRoleFromDisplayName(displayName, team?.slug)`

変更後: `displayName` から slug を抽出してチーム解決:

```typescript
const { tenantId } = result.data;
// displayName = "<teamSlug>:<ROLE>"
const separator = displayName.indexOf(":");
if (separator < 1) return scimError(400, "...");
const slugPart = displayName.slice(0, separator).trim();
const team = await prisma.team.findFirst({
  where: { slug: slugPart, tenantId },
  select: { id: true, slug: true },
});
```

POST ハンドラ内の全 `scopedTeamId` 参照を `team.id` に置換:

- `existing.teamId !== scopedTeamId` → `existing.teamId !== team.id`
- `teamId: scopedTeamId`（create） → `teamId: team.id`
- `loadGroupMembers(scopedTeamId, matchedRole)` → `loadGroupMembers(team.id, matchedRole)`

これにより 1 トークンで複数チームのグループマッピングが可能になる（より柔軟）。

### 4D: SCIM v2 API — Groups PUT/PATCH

対象: `src/app/api/scim/v2/Groups/[id]/route.ts`

- destructuring: `const { teamId: scopedTeamId, tenantId, auditUserId } = result.data` → `const { tenantId, auditUserId } = result.data`
- `mapping.teamId ?? scopedTeamId` → `mapping.teamId`（ScimGroupMapping.teamId は NOT NULL）
- 監査ログ: `teamId: mapping.teamId`（既存マッピングのチームID）に変更

### 4E: テスト更新

- `src/lib/scim-token.test.ts`:
  - `makeToken` ヘルパーから `teamId`/`team` フィールド削除
  - DB select の期待値から `teamId`/`team` 削除
  - 成功ケースで `expect(result.data).not.toHaveProperty("teamId")` 追加
  - `tenantId` フォールバックテスト → フォールバック削除後の挙動に更新
- 全 SCIM v2 テストの `SCIM_TOKEN_DATA` から `teamId` 削除（4ファイル共通）
- `src/app/api/scim/v2/Users/route.test.ts`:
  - `scopedTeamId` モック削除
  - `scimExternalMapping.create` 引数で `teamId` が含まれないことをアサート
  - `logAudit` 呼び出しで `scope: AUDIT_SCOPE.TENANT` を検証
- `src/app/api/scim/v2/Users/[id]/route.test.ts` — 同上
- `src/app/api/scim/v2/Groups/route.test.ts`:
  - チーム slug 解決テスト追加: `:` なし → 400、slug 空 → 400、存在しない slug → エラー、ロール不正 → 400
  - 異なる slug のチームへのグループ作成成功ケース
  - `logAudit` の `scope: AUDIT_SCOPE.TENANT` 検証
- `src/app/api/scim/v2/Groups/[id]/route.test.ts`:
  - `scopedTeamId` 削除
  - `logAudit` の `scope` と `teamId: mapping.teamId` 検証

---

## Step 5: 旧 API 削除 + クリーンアップ

### 5A: ファイル削除

- `src/app/api/teams/[teamId]/scim-tokens/route.ts` + `.test.ts`
- `src/app/api/teams/[teamId]/scim-tokens/[tokenId]/route.ts` + `.test.ts`

### 5B: 定数クリーンアップ

- `api-path.ts`: `teamScimTokens`, `teamScimTokenById` 削除
- `team-permission.ts`: `SCIM_MANAGE` 削除（テナント権限に移行済）
- `api-path.test.ts`: 旧パステスト削除

### 5C: 監査ログ定数

- `AUDIT_ACTION_GROUPS_TENANT` に SCIM グループを追加:

```typescript
[AUDIT_ACTION_GROUP.SCIM]: [
  AUDIT_ACTION.SCIM_TOKEN_CREATE,
  AUDIT_ACTION.SCIM_TOKEN_REVOKE,
  AUDIT_ACTION.SCIM_USER_CREATE,
  AUDIT_ACTION.SCIM_USER_UPDATE,
  AUDIT_ACTION.SCIM_USER_DEACTIVATE,
  AUDIT_ACTION.SCIM_USER_REACTIVATE,
  AUDIT_ACTION.SCIM_USER_DELETE,
  AUDIT_ACTION.SCIM_GROUP_UPDATE,
],
```

- `AUDIT_ACTION_GROUPS_TEAM` の SCIM グループは**残す**（過去ログの表示互換性 + チーム Webhook 配信のため）

---

## 検証

### 自動テスト

- `npm test` 全パス
- `npm run lint` エラーなし
- `npm run build` 成功

### 手動確認

- テナント OWNER/ADMIN: 設定 > テナントタブ > SCIM トークン作成/削除
- テナント MEMBER: SCIM セクション非表示
- SCIM v2 API: 既存トークンでユーザー/グループ CRUD が動作
- Groups POST: `<teamSlug>:<ROLE>` 形式で正しくチーム解決
