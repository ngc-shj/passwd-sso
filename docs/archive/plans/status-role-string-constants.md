# ステータス/ロール文字列の定数化

## Context

`api-error-codes.ts` パターン（`as const` + 型抽出）が既に確立されている。同じパターンを Vault ステータス、Org ロール、EA ステータス、Invitation ステータスに適用する。現状これらは全てハードコードされた文字列リテラル。

---

## Step 1: `src/lib/constants/` ディレクトリ作成

雑居防止のため、ドメインごとにファイルを分割。`index.ts` で re-export し、呼び出し側は `import { VAULT_STATUS } from "@/lib/constants"` のまま。

### `src/lib/constants/vault.ts`

```typescript
export const VAULT_STATUS = {
  LOADING: "loading",
  LOCKED: "locked",
  UNLOCKED: "unlocked",
  SETUP_REQUIRED: "setup-required",
} as const;

export type VaultStatus = (typeof VAULT_STATUS)[keyof typeof VAULT_STATUS];
```

Prisma に対応する enum がないため、独自定義。

### `src/lib/constants/org.ts`

```typescript
import type { OrgRole } from "@prisma/client";

export const ORG_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
} as const satisfies Record<OrgRole, OrgRole>;

/** Prisma OrgRole に寄せる。独自型は作らない。 */
export type OrgRoleValue = OrgRole;

/** Zod 用タプル */
export const ORG_ROLE_VALUES = [
  ORG_ROLE.OWNER, ORG_ROLE.ADMIN, ORG_ROLE.MEMBER, ORG_ROLE.VIEWER,
] as const;

/** invite 用（OWNER 除外） */
export const INVITE_ROLE_VALUES = [
  ORG_ROLE.ADMIN, ORG_ROLE.MEMBER, ORG_ROLE.VIEWER,
] as const;
```

`satisfies Record<OrgRole, OrgRole>` で **Prisma に enum 追加 → 即コンパイルエラー**。

### `src/lib/constants/emergency-access.ts`

```typescript
import type { EmergencyAccessStatus } from "@prisma/client";

export const EA_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  IDLE: "IDLE",
  STALE: "STALE",
  REQUESTED: "REQUESTED",
  ACTIVATED: "ACTIVATED",
  REVOKED: "REVOKED",
  REJECTED: "REJECTED",
} as const satisfies Record<EmergencyAccessStatus, EmergencyAccessStatus>;

/** Prisma EmergencyAccessStatus に寄せる。 */
export type EaStatusValue = EmergencyAccessStatus;
```

### `src/lib/constants/invitation.ts`

```typescript
import type { InvitationStatus } from "@prisma/client";

export const INVITATION_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
} as const satisfies Record<InvitationStatus, InvitationStatus>;

/** Prisma InvitationStatus に寄せる。 */
export type InvitationStatusValue = InvitationStatus;
```

### `src/lib/constants/index.ts`

```typescript
export { VAULT_STATUS } from "./vault";
export type { VaultStatus } from "./vault";

export { ORG_ROLE, ORG_ROLE_VALUES, INVITE_ROLE_VALUES } from "./org";
export type { OrgRoleValue } from "./org";

export { EA_STATUS } from "./emergency-access";
export type { EaStatusValue } from "./emergency-access";

export { INVITATION_STATUS } from "./invitation";
export type { InvitationStatusValue } from "./invitation";
```

**注意**: `org.ts`, `emergency-access.ts`, `invitation.ts` は `import type` のみ（Prisma ランタイム不要）。`vault.ts` は依存なし。全ファイル `"use client"` コンポーネントから安全にインポート可能。

---

## Step 2: Vault Status（6ファイル）

| File | 変更内容 |
|---|---|
| `src/lib/vault-context.tsx` | ローカル `VaultStatus` 型を削除、constants から import + re-export。文字列リテラル ~12箇所を `VAULT_STATUS.*` に置換 |
| `src/components/vault/vault-gate.tsx` | 3箇所: `"loading"`, `"setup-required"`, `"locked"` |
| `src/components/layout/header.tsx` | 1箇所: `"unlocked"` |
| `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx` | 2箇所: `"unlocked"` |
| `src/app/[locale]/dashboard/emergency-access/invite/[token]/page.tsx` | 1箇所: `"unlocked"` |
| `src/components/emergency-access/grant-card.tsx` | 1箇所: `"unlocked"` |

---

## Step 3: Org Roles（11ファイル）

| File | 変更内容 |
|---|---|
| `src/lib/org-auth.ts` | `ROLE_PERMISSIONS` / `ROLE_LEVEL` のキーを `[ORG_ROLE.*]:` に。`import type { OrgRole }` は維持 |
| `src/lib/validations.ts` | `z.enum(INVITE_ROLE_VALUES)` / `z.enum(ORG_ROLE_VALUES)` に置換 |
| `src/components/layout/sidebar.tsx` | 1箇所: filter 条件 |
| `src/components/org/org-role-badge.tsx` | `roleColors` / `roleKeys` のキー 8箇所 |
| `src/components/org/org-trash-list.tsx` | 1箇所 |
| `src/components/org/org-archived-list.tsx` | 2箇所: canEdit/canDelete |
| `src/components/org/org-favorites-list.tsx` | 2箇所: canEdit/canDelete |
| `src/app/[locale]/dashboard/orgs/[orgId]/page.tsx` | 6箇所 |
| `src/app/[locale]/dashboard/orgs/[orgId]/settings/page.tsx` | 2箇所 |
| `src/app/api/orgs/[orgId]/members/[memberId]/route.ts` | 7箇所 |
| `src/app/api/orgs/[orgId]/passwords/[id]/route.ts` | 1箇所 |

---

## Step 4: EA Status（14ファイル）

| File | 箇所 |
|---|---|
| `src/lib/emergency-access-state.ts` | `VALID_TRANSITIONS` 全キー/値 + `STALE_ELIGIBLE_STATUSES` |
| `src/lib/emergency-access-server.ts` | 1 |
| `src/app/api/emergency-access/route.ts` | 3 |
| `src/app/api/emergency-access/accept/route.ts` | 3 |
| `src/app/api/emergency-access/reject/route.ts` | 3 |
| `src/app/api/emergency-access/pending-confirmations/route.ts` | 2 |
| `src/app/api/emergency-access/[id]/accept/route.ts` | 3 |
| `src/app/api/emergency-access/[id]/decline/route.ts` | 2 |
| `src/app/api/emergency-access/[id]/confirm/route.ts` | 3 |
| `src/app/api/emergency-access/[id]/request/route.ts` | 3 |
| `src/app/api/emergency-access/[id]/approve/route.ts` | 3 |
| `src/app/api/emergency-access/[id]/revoke/route.ts` | 6 |
| `src/app/api/emergency-access/[id]/vault/route.ts` | 4 |
| `src/app/api/emergency-access/[id]/vault/entries/route.ts` | 1 |

---

## Step 5: Invitation Status（2ファイル）

| File | 箇所 |
|---|---|
| `src/app/api/orgs/invitations/accept/route.ts` | 4 |
| `src/app/api/orgs/[orgId]/invitations/route.ts` | 2 |

---

## Step 6: テストファイル（~15ファイル）

テストも同じ定数を使う。

- EA テスト 10ファイル + `emergency-access-state.test.ts`
- Org テストヘルパー: `mock-org-auth.ts`, `fixtures.ts`
- Invitation テスト: `accept/route.test.ts`, `[orgId]/invitations/route.test.ts`

---

## 検証

```bash
npm run build   # satisfies で網羅性チェック含む
npm test         # 全 643+ テスト通過
```

最終 grep で残存ハードコード確認。除外対象: i18n キー、コメント、テスト description、URL パス、CSS クラス。
