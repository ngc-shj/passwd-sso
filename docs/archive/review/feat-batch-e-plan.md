# Tenant-level Vault Reset + Revoke + History UI

## Context

Vault reset は全ユーザーデータ（パスワード、タグ、添付ファイル等）を削除する操作。現在はチーム管理者が実行できるが、影響範囲はチームデータに限らず **ユーザー全体** のため、**テナント管理者** レベルの操作に変更する。

同時に以下を追加:

- 発行済みリセットトークンの **取り消し（revoke）** 機能
- リセット **履歴一覧** UI
- テナント管理者向けの **メンバー管理ページ**

---

## 変更概要

| 区分 | 内容 |
| ---- | ---- |
| Schema | `AdminVaultReset.teamId` optional 化、`AuditAction` に REVOKE 追加、`AuditScope` に TENANT 追加、RLS ポリシー追加 |
| Auth | 新規 `src/lib/tenant-auth.ts` — テナントロール RBAC |
| API | initiate/revoke/history を `/api/tenant/members/[userId]/reset-vault` に移動、`/api/tenant/role` 新設 |
| UI | `/dashboard/settings` の tenant タブにメンバー管理 + リセット履歴を追加 |
| 旧API | team 版 initiate route を削除、team settings から reset ボタン削除 |

---

## Step 1: Schema 変更 + RLS

**`prisma/schema.prisma`**

1. `AuditAction` enum に `ADMIN_VAULT_RESET_REVOKE` 追加
2. `AuditScope` enum に `TENANT` 追加
3. `NotificationType` enum に `ADMIN_VAULT_RESET_REVOKED` 追加
4. `AdminVaultReset.teamId` を optional に変更 (`String?`)
5. `AdminVaultReset.team` リレーションも optional に (`Team?`, `onDelete: SetNull`)

**マイグレーション SQL** に以下を含める:

- `ALTER TYPE` で enum 値追加
- `ALTER TABLE admin_vault_resets ALTER COLUMN team_id DROP NOT NULL`
- `ALTER TABLE admin_vault_resets ENABLE ROW LEVEL SECURITY` + `tenant_isolation` ポリシー追加（他テナントテーブルと同パターン）
- **既存 pending トークンの一括 revoke**: `UPDATE admin_vault_resets SET revoked_at = NOW() WHERE executed_at IS NULL AND revoked_at IS NULL`

**マイグレーション実行**: `npm run db:migrate`

---

## Step 2: Constants 更新

**`src/lib/constants/audit.ts`**

- `AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE` 追加
- `AUDIT_ACTION_VALUES` 配列に追加
- `AUDIT_SCOPE.TENANT` 追加
- `AUDIT_ACTION_GROUPS_PERSONAL` の AUTH グループに `ADMIN_VAULT_RESET_INITIATE`, `ADMIN_VAULT_RESET_EXECUTE`, `ADMIN_VAULT_RESET_REVOKE` 追加（対象ユーザーの個人ログに表示）
- **`AUDIT_ACTION_GROUPS_TENANT`** を新規定義: `ADMIN_VAULT_RESET_INITIATE`, `ADMIN_VAULT_RESET_EXECUTE`, `ADMIN_VAULT_RESET_REVOKE`

**`src/lib/constants/notification.ts`**

- `NOTIFICATION_TYPE.ADMIN_VAULT_RESET_REVOKED` 追加

**`src/lib/constants/api-path.ts`**

- `TENANT_MEMBERS: "/api/tenant/members"` 追加
- `TENANT_ROLE: "/api/tenant/role"` 追加
- `apiPath.tenantMemberResetVault(userId)` 追加
- `apiPath.tenantMemberResetVaultRevoke(userId, resetId)` 追加
- 旧 `teamMemberResetVault` は Step 11 で削除（ビルド破壊防止のため先に削除しない）

**`messages/{en,ja}/AuditLog.json`**

- `ADMIN_VAULT_RESET_REVOKE` の翻訳キー追加

---

## Step 3: Tenant Auth ライブラリ

**新規 `src/lib/tenant-auth.ts`** — `team-auth.ts` のパターンを踏襲

```typescript
TENANT_PERMISSION = {
  MEMBER_MANAGE: "tenant:member:manage",
  MEMBER_VAULT_RESET: "tenant:member:vaultReset",
}

// 10刻みで拡張余地を確保（TeamRole とは異なる数値体系）
OWNER: 全権限, ADMIN: 全権限, MEMBER: なし
TenantRole hierarchy: OWNER=30, ADMIN=20, MEMBER=10

Functions:
  hasTenantPermission(role, permission): boolean
  isTenantRoleAbove(actorRole, targetRole): boolean
  getTenantMembership(userId): Promise<TenantMember | null>
  requireTenantMember(userId): Promise<TenantMember>
  requireTenantPermission(userId, permission): Promise<TenantMember>
  TenantAuthError class
```

テナント特定: `resolveUserTenantId(userId)` → TenantMember lookup。`deactivatedAt IS NULL` を条件に含める。

**新規 `src/lib/constants/tenant-permission.ts`**

- `TENANT_PERMISSION` 定数定義
- `src/lib/constants/index.ts` から re-export

**テスト**: `src/lib/tenant-auth.test.ts`

- OWNER has all permissions
- ADMIN has all permissions
- MEMBER has no admin permissions
- isTenantRoleAbove: OWNER > ADMIN = true
- isTenantRoleAbove: ADMIN > MEMBER = true
- isTenantRoleAbove: ADMIN > ADMIN = false (厳密上位のみ)
- isTenantRoleAbove: MEMBER > OWNER = false
- requireTenantMember: deactivated user → 404
- requireTenantPermission: MEMBER + VAULT_RESET → 403

---

## Step 4: Notification Messages 更新

**`src/lib/notification-messages.ts`**

- `ADMIN_VAULT_RESET_REVOKED` 追加:
  - ja: title=「保管庫リセットが取り消されました」body=「テナント管理者がリセットを取り消しました。」
  - en: title="Vault reset cancelled" body="A tenant admin has cancelled the vault reset."
- 既存 `ADMIN_VAULT_RESET` の body を「チーム管理者」→「テナント管理者」/「tenant admin」に変更

---

## Step 5: Tenant Role API

**新規 `src/app/api/tenant/role/route.ts`**

**GET** — 認証済みユーザーの TenantRole を返す

- セッション認証
- `getTenantMembership(session.user.id)` → `{ role: TenantRole }` を返す
- テナント未所属の場合は `{ role: null }`

UI の条件分岐（メンバー管理カードの表示/非表示）に使用。

---

## Step 6: Tenant Members API

**新規 `src/app/api/tenant/members/route.ts`**

**GET** — テナントメンバー一覧（OWNER/ADMIN のみ）

- `requireTenantPermission(session.user.id, MEMBER_MANAGE)` → actor の tenantId を取得
- **RLS コンテキスト**: データ取得クエリを `withTenantRls(prisma, actor.tenantId, async () => { ... })` で囲む
- TenantMember + User join
- **select で最小限のフィールドのみ**: id, name, email, image, role, deactivatedAt（セキュリティフィールドは一切返さない）
- 各メンバーの pending reset 件数を含める
- **deactivated メンバーも含める**（vault クリーンアップ用途）。UI で視覚的に区別

---

## Step 7: Tenant Initiate + History API

**新規 `src/app/api/tenant/members/[userId]/reset-vault/route.ts`**

**POST** — テナント OWNER/ADMIN が vault reset を発行

- `requireTenantPermission(session.user.id, MEMBER_VAULT_RESET)` → actor の tenantId を取得
- **RLS コンテキスト**: データ取得・作成クエリを `withTenantRls(prisma, actor.tenantId, async () => { ... })` で囲む
- **同一テナント検証**: `TenantMember WHERE tenantId = actor.tenantId AND userId = params.userId AND deactivatedAt IS NULL`。不在なら 404（他テナントのユーザー存在を隠蔽）
- `isTenantRoleAbove(actor.role, target.role)` — 厳密上位のみ
- 自分自身は不可 (403)
- **Rate limit キー**: admin = `rl:admin-reset:admin:${userId}` (ユーザー単位、3/day)、target = `rl:admin-reset:target:${targetUserId}` (1/day)
- Max 3 pending resets（`WHERE targetUserId AND executedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`）
- トークン生成 → `AdminVaultReset` 作成（**teamId: null**）
- `logAudit` に **tenantId を明示的に渡す**（actor.tenantId）
- 通知 + Email + Audit (`AUDIT_SCOPE.TENANT`)

**GET** — 対象ユーザーのリセット履歴

- `requireTenantPermission(session.user.id, MEMBER_VAULT_RESET)` → actor の tenantId を取得
- **RLS コンテキスト**: `withTenantRls(prisma, actor.tenantId, async () => { ... })`
- **tenantId フィルタ必須**: `WHERE targetUserId = params.userId AND tenantId = actor.tenantId`
- 最新順ソート (`createdAt DESC`)、**`take: 50`** デフォルト上限
- ステータス導出: pending / executed / revoked / expired
- initiatedBy の name/email を含める

---

## Step 8: Revoke API

**新規 `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts`**

**POST**

- `requireTenantPermission(session.user.id, MEMBER_VAULT_RESET)` → actor の tenantId を取得
- **RLS コンテキスト**: `withTenantRls(prisma, actor.tenantId, async () => { ... })`
- **pending 定義**: `WHERE { id: resetId, tenantId: actor.tenantId, executedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }`。条件不一致時は `409 Conflict`
- `revokedAt = new Date()` で更新
- In-app 通知 (`ADMIN_VAULT_RESET_REVOKED`) + Audit log (`ADMIN_VAULT_RESET_REVOKE`)
- **Revoke メール通知**: 対象ユーザーに「管理者がリセット要求を取り消しました。対応は不要です」メールを送信
- audit metadata に `revokedById` を含める

---

## Step 9: Execute API 更新

**`src/app/api/vault/admin-reset/route.ts`**

- トークン検証と execute の **TOCTOU 防止**: `findUnique` で検証後、`updateMany` で条件付きアトミック更新（`WHERE id = resetId AND executedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`）→ `count === 0` なら 410 返却。成功時のみ `executeVaultReset` を実行
- `teamId` が null の場合、audit scope を `TENANT` に変更（既存 `TEAM` はフォールバック）
- `logAudit` に **`resetRecord.tenantId`** を明示的に渡す（`resetRecord` は Prisma の全フィールド返却で `tenantId` を含む）

---

## Step 10: Email テンプレート更新

**`src/lib/email/templates/admin-vault-reset.ts`**

- "team admin" → "organization admin" / 「テナント管理者」に文言変更
- `teamName` パラメータを **optional (デフォルト `""`)** に変更（旧 route との共存期間中のビルド破壊を防止）
- Step 11 の旧 route 削除後に `teamName` を完全削除

**新規 `src/lib/email/templates/admin-vault-reset-revoked.ts`**

- 件名: "Vault reset has been cancelled" / 「保管庫リセットが取り消されました」
- 本文: 管理者名 + 「対応は不要です」

---

## Step 11: UI

### Tenant Role 取得 hook

**新規 `src/hooks/use-tenant-role.ts`**

- `GET /api/tenant/role` を呼び出し、`{ role, isOwner, isAdmin }` を返す

### Settings ページ拡張

**`src/app/[locale]/dashboard/settings/page.tsx`**

- Tenant タブ内に SCIM カード + **メンバー管理カード** を縦に並べる
- メンバー管理は `useTenantRole()` で tenant OWNER/ADMIN のみ表示

### 新規コンポーネント

**`src/components/settings/tenant-members-card.tsx`**

- テナントメンバー一覧テーブル（名前、メール、ロール）
- deactivated メンバーはグレーアウト + バッジ表示
- 各行に: ロールバッジ / Vault Reset ボタン（下位かつ **active のみ有効**、deactivated は disabled）/ Pending バッジ（件数クリックで履歴）

**`src/components/settings/tenant-vault-reset-button.tsx`**

- 確認ダイアログ（"RESET" 入力）
- API: `POST /api/tenant/members/[userId]/reset-vault`

**`src/components/settings/tenant-reset-history-dialog.tsx`**

- Dialog でリセット履歴表示
- ステータス色分け: Pending(黄) / Executed(赤) / Revoked(灰) / Expired(灰)
- Pending 行に「取り消し」ボタン
- 発行者名、日時、有効期限

---

## Step 12: 旧 Team 版の削除

**この Step は Step 10 の UI 完成後に実行（段階的移行）**

- `src/app/api/teams/[teamId]/members/[memberId]/reset-vault/` — route + test 削除
- `src/components/team/admin-vault-reset-button.tsx` 削除
- `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx` — reset ボタン削除、テナント設定へのインフォテキスト追加は不要（テナントタブに統合済み）
- `src/lib/team-auth.ts` — `MEMBER_VAULT_RESET` を ROLE_PERMISSIONS から削除
- `src/lib/constants/team-permission.ts` — `MEMBER_VAULT_RESET` 削除
- `src/lib/constants/api-path.ts` — `teamMemberResetVault` 削除
- Email テンプレートから `teamName` optional パラメータを完全削除

---

## Step 13: i18n

**`messages/{en,ja}.json`** — 新規 `TenantAdmin` ネームスペース:

- membersTitle, membersDescription
- roleOwner, roleAdmin, roleMember
- deactivated
- vaultResetTitle/Description/ConfirmHint/Confirm/Initiated/RateLimited/Failed
- resetHistoryTitle
- statusPending/Executed/Revoked/Expired
- revokeButton/Confirm/Success
- pendingResets, initiatedBy, noMembers

---

## Step 14: テスト

### テストヘルパー追加

- `src/__tests__/helpers/fixtures.ts` に `makeTenantMember()` ファクトリ追加
- `src/__tests__/helpers/mock-tenant-auth.ts` ヘルパー作成

### テストファイル

| ファイル | 内容 |
| -------- | ---- |
| `src/lib/tenant-auth.test.ts` | permission matrix 全組み合わせ, role hierarchy 全ペア |
| `src/app/api/tenant/role/route.test.ts` | GET (401, role 返却, テナント未所属) |
| `src/app/api/tenant/members/route.test.ts` | GET (401, 403 MEMBER, member list, deactivated 含む, 他テナント非表示) |
| `src/app/api/tenant/members/[userId]/reset-vault/route.test.ts` | POST initiate (401, 403, 404 他テナント, 403 自分自身, 403 ADMIN→ADMIN, 429 admin limit, 429 target limit, 429 pending cap, 200 成功+通知+email+audit, OWNER→ADMIN ok, limiter 独立性) |
| 同上 | GET history (401, 403, empty, sorted desc, status derivation, 他テナント非表示) |
| `.../[resetId]/revoke/route.test.ts` | POST (401, 403 権限なし, 404 存在しない, 409 executed 済み, 409 revoke 済み, 200 成功+revokedAt+audit+通知+email, RLS 検証) |
| `src/app/api/vault/admin-reset/route.test.ts` | 既存更新: teamId null の fixture 追加, TENANT scope assertion, TOCTOU 防止の updateMany 検証, `scope` フィールドの明示的 assertion 追加 |
| `src/lib/constants/audit.test.ts` | REVOKE action の整合性 |
| 旧テスト削除 | team 版 reset-vault (11 ケース → 新テストで全カバー確認後に削除) |

### 旧テストとの対応表

| 旧 team 版テストケース | 新 tenant 版テストケース |
| ---- | ---- |
| 401 unauthenticated | initiate POST 401 |
| 403 lacking permission | initiate POST 403 |
| 404 target not found | initiate POST 404 他テナント |
| 403 reset own vault | initiate POST 403 自分自身 |
| 403 ADMIN→ADMIN | initiate POST 403 ADMIN→ADMIN |
| 429 admin rate limit | initiate POST 429 admin limit |
| 429 target rate limit | initiate POST 429 target limit |
| 429 pending cap | initiate POST 429 pending cap |
| 200 success + notification + audit + email | initiate POST 200 成功 |
| OWNER→ADMIN ok | initiate POST OWNER→ADMIN ok |
| limiter 独立性 | initiate POST limiter 独立性 |

---

## 実装順序

1. Schema + migrate + RLS (Step 1)
2. Constants + notification messages (Step 2, 4)
3. Tenant auth lib (Step 3)
4. Tenant role API (Step 5)
5. Tenant members API (Step 6)
6. Initiate + History + Revoke API (Step 7, 8)
7. Execute API + Email 更新 (Step 9, 10)
8. UI (Step 11)
9. 旧 team 版削除 (Step 12)
10. i18n (Step 13)
11. テスト (Step 14)

## 検証

- Tenant OWNER → MEMBER の vault reset 全フロー
- Tenant ADMIN → ADMIN のリセット試行が 403
- 発行後に取り消し → トークン無効化 + 通知 + メール
- 取り消し済みトークンでの execute が 410
- 期限切れトークンの拒否
- Settings Tenant タブでメンバー一覧 + 履歴表示
- Deactivated メンバーが一覧に表示されること
- Team settings からリセットボタンが消えていること
- RLS: 他テナントの reset 履歴が見えないこと
- `npm run lint` エラーなし
- `npm test` 全パス
- `npm run build` 成功
