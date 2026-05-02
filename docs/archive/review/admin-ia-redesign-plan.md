# Admin IA Redesign — Plan

## Project context

- **Type**: web app (Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui)
- **Test infrastructure**: unit (Vitest) + integration (real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions)
- **Scope**: UI/UX restructuring of the admin console (`/admin/tenant/*` and `/admin/teams/[teamId]/*`); no API/schema/crypto changes
- **Language policy**: docs in English, UI labels Japanese (ja primary, en complete). Vault → 保管庫 (no katakana ボルト/ボールト).
- **Base branch**: `feat/admin-ia-redesign` from `origin/main`. PR #423 (personal-IA) may still be open during plan review; the admin-IA implementation runs on top of #423 once merged. The `SectionLayout` / `SectionCardHeader` / `SectionNav` helpers used here exist on main today (predate #423), so the plan does not depend on #423 except where called out explicitly.

## Objective

Restructure the tenant-admin and team-admin information architecture (IA) so that the sidebar reflects how an operator actually thinks about administering the product:

- Group operations by **mental model** (people / machines / policies / integrations / observability / emergency), not by tech-stack lineage.
- Eliminate the "Security" overload (currently 9+ sub-pages buried two clicks deep behind a single sidebar entry).
- Surface single-purpose pages (Operator Tokens, MCP Clients, Audit Delivery, Break Glass) at the right depth.
- Keep API contracts, authorization checks, and data-layer code unchanged. This is a UI-only restructure.

## Background — current problems

The admin console today exposes 8 tenant-scope sidebar items (4 leaves + 4 groups) and 4 team-scope items (2 leaves + 2 groups), but the labels and groupings collide with several mental models:

### A. Tenant-scope sidebar (`src/components/admin/admin-sidebar.tsx:95-152`)

| Sidebar item | Children (visible) | Pages actually under this URL | Issue |
|---|---|---|---|
| Members | — | 1 | OK |
| Teams | — | 1 | OK |
| Security | — (no children rendered in sidebar) | 9 (session/passkey/lockout/password/retention/access-restriction/webhooks/token/delegation) | Catastrophic overload: 9 pages hidden 2 clicks deep behind one sidebar entry; "Security" describes everything in this app |
| Operator Tokens | — | 1 | Mis-located: this is one of three machine-credential surfaces (with SA, MCP) but lives at top level alone |
| Provisioning | SCIM, Directory Sync | 2 | Reasonable as-is, but the broader "external integration" cluster is split across Security (webhooks) and Audit Logs (delivery) |
| Service Accounts | Accounts, Access Requests | 2 | OK; JIT access requests are a sub-flow of SA |
| **MCP** | **MCP Clients** | **1** | **Single-child group — should be flattened or absorbed** |
| Audit Logs | Logs, **Break Glass**, Delivery | 3 | Break Glass is an emergency *grant operation*, not a log subset. Delivery is an outbound integration, not a log subset. |

### B. `/admin/tenant/security/layout.tsx` — sub-IA inside Security

A nested SectionLayout exposes 9 pages in 4 sub-groups:

| Sub-group | Children | Issue |
|---|---|---|
| Authentication | session, passkey, lockout | OK |
| Policy | password, retention | "Policy" overloaded — every item in Security is a policy |
| Network | access-restriction, **webhooks** | Webhooks is outbound event delivery, not a network ACL |
| Machine Identity | token-policy, delegation-policy | OK |

The 4-group nav is invisible in the main admin sidebar; users must click "Security", land on a sub-page, then drill into a second sub-nav. Discoverability for "where do I configure password policy?" requires two correct guesses.

### C. Team-scope sidebar

| Sidebar item | Children | Issue |
|---|---|---|
| General | — | OK |
| **Members** | **List, Add, Transfer Ownership** | "Add" is an action, not a destination — usually a button on the list page. "Transfer Ownership" is a destructive low-frequency operation; placement requires care. |
| Security | Policy, Key Rotation, Webhooks | Mixed: Policy = config; Key Rotation = one-time crypto op; Webhooks = integration |
| Audit Logs | — | OK |

### D. Cross-cutting

- "Security" appears as a group on both tenant and team scopes with different meanings (different child sets, different responsibilities).
- Webhooks placement is inconsistent (tenant: under Security; team: under Security) and miscategorized (outbound event delivery, not security policy).
- Audit Delivery (configuring SIEM forwarding) is shoved under Audit Logs but is an outbound integration.
- Break Glass is shoved under Audit Logs but is an emergency *grant action* (creating short-lived elevated access for an admin).
- The MCP sidebar group has exactly one child (MCP Clients).

## Requirements

### Functional

- All existing functionality preserved. No feature removed.
- All 36 existing admin pages remain reachable through the new URL tree.
- Authorization (`requireTenantOwner`, `requireTeamRole`) on the underlying API endpoints is **unchanged**. Frontend reorganization does not relax server-side checks.
- Old admin URLs simply 404 — there are **no** redirects, no migration banner, no "moved page" notice, no migration audit action. (Operators rebookmark; population is small.)
- The tenant admin can find each policy (password / session / passkey / lockout / token / delegation / retention / access-restriction) within 2 clicks from the admin landing.
- Single-purpose pages (Operator Tokens, MCP Clients, Audit Delivery, Break Glass) are reachable in 2 clicks.
- Add Member on a team becomes an in-page action (button + modal/drawer) instead of a separate sidebar entry. Transfer Ownership remains a separate destination accessed from the Members page (link or action menu) because it is destructive and rare.

### Non-functional

- a11y:
  - Every renamed nav item retains its visible Japanese (or English) label as its accessible name via the `<a>` text content — sidebar items do not currently carry separate `aria-label`s and the redesign does not add any (round-1 finding F7 corrected the prior claim — admin-sidebar.tsx had no `aria-label` to "preserve").
  - **NEW**: `aria-current="page"` added to active sidebar links in this PR (see §"`admin-sidebar.tsx` rewrite" — round-1 finding F7/T6). This delivers the screen-reader "current page" announcement that Scenario 12 promises.
- i18n: every new label complete in `messages/ja/AdminConsole.json` and `messages/en/AdminConsole.json`. The CI gate `src/i18n/messages-consistency.test.ts` enforces ja/en symmetry. **Note (round-1 T9)**: the existing test only enforces parity, NOT dead-key prevention; the latter is provided by the new sentinel tests in Batch 7. Both gates are required.
- No extra server round-trip on sidebar render.
- Bookmark behavior: old `/admin/tenant/security/...` and other moved URLs return 404; this is acceptable given the operator-only audience.
- Browser extension is **not** affected by admin-IA changes (extension only deep-links to `/dashboard/*`, not `/admin/*` — verified by grep across `extension/`).
- Performance: no change.

## Technical approach

### New tenant-admin IA

Top-level sidebar (7 items, 4 leaves + 3 groups):

```
管理コンソール > テナント
├─ メンバー (leaf)         /admin/tenant/members
├─ チーム (leaf)           /admin/tenant/teams
├─ マシンID (group, 3 children)
│   ├─ サービスアカウント   /admin/tenant/machine-identity/service-accounts
│   │     (page sub-tab: アカウント / JIT アクセスリクエスト)
│   ├─ MCP クライアント    /admin/tenant/machine-identity/mcp-clients
│   └─ 運用者トークン      /admin/tenant/machine-identity/operator-tokens
├─ ポリシー (group, 4 children)
│   ├─ 認証ポリシー         /admin/tenant/policies/authentication
│   │     (page sub-tab: パスワード / セッション / パスキー / ロックアウト)
│   ├─ マシンIDポリシー     /admin/tenant/policies/machine-identity
│   │     (page sub-tab: トークン / 委任)
│   ├─ データ保存          /admin/tenant/policies/retention
│   └─ アクセス制御         /admin/tenant/policies/access-restriction
├─ 連携 (group, 3 children)
│   ├─ プロビジョニング     /admin/tenant/integrations/provisioning
│   │     (page sub-tab: SCIM / ディレクトリ同期)
│   ├─ Webhook            /admin/tenant/integrations/webhooks
│   └─ 監査ログ配信         /admin/tenant/integrations/audit-delivery
├─ 監査ログ (leaf)         /admin/tenant/audit-logs
└─ ブレイクグラス (leaf)    /admin/tenant/breakglass
```

URL count: 7 group/leaf landings + 3 sub-tab parent pages (認証ポリシー / マシンIDポリシー / プロビジョニング / サービスアカウント). All current 25 tenant-admin pages map to a new path (see "URL migration map" below).

### New team-admin IA

Top-level sidebar (6 items, all leaves):

```
管理コンソール > チーム
├─ 概要 (leaf)              /admin/teams/[id]/general
├─ メンバー (leaf)           /admin/teams/[id]/members
│     (page action: Add member button + modal; Transfer Ownership link → separate page)
├─ ポリシー (leaf)           /admin/teams/[id]/policy
├─ キーローテーション (leaf)  /admin/teams/[id]/key-rotation
├─ Webhook (leaf)           /admin/teams/[id]/webhooks
└─ 監査ログ (leaf)           /admin/teams/[id]/audit-logs
```

Plus the existing transfer ownership page kept at: `/admin/teams/[id]/members/transfer-ownership`.

The team-admin Members page absorbs the current `/list` and `/add` pages: list view + "メンバーを追加" button that opens a modal/drawer hosting the existing add form.

### URL migration map (tenant)

| Current URL | New URL |
|---|---|
| `/admin/tenant/members` | `/admin/tenant/members` (no change) |
| `/admin/tenant/teams` | `/admin/tenant/teams` (no change) |
| `/admin/tenant/security` | (removed — no replacement at this exact path) |
| `/admin/tenant/security/session-policy` | `/admin/tenant/policies/authentication/session` |
| `/admin/tenant/security/passkey-policy` | `/admin/tenant/policies/authentication/passkey` |
| `/admin/tenant/security/lockout-policy` | `/admin/tenant/policies/authentication/lockout` |
| `/admin/tenant/security/password-policy` | `/admin/tenant/policies/authentication/password` |
| `/admin/tenant/security/retention-policy` | `/admin/tenant/policies/retention` |
| `/admin/tenant/security/access-restriction` | `/admin/tenant/policies/access-restriction` |
| `/admin/tenant/security/webhooks` | `/admin/tenant/integrations/webhooks` |
| `/admin/tenant/security/token-policy` | `/admin/tenant/policies/machine-identity/token` |
| `/admin/tenant/security/delegation-policy` | `/admin/tenant/policies/machine-identity/delegation` |
| `/admin/tenant/operator-tokens` | `/admin/tenant/machine-identity/operator-tokens` |
| `/admin/tenant/provisioning/scim` | `/admin/tenant/integrations/provisioning/scim` |
| `/admin/tenant/provisioning/directory-sync` | `/admin/tenant/integrations/provisioning/directory-sync` |
| `/admin/tenant/service-accounts/accounts` | `/admin/tenant/machine-identity/service-accounts/accounts` |
| `/admin/tenant/service-accounts/access-requests` | `/admin/tenant/machine-identity/service-accounts/access-requests` |
| `/admin/tenant/mcp/clients` | `/admin/tenant/machine-identity/mcp-clients` |
| `/admin/tenant/audit-logs/logs` | `/admin/tenant/audit-logs` (flattened — no sub-tab) |
| `/admin/tenant/audit-logs/breakglass` | `/admin/tenant/breakglass` |
| `/admin/tenant/audit-logs/delivery` | `/admin/tenant/integrations/audit-delivery` |

Default landing for sub-tab pages:

| Sub-tab parent | Default child URL | Mechanism |
|---|---|---|
| `/admin/tenant/policies/authentication` | `/admin/tenant/policies/authentication/password` | server-side redirect via `redirect()` in the parent `page.tsx` |
| `/admin/tenant/policies/machine-identity` | `/admin/tenant/policies/machine-identity/token` | same |
| `/admin/tenant/integrations/provisioning` | `/admin/tenant/integrations/provisioning/scim` | same |
| `/admin/tenant/machine-identity/service-accounts` | `/admin/tenant/machine-identity/service-accounts/accounts` | same |

We use **server-side `redirect()`** (from `next/navigation`) rather than client-side `useEffect → router.replace`. Reason: the current admin uses both styles inconsistently (security uses client-side, audit-logs uses server-side), and server-side avoids the redirect flash and the `"use client"` overhead for what should be a stateless redirect.

**Server-Component requirement clarification**: `redirect()` from `next/navigation` works in Server Components and Server Actions. In Next.js 16 App Router, a `page.tsx` (or `layout.tsx`) without `"use client"` directive is a Server Component by default — no `"use server"` directive is needed (that directive is only for Server Actions). The redirect-only pages introduced in this plan have no `"use client"` directive and therefore run on the server, where `redirect()` issues an HTTP 307 with no client-side flash.

**Canonical redirect pattern (REQUIRED — addresses round-1 finding F2)**: Every redirect-only `page.tsx` in this plan MUST include the locale prefix in the redirect target. The chosen pattern matches the existing precedent at `src/app/[locale]/admin/tenant/audit-logs/page.tsx` (so we don't introduce a third style). A bare `redirect("/admin/tenant/...")` causes incorrect locale routing for non-default-locale users (next-intl middleware bounces or double-redirects).

```tsx
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantPoliciesAuthenticationPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/policies/authentication/password`);
}
```

Apply this pattern verbatim (substituting target paths) for all 7 redirect-only pages introduced in this plan. The page function MUST be `async`; the import MUST come from `next/navigation` (NOT `@/i18n/navigation` — that helper has a different signature and the existing admin precedent uses `next/navigation`).

**Group landing redirect pages** (added per pre-screen review #9) — to avoid 404 when an operator types the group URL directly into the address bar, every group landing path that has no content card gets a redirect-only `page.tsx`:

| URL | Redirect target |
|---|---|
| `/admin/tenant/machine-identity` | `/admin/tenant/machine-identity/service-accounts/accounts` |
| `/admin/tenant/policies` | `/admin/tenant/policies/authentication/password` |
| `/admin/tenant/integrations` | `/admin/tenant/integrations/provisioning/scim` |

(Sub-tab parent pages — `/admin/tenant/policies/authentication`, `.../machine-identity`, `/admin/tenant/integrations/provisioning`, `/admin/tenant/machine-identity/service-accounts` — get their own redirect-only `page.tsx` per the "Default landing for sub-tab pages" table above.)

The sidebar's group-header `href` is set to the group landing URL (e.g. `/admin/tenant/machine-identity`); clicking the header expands the group and navigates — the redirect cascades to the first leaf, no flash.

### URL migration map (team)

| Current URL | New URL |
|---|---|
| `/admin/teams/[id]/general` | `/admin/teams/[id]/general` (no change) |
| `/admin/teams/[id]/members` | (redirect to `/list` removed) |
| `/admin/teams/[id]/members/list` | `/admin/teams/[id]/members` (flattened — list is the page) |
| `/admin/teams/[id]/members/add` | (removed — Add becomes an in-page button + modal on the Members page) |
| `/admin/teams/[id]/members/transfer` | `/admin/teams/[id]/members/transfer-ownership` (renamed for clarity) |
| `/admin/teams/[id]/security` | (removed — no replacement at this exact path) |
| `/admin/teams/[id]/security/policy` | `/admin/teams/[id]/policy` |
| `/admin/teams/[id]/security/key-rotation` | `/admin/teams/[id]/key-rotation` |
| `/admin/teams/[id]/security/webhooks` | `/admin/teams/[id]/webhooks` |
| `/admin/teams/[id]/audit-logs` | `/admin/teams/[id]/audit-logs` (no change) |

### Component reuse

The plan **does not move existing card components**. Cards stay where they are today (mostly `src/components/settings/{security,developer,account}/`) regardless of the new URL tree. Reasons:

1. The cards are stable, well-tested, and used by exactly one page each (verified in survey §4 — all 21 cards have single consumers).
2. Moving 20+ component files just for naming consistency is high-churn / low-value.
3. A separate cleanup PR can later reorganize component directories if desired.

The components keep their current file paths, names, and exports. Pages import from the existing locations.

### `admin-sidebar.tsx` rewrite

**Round-1 finding F7/T6 — also add `aria-current="page"` emission**: the existing `SidebarNav` component renders active state via `variant="secondary"` on the shadcn `Button`. shadcn's `Button` does NOT add `aria-current`. To honor the a11y promise in §"User operation scenarios" Scenario 12 ("Active item announces as 'current page'"), add `aria-current={isActive ? "page" : undefined}` to the inner `<Link>` elements at `admin-sidebar.tsx:189` (group children) and `admin-sidebar.tsx:211` (top-level leaves) as part of this batch. Single-line addition, low risk; the new unit tests below will assert it. (Without this change, Scenario 12's screen-reader claim is unreachable.)

`src/components/admin/admin-sidebar.tsx:53-152` is rewritten:

**Tenant scope** — replace the existing 8-item array with the 7-item structure above. Key changes:

- Remove flat `Members`, `Teams`, `Security`, `Operator Tokens`, `Provisioning`, `Service Accounts`, `MCP`, `Audit Logs` items.
- Insert new groups `マシンID`, `ポリシー`, `連携`. Each group's `href` points to its first child (matching existing pattern).
- Insert `ブレイクグラス` as a new top-level leaf.
- Update icons (lucide-react): keep `Users` (Members), `UsersRound` (Teams); add `Bot` (machine ID group), `ListChecks` (policies group), `Link2` (integrations group), `ShieldAlert` (Break Glass — already imported in `admin-sidebar.tsx:25`).
- The group-rendering pattern (`SidebarNav`) is unchanged.

**Team scope** — replace the existing 4-item array with the 6-leaf structure. Key changes:

- Remove `Members` group (3 children → 1 leaf).
- Remove `Security` group (3 children → 3 leaves at top level).
- Add `Webhook` and `キーローテーション` and `ポリシー` as siblings of `概要`, `メンバー`, `監査ログ`.

**i18n keys touched** — see "i18n changes" below.

### `SectionLayout` reuse

`src/components/settings/account/section-layout.tsx` already supports nested `navItems` with `children`. The 3 sub-tab pages (`/policies/authentication`, `/policies/machine-identity`, `/integrations/provisioning`, `/machine-identity/service-accounts`) each define a layout that passes `navItems` with the relevant sub-tab list. This matches the current `/admin/tenant/security/layout.tsx` shape — we keep the same component, just at different URLs with different `navItems` arrays.

### Page-level vault state checks

Several existing tenant-admin cards call `useVault()` (per survey §4). The vault status checks within those cards are unchanged by the IA reshuffle — moving a page's URL does not affect whether the card it renders requires `VAULT_STATUS.UNLOCKED`. No new vault gating is introduced.

### i18n changes

`messages/{ja,en}/AdminConsole.json` is the canonical namespace. We **add** new keys for the new structure and **keep but mark deprecated** the old keys until the cleanup is complete. (For internal-only operator-facing labels with no external consumers, we may remove old keys outright — see "Cleanup of unused keys" below.)

**New keys** (ja examples; en mirrors structure). **Round-1 finding F5 correction**: operator-token label MUST be `運用者トークン` (kanji, matching 8+ existing references in `OperatorToken.json`, `AuditLog.json`, etc.) — NOT `オペレータートークン` (katakana). The English label is `Operator tokens`.

```json
{
  "navMachineIdentity": "マシンID",
  "navMachineIdentityServiceAccounts": "サービスアカウント",
  "navMachineIdentityMcpClients": "MCP クライアント",
  "navMachineIdentityOperatorTokens": "運用者トークン",

  "navPolicies": "ポリシー",
  "navPolicyAuthentication": "認証ポリシー",
  "navPolicyMachineIdentity": "マシンID ポリシー",
  "navPolicyRetention": "データ保存",
  "navPolicyAccessRestriction": "アクセス制御",

  "navIntegrations": "連携",
  "navIntegrationProvisioning": "プロビジョニング",
  "navIntegrationWebhooks": "Webhook",
  "navIntegrationAuditDelivery": "監査ログ配信",

  "navBreakglass": "ブレイクグラス",

  "navTeamPolicy": "ポリシー",
  "navTeamKeyRotation": "キーローテーション",
  "navTeamWebhooks": "Webhook",

  "subTabPassword": "パスワード",
  "subTabSession": "セッション",
  "subTabPasskey": "パスキー",
  "subTabLockout": "ロックアウト",
  "subTabToken": "トークン",
  "subTabDelegation": "委任",
  "subTabSaAccounts": "アカウント",
  "subTabSaAccessRequests": "JIT アクセスリクエスト",
  "subTabScim": "SCIM",
  "subTabDirectorySync": "ディレクトリ同期",

  "sectionMachineIdentity": "マシンID",
  "sectionMachineIdentityDesc": "サービスアカウント、MCPクライアント、運用者トークンの管理",
  "sectionMachineIdentityMcpClients": "MCP クライアント",
  "sectionMachineIdentityMcpClientsDesc": "AI エージェントが MCP ゲートウェイ経由で接続するためのクライアント登録",
  "sectionMachineIdentityOperatorTokens": "運用者トークン",
  "sectionMachineIdentityOperatorTokensDesc": "管理者・運用ルートに対するオペレータごとの Bearer トークン",

  "sectionPolicies": "ポリシー",
  "sectionPoliciesDesc": "認証・マシンID・データ保存・アクセス制御の各ポリシー設定",
  "sectionPolicyAuthentication": "認証ポリシー",
  "sectionPolicyAuthenticationDesc": "パスワード、セッション、パスキー、ロックアウトの認証ポリシー",
  "sectionPolicyMachineIdentity": "マシンID ポリシー",
  "sectionPolicyMachineIdentityDesc": "マシンIDトークンと委任セッションのポリシー",
  "sectionPolicyRetention": "データ保存ポリシー",
  "sectionPolicyRetentionDesc": "データのアーカイブ・削除に関する保存期間ポリシー",
  "sectionPolicyAccessRestriction": "アクセス制御",
  "sectionPolicyAccessRestrictionDesc": "IP・ネットワーク経路によるテナントアクセス制限",

  "sectionIntegrations": "連携",
  "sectionIntegrationsDesc": "プロビジョニング、Webhook、監査ログ配信の設定",
  "sectionIntegrationProvisioning": "プロビジョニング",
  "sectionIntegrationProvisioningDesc": "SCIM・ディレクトリ同期による外部 IdP との連携",
  "sectionIntegrationWebhooks": "Webhook",
  "sectionIntegrationWebhooksDesc": "テナント全体のイベントを外部システムへ送出する Webhook",
  "sectionIntegrationAuditDelivery": "監査ログ配信",
  "sectionIntegrationAuditDeliveryDesc": "監査ログを SIEM 等の外部システムへ転送する配信先設定",

  "sectionBreakglass": "ブレイクグラス",
  "sectionBreakglassDesc": "緊急時の管理者アクセス付与",

  "teamSectionPolicy": "ポリシー",
  "teamSectionPolicyDesc": "チームのセキュリティポリシー設定",
  "teamSectionKeyRotation": "キーローテーション",
  "teamSectionKeyRotationDesc": "チームの暗号化鍵のローテーション",
  "teamSectionWebhooks": "Webhook",
  "teamSectionWebhooksDesc": "チーム単位のイベントを外部システムへ送出する Webhook",

  "memberAddButton": "メンバーを追加",
  "memberTransferOwnershipLink": "オーナー権限を移譲"
}
```

(Round-1 finding F3 added the `sectionMachineIdentityMcpClients*`, `sectionMachineIdentityOperatorTokens*`, `sectionPolicyRetention*`, `sectionPolicyAccessRestriction*`, `sectionIntegrationWebhooks*`, `sectionIntegrationAuditDelivery*`, `teamSectionPolicy*`, `teamSectionKeyRotation*`, `teamSectionWebhooks*` keys — they are required by the new sibling layouts that wrap moved leaf pages.)

**Keys to remove** (after the migration, in the same PR):

These were tied to the old IA and have no remaining consumers:

- `navProvisioning` (replaced by `navIntegrationProvisioning`)
- `navScim`, `navDirectorySync` (replaced by `subTabScim`, `subTabDirectorySync`)
- `navMcp`, `navMcpClients` (replaced by `navMachineIdentityMcpClients`)
- `navOperatorTokens` (replaced by `navMachineIdentityOperatorTokens`)
- `navServiceAccounts`, `navSaAccounts`, `navAccessRequests` (replaced by `navMachineIdentityServiceAccounts` + `subTabSaAccounts` + `subTabSaAccessRequests`)
- `navAuditLogsLogs`, `navAuditLogsBreakglass`, `navAuditDelivery` (audit-logs flattened; breakglass and delivery moved)
- `navGroupAuthentication`, `navGroupPolicy`, `navGroupNetwork`, `navGroupMachineIdentity` (the security/layout.tsx sub-groups; replaced by `navPolicy*`)
- `navSessionPolicy`, `navPasskeyPolicy`, `navLockoutPolicy`, `navPasswordPolicy`, `navRetentionPolicy`, `navAccessRestriction`, `navWebhooks`, `navTokenPolicy`, `navDelegationPolicy` (replaced by `subTab*` + new section keys)
- `navMemberList`, `navAddMember`, `navTransferOwnership` (team Members children flattened)
- `sectionProvisioning*`, `sectionMcp*`, `sectionServiceAccounts*`, `sectionOperatorTokens*` (sections renamed/regrouped)
- `navPolicy`, `navKeyRotation` (team — kept reused as `navTeamPolicy`, `navTeamKeyRotation`)

The plan tracks every removal in `messages/{ja,en}/AdminConsole.json`. The CI gate `src/i18n/messages-consistency.test.ts` ensures ja/en parity. A grep for each old key across `src/` confirms zero consumers remain before deletion.

**Sentinel test** (new, see Testing strategy): `src/__tests__/admin-i18n-key-coverage.test.ts` enumerates the new keys and asserts each is consumed by at least one source file. Prevents dead keys.

### Authorization invariant

Per the survey §7, every API route `/api/tenant/*` enforces `requireTenantOwner` and every `/api/teams/[teamId]/*` enforces `requireTeamRole(ADMIN|OWNER)`. The IA redesign **does not touch** these checks.

**Frontend page-level guards inherit automatically** — `src/app/[locale]/admin/tenant/layout.tsx` calls `getTenantRole()` + `isTenantAdminRole()` and returns `notFound()` on failure. In Next.js App Router, a parent `layout.tsx` wraps every nested page beneath that path segment regardless of subdirectory depth. New routes like `/admin/tenant/machine-identity/...`, `/admin/tenant/policies/...`, `/admin/tenant/integrations/...`, `/admin/tenant/breakglass` all sit under `/admin/tenant/` and inherit the existing tenant guard with no code changes. Same applies to `src/app/[locale]/admin/teams/[teamId]/layout.tsx` (team guard at `[teamId]/layout.tsx` covers all new team-admin routes).

The plan re-asserts this invariant by:
1. Reading `/admin/tenant/layout.tsx` and `/admin/teams/[teamId]/layout.tsx` after each batch — confirm no functional changes.
2. **Round-1 finding S3 concretization**: a new E2E test `e2e/tests/admin-authz.spec.ts` (Batch 7 step 9) walks every URL in the new admin tree and asserts:
   - HTTP 404 when accessed by an unauthenticated user (no session cookie).
   - HTTP 404 when accessed by an authenticated user without admin role (plain tenant member).
   This proves the layout `notFound()` guard is reached on every URL, not just the few covered by ad-hoc spec tests. Replaces the prior vague "walks the route tree" claim.

### Passkey enforcement allowlist

`src/lib/proxy/page-route.ts:23-35` exempts certain settings paths from passkey enforcement (so users can register a passkey when required). Personal-IA narrowed this to `["/dashboard/settings/auth/passkey"]`.

Admin paths are **not** currently exempted. The redesign **does not** add admin paths to the exemption set. Operators with passkey enforcement pending will continue to be redirected to the personal settings passkey page, register a passkey, then return to admin. No change needed.

## Implementation steps

### Batch 1 — i18n + sidebar

1. Add new keys to `messages/{ja,en}/AdminConsole.json`. Verify ja/en parity via the existing test.
2. Rewrite `src/components/admin/admin-sidebar.tsx` (tenant + team `useNavItems`) for the new structure.
3. Update `src/components/admin/admin-sidebar.test.tsx` assertions to match the new structure.
4. Run `npx vitest run src/components/admin/`. All tests pass.

### Batch 2 — tenant pages: machine-identity group

**Note on layout files**: Next.js App Router automatically inherits parent layouts. We do **not** need passthrough `layout.tsx` files at the group landing level (`/machine-identity`, `/policies`, `/integrations`). Children inherit `/admin/[locale]/admin/tenant/layout.tsx` directly. We only add `layout.tsx` where it provides actual nav (SectionLayout with sub-tab `navItems`).

**Note on orphaned redirect-page tests** (round-1 finding F1): the directories `src/app/[locale]/admin/tenant/{mcp,service-accounts}/` contain `__tests__/page.test.tsx` files that import from `../page` and assert `mockReplace` calls on the existing client-side redirects. After Batch 2 these tests must be `git rm`'d explicitly — Vitest fails at import time otherwise. The new server-side redirects are tested via E2E `toHaveURL` assertion (see Testing strategy / Batch 7), not unit tests.

1. Create `src/app/[locale]/admin/tenant/machine-identity/page.tsx` — async server component, `redirect(\`/${locale}/admin/tenant/machine-identity/service-accounts/accounts\`)` per canonical pattern. Prevents 404 on direct group-URL access.
2. Create `src/app/[locale]/admin/tenant/machine-identity/service-accounts/layout.tsx` — SectionLayout with sub-tabs `アカウント` / `JIT アクセスリクエスト`. Renders `SectionLayout` with `navItems = [{href: '.../accounts', label: t('subTabSaAccounts'), icon: Bot}, {href: '.../access-requests', label: t('subTabSaAccessRequests'), icon: ShieldCheck}]`.
3. Create `src/app/[locale]/admin/tenant/machine-identity/service-accounts/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/machine-identity/service-accounts/accounts\`)`.
4. **`git mv`** `src/app/[locale]/admin/tenant/service-accounts/accounts/page.tsx` → `src/app/[locale]/admin/tenant/machine-identity/service-accounts/accounts/page.tsx`. Content unchanged (still renders `<ServiceAccountCard />`).
5. **`git mv`** `src/app/[locale]/admin/tenant/service-accounts/access-requests/page.tsx` → `.../machine-identity/service-accounts/access-requests/page.tsx`. Content unchanged.
6. **`git mv`** `src/app/[locale]/admin/tenant/mcp/clients/page.tsx` → `src/app/[locale]/admin/tenant/machine-identity/mcp-clients/page.tsx`. Content unchanged (still renders `<McpClientCard />`).
7. Create new `src/app/[locale]/admin/tenant/machine-identity/mcp-clients/layout.tsx` — SectionLayout (no navItems) with title `t("sectionMachineIdentityMcpClients")`, description `t("sectionMachineIdentityMcpClientsDesc")`, icon `Blocks`. Required because the moved page lost its parent SectionLayout wrapper (round-1 F3).
8. **`git mv`** `src/app/[locale]/admin/tenant/operator-tokens/page.tsx` → `.../machine-identity/operator-tokens/page.tsx`. Content unchanged. **`git mv`** `src/app/[locale]/admin/tenant/operator-tokens/layout.tsx` → `.../machine-identity/operator-tokens/layout.tsx` AND update its title to `t("sectionMachineIdentityOperatorTokens")` / description (the existing layout already wraps with SectionLayout — only the i18n key reference changes).
9. **`git rm`** `src/app/[locale]/admin/tenant/mcp/__tests__/page.test.tsx` and `src/app/[locale]/admin/tenant/service-accounts/__tests__/page.test.tsx` — these test the old client-side redirects which no longer exist (round-1 F1).
10. Delete the now-empty old directories: `src/app/[locale]/admin/tenant/operator-tokens/`, `.../service-accounts/`, `.../mcp/`. Remove orphaned `layout.tsx` and the redirect-only `page.tsx` from `mcp/` and `service-accounts/`.

### Batch 3 — tenant pages: policies group

1. Create `src/app/[locale]/admin/tenant/policies/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/policies/authentication/password\`)` per canonical pattern. Prevents 404 on direct group-URL access.
2. Create `src/app/[locale]/admin/tenant/policies/authentication/layout.tsx` — SectionLayout with sub-tabs `password / session / passkey / lockout`. Title: `t("sectionPolicyAuthentication")`, description: `t("sectionPolicyAuthenticationDesc")`, icon: `Shield`.
3. Create `src/app/[locale]/admin/tenant/policies/authentication/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/policies/authentication/password\`)`.
4. **`git mv`** `src/app/[locale]/admin/tenant/security/{password-policy,session-policy,passkey-policy,lockout-policy}/page.tsx` → `policies/authentication/{password,session,passkey,lockout}/page.tsx` (4 files; content unchanged — each renders its respective `Tenant*PolicyCard`).
5. Create `src/app/[locale]/admin/tenant/policies/machine-identity/layout.tsx` — sub-tabs `token / delegation`. Title: `t("sectionPolicyMachineIdentity")`, description: `t("sectionPolicyMachineIdentityDesc")`, icon: `Bot`.
6. Create `src/app/[locale]/admin/tenant/policies/machine-identity/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/policies/machine-identity/token\`)`.
7. **`git mv`** `src/app/[locale]/admin/tenant/security/{token-policy,delegation-policy}/page.tsx` → `policies/machine-identity/{token,delegation}/page.tsx` (2 files; content unchanged).
8. **`git mv`** `src/app/[locale]/admin/tenant/security/retention-policy/page.tsx` → `policies/retention/page.tsx` (content unchanged — still renders `<TenantRetentionPolicyCard />`).
9. Create new `src/app/[locale]/admin/tenant/policies/retention/layout.tsx` — SectionLayout (no navItems) with title `t("sectionPolicyRetention")`, description `t("sectionPolicyRetentionDesc")`, icon `Archive`. Required because the moved page lost its parent SectionLayout wrapper (round-1 F3).
10. **`git mv`** `src/app/[locale]/admin/tenant/security/access-restriction/page.tsx` → `policies/access-restriction/page.tsx` (content unchanged).
11. Create new `src/app/[locale]/admin/tenant/policies/access-restriction/layout.tsx` — SectionLayout (no navItems) with title `t("sectionPolicyAccessRestriction")`, description `t("sectionPolicyAccessRestrictionDesc")`, icon `ShieldBan`. Required (F3).
12. Delete `src/app/[locale]/admin/tenant/security/` (and its now-orphaned `layout.tsx` and `page.tsx` — webhooks moves separately in Batch 4).

### Batch 4 — tenant pages: integrations group

1. Create `src/app/[locale]/admin/tenant/integrations/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/integrations/provisioning/scim\`)` per canonical pattern. Prevents 404 on direct group-URL access.
2. Create `src/app/[locale]/admin/tenant/integrations/provisioning/layout.tsx` — sub-tabs `SCIM / Directory Sync`. Title: `t("sectionIntegrationProvisioning")`, description: `t("sectionIntegrationProvisioningDesc")`, icon: `Link2`.
3. Create `src/app/[locale]/admin/tenant/integrations/provisioning/page.tsx` — async server-side `redirect(\`/${locale}/admin/tenant/integrations/provisioning/scim\`)`.
4. **`git mv`** `src/app/[locale]/admin/tenant/provisioning/{scim,directory-sync}/page.tsx` → `integrations/provisioning/{scim,directory-sync}/page.tsx` (2 files; content unchanged).
5. **`git mv`** `src/app/[locale]/admin/tenant/security/webhooks/page.tsx` → `integrations/webhooks/page.tsx` (content unchanged — still renders `<TenantWebhookCard />`).
6. Create new `src/app/[locale]/admin/tenant/integrations/webhooks/layout.tsx` — SectionLayout (no navItems) with title `t("sectionIntegrationWebhooks")`, description `t("sectionIntegrationWebhooksDesc")`, icon `Webhook`. Required (F3).
7. **`git mv`** `src/app/[locale]/admin/tenant/audit-logs/delivery/page.tsx` → `integrations/audit-delivery/page.tsx` (content unchanged — still renders `<AuditDeliveryTargetCard />`).
8. Create new `src/app/[locale]/admin/tenant/integrations/audit-delivery/layout.tsx` — SectionLayout (no navItems) with title `t("sectionIntegrationAuditDelivery")`, description `t("sectionIntegrationAuditDeliveryDesc")`, icon `Send`. Required (F3).
9. Delete `src/app/[locale]/admin/tenant/provisioning/` (now-orphaned root `page.tsx` and `layout.tsx`).

### Batch 5 — tenant pages: audit-logs flatten + breakglass top-level

1. **Inline the logs page**: replace the content of `src/app/[locale]/admin/tenant/audit-logs/page.tsx` (which currently does `redirect("/admin/tenant/audit-logs/logs")`) with the body of `src/app/[locale]/admin/tenant/audit-logs/logs/page.tsx` (which renders `<TenantAuditLogCard variant="logs" />`). Add at top of new page file: `export const dynamic = "force-dynamic";` (round-1 finding S6 — audit logs are sensitive; explicit no-cache prevents accidental ISR/CDN caching). Use `cat .../logs/page.tsx > .../page.tsx` then `git rm .../logs/page.tsx`. No `git mv` because the destination already exists with different content; this is a content-replacement operation (delete + overwrite).
2. **`git mv`** `src/app/[locale]/admin/tenant/audit-logs/breakglass/page.tsx` → `src/app/[locale]/admin/tenant/breakglass/page.tsx`. Content unchanged BUT add at top: `export const dynamic = "force-dynamic";` (round-1 finding S6 — break-glass page handles tenant-scoped grant data; must not cache cross-tenant).
3. Create new `src/app/[locale]/admin/tenant/breakglass/layout.tsx` — SectionLayout (no navItems) with title `t("sectionBreakglass")`, description `t("sectionBreakglassDesc")`, icon `ShieldAlert`. Required because the moved page lost its parent SectionLayout wrapper (round-1 F3).
4. Delete `src/app/[locale]/admin/tenant/audit-logs/logs/` (post step 1) and `.../breakglass/` (now empty).
5. (Audit Delivery moved to integrations in Batch 4 step 7 — already removed from `/audit-logs/delivery/`.)
6. Verify `src/app/[locale]/admin/tenant/audit-logs/layout.tsx` still wraps with SectionLayout title — no edit needed; sub-tab nav was always in the sidebar (already updated in Batch 1). The audit-logs landing now serves the log viewer directly (per step 1) so the existing layout's `t("sectionAuditLogs")` title still applies. (Round-1 finding F6 corrected the prior plan instruction here.)

### Batch 6 — team pages

1. **Decompose the existing 380-line `/members/add/page.tsx`** (round-1 finding F10/T8) into 3 reusable section components in `src/components/team/members/`:
   - `<AddFromTenantSection teamId={...} onSuccess={...} />` — search-and-add flow for existing tenant members (debounced search, role select, add button, abort-controller pattern preserved).
   - `<InviteByEmailSection teamId={...} onSuccess={...} />` — email + role + invite-link generation + clipboard write.
   - `<PendingInvitationsList teamId={...} />` — pending invitations with cancel + copy-link.
   Add unit tests for each (existing add-page has no `__tests__/` coverage; this is the right time to add).
2. **Inline the members list**: replace the content of `src/app/[locale]/admin/teams/[teamId]/members/page.tsx` (currently redirect-to-`/list`) with the body of `.../members/list/page.tsx`. UI shape on the new Members page:
   - Members roster table (top)
   - "メンバーを追加" button → opens a modal/drawer hosting `<AddFromTenantSection />` and `<InviteByEmailSection />` as two tabs
   - "オーナー権限を移譲" link in the page action area (or in a member-row menu) pointing at `/members/transfer-ownership`
   - `<PendingInvitationsList />` rendered below the roster (stays on the page, not in the modal — high-frequency reference)
3. Delete `src/app/[locale]/admin/teams/[teamId]/members/list/` (post step 2) and `.../members/add/` (after extracting the 3 section components).
4. **`git mv`** `src/app/[locale]/admin/teams/[teamId]/members/transfer/` → `.../members/transfer-ownership/`. Content unchanged. Update the inbound link from the new Members page (step 2).
5. **`git mv`** `src/app/[locale]/admin/teams/[teamId]/security/policy/page.tsx` → `.../policy/page.tsx` (renders `<TeamPolicySettings />`; content unchanged).
6. Create new `src/app/[locale]/admin/teams/[teamId]/policy/layout.tsx` — SectionLayout (no navItems) with title `t("teamSectionPolicy")`, description `t("teamSectionPolicyDesc")`, icon `ListChecks`. Required (F3).
7. **`git mv`** `src/app/[locale]/admin/teams/[teamId]/security/key-rotation/page.tsx` → `.../key-rotation/page.tsx` (content unchanged). **Verify** that `<TeamRotateKeyButton />` includes a multi-step confirmation flow (e.g. type-team-name-to-confirm) before executing the destructive rotation (round-1 finding S4 — the URL move reduces clicks from 3 → 1, so the confirm UX is the sole guard against accidental rotation). If the confirm flow is missing or weak, add it as part of this PR or open a follow-up issue and document explicitly here.
8. Create new `src/app/[locale]/admin/teams/[teamId]/key-rotation/layout.tsx` — SectionLayout (no navItems) with title `t("teamSectionKeyRotation")`, description `t("teamSectionKeyRotationDesc")`, icon `KeyRound`. Required (F3).
9. **`git mv`** `src/app/[locale]/admin/teams/[teamId]/security/webhooks/page.tsx` → `.../webhooks/page.tsx` (content unchanged).
10. Create new `src/app/[locale]/admin/teams/[teamId]/webhooks/layout.tsx` — SectionLayout (no navItems) with title `t("teamSectionWebhooks")`, description `t("teamSectionWebhooksDesc")`, icon `Webhook`. Required (F3).
11. Delete `src/app/[locale]/admin/teams/[teamId]/security/` (now-orphaned root `page.tsx` and `layout.tsx`).
12. Verify `src/app/[locale]/admin/teams/[teamId]/members/layout.tsx` still wraps with SectionLayout title — no edit needed; sub-tab nav was always in the sidebar. (Round-1 F6 corrected the prior plan instruction here.)

### Batch 7 — i18n cleanup + internal-link audit + tests

1. **Internal link audit** — grep `src/` for hard-coded admin URLs that survived the redesign:
   ```bash
   grep -rn 'href="/admin/tenant/security\|href="/admin/tenant/audit-logs/breakglass\|href="/admin/tenant/audit-logs/delivery\|href="/admin/tenant/audit-logs/logs\|href="/admin/tenant/operator-tokens\|href="/admin/tenant/provisioning\|href="/admin/tenant/service-accounts\|href="/admin/tenant/mcp\|href="/admin/teams/.*/members/list\|href="/admin/teams/.*/members/add\|href="/admin/teams/.*/security' src/
   ```
   **Verified hits (round-1 finding F4)**: `src/components/settings/account/section-nav.test.tsx` has ~22 occurrences of `/admin/tenant/security/...` URLs at lines 9, 48-50, 55, 60-62, 66, 75, 82, 88, 93, 99, 104, 110, 115, 121, 126 (NOT just 5 as the pre-screen stated). The test exercises path-prefix-matching logic, not admin URL routing. **Replace ALL occurrences with non-admin fixture URLs** (e.g. `/dashboard/settings/account`, `/dashboard/settings/auth/passkey`, `/dashboard/settings/auth/sessions`) so future admin IA changes don't pay this migration cost.

2. **Data-testid audit** — grep `src/components/admin` and `e2e/` for any selector that includes admin URL fragments:
   ```bash
   grep -rn 'data-testid' src/components/admin e2e | grep -iE 'security|operator|provisioning|service-accounts|mcp|breakglass|members.*list|members.*add'
   ```
   Pre-screen verified no `data-testid` includes admin URL fragments today. Re-run after Batch 1-6 to catch any introduced.

3. **Internal navigation hook check** (round-1 finding T18-A) — verify `src/hooks/sidebar/use-sidebar-navigation-state.ts` path-matching still handles the new team URLs. The current code matches `/admin/teams/[id]/...`; new team paths drop the `/security/` segment (`/policy`, `/key-rotation`, `/webhooks`). Confirm no logic depends on the `/security/` segment specifically. Run unit tests for this hook after Batch 6.

4. Remove deprecated keys from `messages/{ja,en}/AdminConsole.json` (after grep confirms zero consumers).

5. Add `src/__tests__/admin-i18n-key-coverage.test.ts` (sentinel for new keys — forward direction).
   - Pattern: copy the structure of `src/__tests__/audit-i18n-coverage.test.ts:6-13` (uses `node:fs` to read JSON + greps with `process.cwd()` paths).
   - Enumerate every new key (`navMachineIdentity*`, `navPolicy*`, `navIntegration*`, `navBreakglass`, `subTab*`, `section*`).
   - For each key, run `grep -rn` over `src/` for at least one consumer.
   - **MANDATORY exclusions** (round-1 finding T2 + round-2 finding F17 — without these the test is vacuous because the test file itself contains the literal key strings):
     - Exclude `**/__tests__/**` directories.
     - Exclude `**/*.test.ts` and `**/*.test.tsx` files (NOT just `*-i18n-*.test.ts` — round-2 F17 — any test file at any path could reference the keys).
     - Pattern in JS: `glob('src/**/*.{ts,tsx}', { ignore: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'] })` and read each.
   - Assert ≥1 hit per key.

6. Add `src/__tests__/admin-i18n-deprecated-keys.test.ts` (sentinel for deprecated keys — reverse direction). The test reads the canonical "deprecated keys" list (a hard-coded array embedded in the test file, listing every key removed by step 4) and asserts:
   - The deprecated array is non-empty (defensive: prevents an empty array silently passing).
   - Every entry matches `^(nav|section|subTab)[A-Z][a-zA-Z]+$` (round-1 finding T3 — catches typos in the gate itself, e.g. `navProvisining`).
   - None of the deprecated entries appear in `messages/{ja,en}/AdminConsole.json` (catches accidental key resurrection).
   - **Round-trip check (round-1 finding S5)**: also grep `src/` (with same `__tests__` exclusion as step 5) for `t("<oldKey>"` or `t('<oldKey>'` patterns; assert zero hits per deprecated key. Catches surviving `t("navOldKey")` calls after JSON removal.

7. Update `src/components/admin/admin-sidebar.test.tsx`:
   - Update describe blocks: rename `"under mcp group"` → `"under machine-identity group"`; rename `"under service-accounts group"` accordingly; **delete** describe blocks for groups that no longer exist (provisioning is now under integrations; audit-logs has no children).
   - Update `expectedHrefs` arrays for new tenant + team URL sets.
   - **Recompute link counts (round-1 finding F9/T5)** — walk the new `useNavItems` arrays:
     - **Tenant**: 2 leaves (Members, Teams) + 0 group-header anchors (group headers render as `<div>` per `admin-sidebar.tsx:170-181`) + 3 (machine-identity children) + 4 (policies children) + 3 (integrations children) + 2 leaves (Audit logs, Breakglass) = 14 `<a>` per sidebar × 2 sidebars = **28 links** (NOT 22).
     - **Team**: 6 leaves × 2 = **12 links** (plan was correct here).
   - Better: derive the count from the navItem source rather than hard-coding 28/12. Pattern: export a flat-leaf-count helper from `admin-sidebar.tsx` (or compute in test via the same nav-item factory) and assert `links.length === flatLeafCount * 2`. Addresses RT3 — future IA changes don't need to manually update the literal count.

8. Add new E2E test `e2e/tests/admin-ia.spec.ts` covering nav landings + sub-tabs. **Round-1 finding T7 mandates explicit `toHaveURL` assertions on every redirect.** Parameterized URL set (input → expected final URL):

   | Input URL | Expected final URL after redirect |
   |---|---|
   | `/ja/admin/tenant/members` | (no redirect; same) |
   | `/ja/admin/tenant/teams` | (same) |
   | `/ja/admin/tenant/machine-identity` | `/ja/admin/tenant/machine-identity/service-accounts/accounts` |
   | `/ja/admin/tenant/machine-identity/service-accounts` | `/ja/admin/tenant/machine-identity/service-accounts/accounts` |
   | `/ja/admin/tenant/machine-identity/service-accounts/accounts` | (same) |
   | `/ja/admin/tenant/machine-identity/service-accounts/access-requests` | (same) |
   | `/ja/admin/tenant/machine-identity/mcp-clients` | (same) |
   | `/ja/admin/tenant/machine-identity/operator-tokens` | (same) |
   | `/ja/admin/tenant/policies` | `/ja/admin/tenant/policies/authentication/password` |
   | `/ja/admin/tenant/policies/authentication` | `/ja/admin/tenant/policies/authentication/password` |
   | `/ja/admin/tenant/policies/authentication/{password,session,passkey,lockout}` | (same — 4 URLs) |
   | `/ja/admin/tenant/policies/machine-identity` | `/ja/admin/tenant/policies/machine-identity/token` |
   | `/ja/admin/tenant/policies/machine-identity/{token,delegation}` | (same — 2 URLs) |
   | `/ja/admin/tenant/policies/retention` | (same) |
   | `/ja/admin/tenant/policies/access-restriction` | (same) |
   | `/ja/admin/tenant/integrations` | `/ja/admin/tenant/integrations/provisioning/scim` |
   | `/ja/admin/tenant/integrations/provisioning` | `/ja/admin/tenant/integrations/provisioning/scim` |
   | `/ja/admin/tenant/integrations/provisioning/{scim,directory-sync}` | (same — 2 URLs) |
   | `/ja/admin/tenant/integrations/webhooks` | (same) |
   | `/ja/admin/tenant/integrations/audit-delivery` | (same) |
   | `/ja/admin/tenant/audit-logs` | (same — now serves logs directly) |
   | `/ja/admin/tenant/breakglass` | (same) |

   Plus equivalent `/en/...` cross-locale spot checks (at least one redirect URL in `/en/`, to verify locale prefix is preserved per round-1 F2). Plus team URLs:

   | Input URL | Expected final URL |
   |---|---|
   | `/ja/admin/teams/[id]/general` | (same) |
   | `/ja/admin/teams/[id]/members` | (same — now serves list directly) |
   | `/ja/admin/teams/[id]/members/transfer-ownership` | (same) |
   | `/ja/admin/teams/[id]/policy` | (same) |
   | `/ja/admin/teams/[id]/key-rotation` | (same) |
   | `/ja/admin/teams/[id]/webhooks` | (same) |
   | `/ja/admin/teams/[id]/audit-logs` | (same) |

   Test shape:
   ```ts
   for (const { input, expected } of NAV_URLS) {
     test(`navigates ${input} → ${expected}`, async ({ page }) => {
       await page.goto(input);
       await expect(page).toHaveURL(expected);
       const response = await page.waitForResponse(r => r.url().endsWith(expected));
       expect(response.status()).toBeLessThan(400);
     });
   }
   ```

   **Sample of OLD URLs (round-1 finding T15, 11 — verify 404)** — append a small batch of `await page.goto('/ja/admin/tenant/security/session-policy'); await expect(page).toHaveTitle(/404/i)` (or check `response.status() === 404`) to guard against accidental redirect re-introduction.

   **Vault-locked redirect smoke test (round-1 finding T15)** — at least one test navigates to a group landing URL (e.g. `/admin/tenant/policies`) without unlocking the vault first; assert the redirect cascade still completes (admin pages don't have a top-level VaultGate; vault-locked cards self-gate).

9. **Authorization regression test (round-1 finding S3)** — add `e2e/tests/admin-authz.spec.ts`:
   - **Round-2 T21 mandate**: assertion MUST be `const response = await page.goto(url); expect(response?.status()).toBe(404);` — NOT just "expect 404". Otherwise Next.js `notFound()` may render a 200 page with 404-styled content, vacuously passing.
   - **Round-2 S7 mandate**: name the non-admin user fixture explicitly. Use `vaultReady` fixture (per `e2e/helpers/fixtures.ts`) — confirmed plain user with no admin role. **DO NOT use `teamOwner`** which is also a tenant ADMIN per `e2e/helpers/global-setup.ts` (would produce false-positive pass).
   - **Round-2 S10 distinction**: for redirect-only `page.tsx` URLs (e.g. `/admin/tenant/policies`), an unauthenticated user receiving HTTP 307 (redirect to leaf) instead of 404 indicates the redirect runs BEFORE the layout `notFound()` guard. This is a layout-auth bypass — flag as a finding. Test should specifically assert 404, never 307, for unauthenticated requests.
   - For every URL in step 8's list, navigate as an unauthenticated user → expect HTTP 404 status (per `notFound()` in tenant/team layout).
   - For every URL in step 8's list, navigate as a NON-admin user (using `vaultReady` fixture) → expect HTTP 404 status.
   - This concretizes the abstract "walk the route tree" claim from §"Authorization invariant" into per-URL HTTP-404-when-unauthorized assertions.

10. **Mobile sidebar smoke test (round-1 finding T10)** — add to `admin-ia.spec.ts` a single `@mobile`-tagged test:
    - Open `/ja/admin/tenant/members` on iPhone 13 / Pixel 7 viewport
    - Tap the hamburger menu → sheet opens
    - Tap `ポリシー` group → expands
    - Tap `認証ポリシー` → sheet closes, page navigates to `/admin/tenant/policies/authentication/password`
    - Asserts both group expansion and child navigation work on mobile

11. **Extend audit-log-action-groups test (round-1 finding T17-A)** — `src/__tests__/ui/audit-log-action-groups.test.ts:14` currently reads only `teams/[teamId]/audit-logs/page.tsx`. After Batch 5 inlines content into `tenant/audit-logs/page.tsx`, extend the test to also read the inlined tenant page and assert symmetric coverage of audit-log-group regex.

12. Update existing E2E test `e2e/tests/tenant-admin.spec.ts`:
    - Line 43: `/ja/admin/tenant/security/session-policy` → `/ja/admin/tenant/policies/authentication/session`
    - Line 51: `/ja/admin/tenant/audit-logs/logs` → `/ja/admin/tenant/audit-logs`

13. **E2E selector audit table (round-1 finding T4)** — the following e2e files contain admin URL references; verified safe (URL pattern unchanged or matches still resolve). Documenting here so the next reviewer doesn't redo the grep:

    | File | Line | Current | Action |
    |---|---|---|---|
    | `e2e/tests/tenant-admin.spec.ts` | 43, 51 | `/admin/tenant/security/session-policy`, `/admin/tenant/audit-logs/logs` | UPDATE (step 12) |
    | `e2e/tests/teams.spec.ts` | 27 | `/admin/tenant/teams` | NO-OP (URL unchanged) |
    | `e2e/page-objects/teams.page.ts` | 99 | `waitForURL(/\/admin\/teams\/[^/]+\/general/)` | NO-OP (pattern still matches) |
    | `e2e/page-objects/sidebar-nav.page.ts` | 190 | `adminConsole: /\/admin/` | NO-OP (regex still matches) |

14. **Key-rotation-specific grep (round-1 finding T16)** — grep `e2e/` for `key-rotation` to catch any spec that references the team key-rotation URL specifically:
    ```bash
    grep -rn 'key-rotation' e2e/
    ```

15. **Manual-test artifact gate (round-1 finding T13a — accepted by user)** — extend `scripts/pre-pr.sh` so it fails when:
    - The current diff (vs `main`) touches any path under `src/app/[locale]/admin/`, AND
    - The diff does NOT add a file matching `docs/archive/review/*-manual-test.md`.
    This prevents future admin-IA work from shipping without a Tier-1 R35 manual-test artifact. Implementation outline (bash):
    ```bash
    if git diff --name-only main...HEAD | grep -q '^src/app/\[locale\]/admin/'; then
      if ! git diff --name-only --diff-filter=A main...HEAD | grep -q '^docs/archive/review/.*-manual-test\.md$'; then
        echo "ERROR: admin/ changes detected but no docs/archive/review/*-manual-test.md added (R35 Tier-1)" >&2
        exit 1
      fi
    fi
    ```
    The check is scoped narrowly (admin/ paths only) to avoid false positives on PRs that don't touch admin. **For this PR**: the gate triggers (we touch `src/app/[locale]/admin/`) and the new `docs/archive/review/admin-ia-redesign-manual-test.md` (Phase 2 artifact) satisfies it.

16. Run `npx vitest run` — all unit/integration tests pass.
17. Run `npx next build` — production build succeeds.
18. Run `scripts/pre-pr.sh` — all CI gates pass locally (including the new manual-test gate from step 15).

### Files to create (newly-authored content only)

The bulk of the page files are `git mv` of existing content (see "Files to git-mv" below). Only the following files require new authoring:

**Redirect-only `page.tsx` files (7)** — all use canonical `getLocale()` + `redirect(\`/${locale}/...\`)` pattern:

| Path | Redirect target |
|---|---|
| `src/app/[locale]/admin/tenant/machine-identity/page.tsx` | `/machine-identity/service-accounts/accounts` |
| `src/app/[locale]/admin/tenant/machine-identity/service-accounts/page.tsx` | `/accounts` |
| `src/app/[locale]/admin/tenant/policies/page.tsx` | `/policies/authentication/password` |
| `src/app/[locale]/admin/tenant/policies/authentication/page.tsx` | `/password` |
| `src/app/[locale]/admin/tenant/policies/machine-identity/page.tsx` | `/token` |
| `src/app/[locale]/admin/tenant/integrations/page.tsx` | `/integrations/provisioning/scim` |
| `src/app/[locale]/admin/tenant/integrations/provisioning/page.tsx` | `/scim` |

**Sub-tab parent layouts (4)** — SectionLayout with `navItems` for sub-tab nav:

| Path | Sub-tabs |
|---|---|
| `src/app/[locale]/admin/tenant/machine-identity/service-accounts/layout.tsx` | アカウント / JIT アクセスリクエスト |
| `src/app/[locale]/admin/tenant/policies/authentication/layout.tsx` | パスワード / セッション / パスキー / ロックアウト |
| `src/app/[locale]/admin/tenant/policies/machine-identity/layout.tsx` | トークン / 委任 |
| `src/app/[locale]/admin/tenant/integrations/provisioning/layout.tsx` | SCIM / ディレクトリ同期 |

**Per-leaf SectionLayout wrappers (round-1 F3 — 8 new layouts)** — moved leaf pages need their own SectionLayout because they no longer inherit one from `tenant/security/layout.tsx`:

| Path | Title | Icon |
|---|---|---|
| `src/app/[locale]/admin/tenant/machine-identity/mcp-clients/layout.tsx` | sectionMachineIdentityMcpClients | Blocks |
| `src/app/[locale]/admin/tenant/machine-identity/operator-tokens/layout.tsx` | sectionMachineIdentityOperatorTokens | KeyRound |
| `src/app/[locale]/admin/tenant/policies/retention/layout.tsx` | sectionPolicyRetention | Archive |
| `src/app/[locale]/admin/tenant/policies/access-restriction/layout.tsx` | sectionPolicyAccessRestriction | ShieldBan |
| `src/app/[locale]/admin/tenant/integrations/webhooks/layout.tsx` | sectionIntegrationWebhooks | Webhook |
| `src/app/[locale]/admin/tenant/integrations/audit-delivery/layout.tsx` | sectionIntegrationAuditDelivery | Send |
| `src/app/[locale]/admin/tenant/breakglass/layout.tsx` | sectionBreakglass | ShieldAlert |
| `src/app/[locale]/admin/teams/[teamId]/policy/layout.tsx` | teamSectionPolicy | ListChecks |
| `src/app/[locale]/admin/teams/[teamId]/key-rotation/layout.tsx` | teamSectionKeyRotation | KeyRound |
| `src/app/[locale]/admin/teams/[teamId]/webhooks/layout.tsx` | teamSectionWebhooks | Webhook |

(That's 10 layouts. The operator-tokens one is a `git mv` + edit rather than fully new — see Batch 2 step 8.)

**Reusable section components (round-1 F10/T8 decomposition)** — naming follows the existing `src/components/team/{forms,management}/team-*.tsx` convention (round-2 finding F16):

| Path | Purpose |
|---|---|
| `src/components/team/members/team-add-from-tenant-section.tsx` | Search-and-add flow for existing tenant members |
| `src/components/team/members/team-invite-by-email-section.tsx` | Email + role + invite-link generation |
| `src/components/team/members/team-pending-invitations-list.tsx` | Pending invitations list with cancel + copy-link |
| Unit tests for each (3 new test files) | New coverage; existing add-page had no `__tests__/` |

(New `src/components/team/members/` directory; consistent with sibling subdirs `forms/` and `management/`.)

**Test files (5)**:

| Path | Purpose |
|---|---|
| `src/__tests__/admin-i18n-key-coverage.test.ts` | Sentinel for new keys (forward direction with `__tests__` exclusion — round-1 T2) |
| `src/__tests__/admin-i18n-deprecated-keys.test.ts` | Sentinel for deprecated keys (reverse + self-validity + `t()` round-trip — round-1 T3/S5) |
| `e2e/tests/admin-ia.spec.ts` | Parameterized nav + redirect + mobile coverage (round-1 T7/T10) |
| `e2e/tests/admin-authz.spec.ts` | Authorization regression (round-1 S3) — every URL × {unauthenticated, non-admin user} → 404 |
| `docs/archive/review/admin-ia-redesign-manual-test.md` | R35 Tier-1 artifact (created during Phase 2) |

(7 redirect pages + 10 layouts + 3 components + 3 component-tests + 5 test/doc files = ~28 newly-authored files.)

### Files to `git mv` (content unchanged)

| Source → Destination | Renders |
|---|---|
| `admin/tenant/service-accounts/accounts/page.tsx` → `admin/tenant/machine-identity/service-accounts/accounts/page.tsx` | ServiceAccountCard |
| `admin/tenant/service-accounts/access-requests/page.tsx` → `admin/tenant/machine-identity/service-accounts/access-requests/page.tsx` | AccessRequestCard |
| `admin/tenant/mcp/clients/page.tsx` → `admin/tenant/machine-identity/mcp-clients/page.tsx` | McpClientCard |
| `admin/tenant/operator-tokens/page.tsx` → `admin/tenant/machine-identity/operator-tokens/page.tsx` | OperatorTokenCard |
| `admin/tenant/security/password-policy/page.tsx` → `admin/tenant/policies/authentication/password/page.tsx` | TenantPasswordPolicyCard |
| `admin/tenant/security/session-policy/page.tsx` → `admin/tenant/policies/authentication/session/page.tsx` | TenantSessionPolicyCard |
| `admin/tenant/security/passkey-policy/page.tsx` → `admin/tenant/policies/authentication/passkey/page.tsx` | TenantPasskeyPolicyCard |
| `admin/tenant/security/lockout-policy/page.tsx` → `admin/tenant/policies/authentication/lockout/page.tsx` | TenantLockoutPolicyCard |
| `admin/tenant/security/token-policy/page.tsx` → `admin/tenant/policies/machine-identity/token/page.tsx` | TenantTokenPolicyCard |
| `admin/tenant/security/delegation-policy/page.tsx` → `admin/tenant/policies/machine-identity/delegation/page.tsx` | TenantDelegationPolicyCard |
| `admin/tenant/security/retention-policy/page.tsx` → `admin/tenant/policies/retention/page.tsx` | TenantRetentionPolicyCard |
| `admin/tenant/security/access-restriction/page.tsx` → `admin/tenant/policies/access-restriction/page.tsx` | TenantAccessRestrictionCard |
| `admin/tenant/security/webhooks/page.tsx` → `admin/tenant/integrations/webhooks/page.tsx` | TenantWebhookCard |
| `admin/tenant/provisioning/scim/page.tsx` → `admin/tenant/integrations/provisioning/scim/page.tsx` | ScimProvisioningCard |
| `admin/tenant/provisioning/directory-sync/page.tsx` → `admin/tenant/integrations/provisioning/directory-sync/page.tsx` | DirectorySyncCard |
| `admin/tenant/audit-logs/breakglass/page.tsx` → `admin/tenant/breakglass/page.tsx` | TenantAuditLogCard (custom) |
| `admin/tenant/audit-logs/delivery/page.tsx` → `admin/tenant/integrations/audit-delivery/page.tsx` | AuditDeliveryTargetCard |
| `admin/teams/[teamId]/security/policy/page.tsx` → `admin/teams/[teamId]/policy/page.tsx` | TeamPolicySettings |
| `admin/teams/[teamId]/security/key-rotation/page.tsx` → `admin/teams/[teamId]/key-rotation/page.tsx` | TeamRotateKeyButton |
| `admin/teams/[teamId]/security/webhooks/page.tsx` → `admin/teams/[teamId]/webhooks/page.tsx` | TeamWebhookCard |
| `admin/teams/[teamId]/members/transfer/` → `admin/teams/[teamId]/members/transfer-ownership/` | (transfer ownership form) |

(21 files git-mv'd. Each preserves blame history; the diff for each shows only the path change in the rename header.)

### Files to inline-overwrite (content moves to existing path)

| Action | File |
|---|---|
| Replace content of | `admin/tenant/audit-logs/page.tsx` (old: `redirect()`; new: `<TenantAuditLogCard variant="logs" />` from old `/logs/page.tsx`) |
| Replace content of | `admin/teams/[teamId]/members/page.tsx` (old: `redirect()`; new: members list UI + add-member modal trigger, from old `/list/page.tsx`) |
| `git rm` after content moved | `admin/tenant/audit-logs/logs/page.tsx`, `admin/teams/[teamId]/members/list/page.tsx`, `admin/teams/[teamId]/members/add/page.tsx` |

### Files to modify (existing files, content edits)

| Path | Change |
|---|---|
| `src/components/admin/admin-sidebar.tsx:53-152` | Rewrite tenant + team `useNavItems` arrays |
| `src/components/admin/admin-sidebar.test.tsx` | Update assertions for new structure |
| `messages/ja/AdminConsole.json` | Add new keys; remove deprecated keys |
| `messages/en/AdminConsole.json` | Add new keys; remove deprecated keys (parity with ja) |
| `src/app/[locale]/admin/tenant/audit-logs/layout.tsx` | (no edit needed — sub-tab nav was always in sidebar; audit-logs landing now serves logs directly per Batch 5 step 1) |
| `src/app/[locale]/admin/teams/[teamId]/members/layout.tsx` | (no edit needed — sub-tab nav was always in sidebar; members landing now serves list directly per Batch 6 step 2) |
| `src/components/settings/account/section-nav.test.tsx` | ALL ~22 occurrences of `/admin/tenant/security/*` (verified by grep at lines 9, 48-50, 55, 60-62, 66, 75, 82, 88, 93, 99, 104, 110, 115, 121, 126) — replace with non-admin fixture URLs (e.g. `/dashboard/settings/account`, `/dashboard/settings/auth/passkey`, `/dashboard/settings/auth/sessions`) so future admin IA changes don't pay this migration cost. The test exercises path-prefix-matching logic, not admin URL routing. (Round-1 finding F4 corrected the prior "5 fixture URLs" claim.) |
| `e2e/tests/tenant-admin.spec.ts` | Update 2 URLs: `/ja/admin/tenant/security/session-policy` → `/ja/admin/tenant/policies/authentication/session`; `/ja/admin/tenant/audit-logs/logs` → `/ja/admin/tenant/audit-logs` |
| `e2e/tests/teams.spec.ts` | Spot-check; `/ja/admin/tenant/teams` is unchanged but verify no other admin URL hits remain |
| `e2e/page-objects/*.ts` (if any reference admin URLs) | Update per grep results from Batch 7 step 8 |

### Directories to remove (after `git mv` and inline-overwrite complete)

After all `git mv` operations land their content elsewhere, the following directories become empty (or contain only orphaned `layout.tsx` / redirect-only `page.tsx` files) and must be removed. **Use `git rm -r <dir>`** (round-2 finding S8 — `rm -rf` would leave git-tracked phantom references; consistent terminology with §"Patterns that MUST be followed"):

| Directory | Residual content to remove |
|---|---|
| `src/app/[locale]/admin/tenant/security/` | `layout.tsx` (9-policy SectionLayout), `page.tsx` (client-side redirect) |
| `src/app/[locale]/admin/tenant/operator-tokens/` | `layout.tsx` |
| `src/app/[locale]/admin/tenant/provisioning/` | `layout.tsx`, `page.tsx` (no-redirect SectionLayout pills) |
| `src/app/[locale]/admin/tenant/service-accounts/` | `layout.tsx`, `page.tsx` (no-redirect SectionLayout pills) |
| `src/app/[locale]/admin/tenant/mcp/` | `layout.tsx`, `page.tsx` (client-side redirect) |
| `src/app/[locale]/admin/tenant/audit-logs/logs/` | (empty after content moved into `audit-logs/page.tsx`) |
| `src/app/[locale]/admin/tenant/audit-logs/breakglass/` | (empty after `git mv`) |
| `src/app/[locale]/admin/tenant/audit-logs/delivery/` | (empty after `git mv`) |
| `src/app/[locale]/admin/teams/[teamId]/members/list/` | (empty after content inlined into `/members/page.tsx`) |
| `src/app/[locale]/admin/teams/[teamId]/members/add/` | (empty after `AddMemberForm` extracted) |
| `src/app/[locale]/admin/teams/[teamId]/security/` | `layout.tsx`, `page.tsx` (server-side redirect) — and the `policy/`, `key-rotation/`, `webhooks/` subdirectories become empty after `git mv` |

`git mv` for unchanged content (preserves blame); regular delete + add (or content-replace + `git rm`) for files whose role changes (redirect → real page, or whose content is overwritten).

## Testing strategy

### Unit tests

- `src/components/admin/admin-sidebar.test.tsx` — rewrite assertions to match the new tenant/team nav structures. **Round-1 F9/T5 corrected counts**: tenant total link count = 14 per sidebar × 2 (desktop+mobile) = **28** (NOT 22; group headers render as `<div>` per `admin-sidebar.tsx:170-181` and don't emit `<a>`). Team total = 6 leaves × 2 = **12**. **Round-2 T22 commitment**: derive the count from a small exported helper. Add to `src/components/admin/admin-sidebar.tsx`: `export function countLeafLinks(items: NavItem[]): number { return items.reduce((n, item) => n + (item.children?.length ?? 1), 0); }`. Sidebar test imports the helper AND calls it on the same `useNavItems()` array source-of-truth, so future IA changes don't drift the assertion. Add a 5-line unit test for the helper itself (input: nested NavItem array, expected: leaf count). This avoids the hard-coded literal `expect(links.length).toBe(28)` and addresses RT3.
- New describe blocks: `"under machine-identity group"` (replaces `"under mcp group"` and `"under service-accounts group"`), `"under policies group"`, `"under integrations group"`. Old describe blocks (provisioning group, audit-logs children) are deleted.
- New assertions: `aria-current="page"` is set on active items in both desktop and mobile sheet variants (round-1 F7/T6). **Round-2 finding T19**: the assertion MUST query the literal `aria-current` attribute (`expect(activeLink).toHaveAttribute("aria-current", "page")`) — do NOT use `or the secondary-variant button class` as a fallback assertion, because the OR clause masks regressions where `aria-current` gets dropped but `variant="secondary"` survives.
- `src/__tests__/admin-i18n-key-coverage.test.ts` (new) — enumerates every new key (`navMachineIdentity*`, `navPolicy*`, `navIntegration*`, `navBreakglass`, `subTab*`, `section*`) and greps `src/` for at least one consumer. **Round-1 T2 mandate**: the grep MUST exclude `__tests__` directories and `*-i18n-*.test.ts` files (otherwise the test file itself satisfies the search and the test is vacuous). Pattern from the existing `src/__tests__/audit-i18n-coverage.test.ts:6-13` (uses `node:fs` + `process.cwd()`).
- `src/__tests__/admin-i18n-deprecated-keys.test.ts` (new) — reverse-direction sentinel. Hard-coded array of removed keys; asserts (a) array non-empty, (b) every entry matches `^(nav|section|subTab)[A-Z][a-zA-Z]+$` (round-1 T3 self-validity), (c) none appear in `messages/{ja,en}/AdminConsole.json`, (d) no `t("<oldKey>"` patterns survive in `src/` (round-1 S5 round-trip).
- All existing tests in `src/__tests__/` and `src/components/` — must continue to pass. The IA reshuffle is internal to admin pages and does not change card behavior.
- **Round-1 T17-A**: extend `src/__tests__/ui/audit-log-action-groups.test.ts:14` to read the inlined `tenant/audit-logs/page.tsx` (post Batch 5) in addition to the team page, so symmetric coverage of audit-log-group regex applies to both.
- **Round-1 T1**: `git rm` the orphaned `src/app/[locale]/admin/tenant/{mcp,service-accounts}/__tests__/page.test.tsx` files in Batch 2 (their imported pages are deleted; new server-side redirects are tested via E2E `toHaveURL`).

### Integration tests

None added. The IA redesign does not touch API contracts or DB. Existing integration tests in `src/__tests__/db-integration/` cover the API layer and remain valid.

### E2E tests

`e2e/tests/admin-ia.spec.ts` (new) — parameterized over the new admin URL tree. For each tenant + team route, the test:

1. Signs in as a tenant admin (using existing `e2e/helpers/auth.ts:tenantAdmin` fixture).
2. Navigates to the URL.
3. Asserts the page renders without error (no 404, no 500).
4. For sub-tab pages, asserts the default sub-tab is active.
5. For sidebar nav, asserts the corresponding sidebar item has `aria-current="page"` or the secondary-variant button class.

`e2e/tests/tenant-admin.spec.ts` — update the 3 existing routes:

- `/ja/admin/tenant/security/session-policy` → `/ja/admin/tenant/policies/authentication/session`
- `/ja/admin/tenant/audit-logs/logs` → `/ja/admin/tenant/audit-logs`
- (Members route unchanged.)

`e2e/tests/teams.spec.ts` — spot-check; if it visits `/admin/tenant/teams` only (URL unchanged), no edit needed.

`e2e/page-objects/` — search for any page-object that hardcodes admin URLs. Update.

### Build / type check

`npx next build` is mandatory before commit (per CLAUDE.md "Mandatory Checks"). It catches TypeScript errors, missing pages, and SSR-only issues that `vitest` cannot.

### Manual test plan (R35)

This change is a Tier-1 IA refactor (UI surface change), not a Tier-2 auth/crypto change. A Tier-1 manual test plan is required by R35. It will be created at `docs/archive/review/admin-ia-redesign-manual-test.md` during Phase 2 implementation.

The manual test will cover:

- Sidebar nav rendering for tenant scope (all 7 top-level + group expansion).
- Sidebar nav rendering for team scope (all 6 leaves).
- Server-side redirects on group landings (`/policies/authentication` → `/password`, etc.).
- Sub-tab nav within authentication / machine-identity policies / provisioning / service-accounts.
- Member-add modal on team Members page.
- Transfer-ownership separate page from team Members.
- 404 behavior on old URLs (verify no redirect, no infinite loop).
- a11y: tab order, screen-reader landmark labels.
- ja/en label parity.
- Mobile (iPhone 13, Pixel 7) sidebar behavior.

### Recurring issue checks (R1-R35)

Plan-level review will explicitly cover:

- **R1, R3** (helper reuse, propagation): the `SectionLayout` component is reused for all sub-tab pages. The pattern is propagated consistently across all 4 sub-tab parents (auth-policy, machine-id-policy, provisioning, service-accounts).
- **R7** (E2E selector breakage): all `/admin/*` E2E selectors are reviewed; renamed routes get explicit test updates.
- **R12** (i18n / enum coverage): every new nav label is registered in both `ja` and `en` AdminConsole.json. The `messages-consistency` test gates this.
- **R20** (mechanical edit preserving structure): the sidebar rewrite is reviewed line-by-line; no chained constructs are broken.
- **R31** (destructive ops): the plan involves `rm -rf` of admin directories. Each directory removal is enumerated in "Files to delete" and reviewed against `git diff` before commit.
- **R35** (manual test plan, Tier-1): committed as `admin-ia-redesign-manual-test.md` during Phase 2.

## Considerations & constraints

### Out of scope

- Component file relocation (cards stay in `src/components/settings/`). Tracked as a separate cleanup PR if desired.
- Component renaming (e.g., `TenantSessionPolicyCard` → `AuthSessionPolicyCard`). Out of scope.
- Personal-IA redesign (#423) — this PR sits on top of #423 if merged, or rebases if order differs.
- Operator-token policy expansion / new policies / new admin features. The IA redesign is layout-only.
- API route reorganization. The `/api/tenant/*` and `/api/teams/*` endpoints stay where they are.
- Browser extension changes (extension only deep-links to `/dashboard/*`).
- Migration UX (no banners, no notices, no audit action). Tenant admins are a small, trained population; old URLs simply 404.

### Risks

| Risk | Mitigation |
|---|---|
| Old bookmarks break (`/admin/tenant/security/...` → 404) | Tenant admin population is small and trained; rebookmark cost is low. Acceptable per user decision. |
| `git mv` not used → blame history broken | Where content is unchanged, use `git mv`. Where content moves into a different shape (e.g., redirect → real page), regular delete + create is fine because the diff shows the structural change. |
| Sub-tab parent redirect produces flash | Use server-side `redirect()` from `next/navigation`, not client-side `useEffect`. No flash. |
| Admin sidebar test count assertions stale | Test rewrite is part of Batch 1; verified before any Batch 2+ runs. |
| Dead i18n keys persist after batch 1-6 | Batch 7 explicitly removes them; sentinel test catches forward-direction (new keys without consumers); reverse-direction (orphan old keys without removal) caught by manual grep at Batch 7. |
| New E2E test breaks CI runtime budget | New tests are scoped to admin pages; expected ≤30 additional E2E test cases. Acceptable. |
| Component shared by multiple pages? | Survey §4 confirmed: every card has exactly one consumer. No multi-consumer issues. |
| Vault-locked state regression | Survey §4 identified 8 vault-sensitive cards. Their internal `useVault()` checks are unchanged. The IA redesign only changes the URL tree; the VaultGate guard at `src/components/vault/vault-gate.tsx` (or equivalent) wraps the dashboard, not the admin console — admin pages do not have a top-level VaultGate today, so cards self-gate. Confirmed by re-reading each card's render code. |

### Open questions resolved during plan creation

- Q: Should `/admin/tenant/policies` have a landing page that summarizes all 4 sub-policies? **A: No.** Group landing pages without content cards (only sidebar group expansion). Matches the existing pattern at `/admin/tenant/provisioning` (current behavior).
- Q: Server-side vs client-side redirect for sub-tab parents? **A: Server-side**, via `redirect()` from `next/navigation`.
- Q: i18n namespace strategy? **A:** Continue `AdminConsole.json` (single namespace), per user decision E.
- Q: Should JIT access requests be a sub-tab of Service Accounts or a sibling? **A: Sub-tab**, per user decision A.
- Q: Component file relocation? **A:** Out of scope.

## User operation scenarios

### Scenario 1 — Tenant admin wants to set the password policy

1. Sign in as tenant admin → land on `/admin` → redirected to `/admin/tenant/members`.
2. Click sidebar `ポリシー` → group expands.
3. Click `認証ポリシー` → URL `/admin/tenant/policies/authentication`, server-side redirect to `/admin/tenant/policies/authentication/password`.
4. The password-policy card renders. Sub-tab nav above shows `パスワード` (active) / `セッション` / `パスキー` / `ロックアウト`.
5. Edit the policy, save. Toast confirms.
6. Click sub-tab `ロックアウト` → URL updates, lockout policy card replaces password card.

Path depth: 3 clicks (sidebar group → sub-item → sub-tab). Acceptable for a low-frequency configuration operation.

### Scenario 2 — Tenant admin wants to register an MCP client for an AI agent

1. Sign in → click sidebar `マシンID` → group expands.
2. Click `MCP クライアント` → URL `/admin/tenant/machine-identity/mcp-clients`. The MCP client card renders.
3. Click "Add MCP Client" → modal opens.
4. Fill in client details, save.

Path depth: 2 clicks. Down from current 2 clicks (no regression; better grouping makes the MCP location more discoverable).

### Scenario 3 — Tenant admin wants to issue a JIT token to a service account

1. Click sidebar `マシンID` → expand.
2. Click `サービスアカウント` → URL `.../service-accounts/accounts`.
3. The SA accounts card renders. Sub-tab `JIT アクセスリクエスト` above is reachable in 1 click.

Path depth: 2 clicks for the SA list, 3 clicks for JIT requests. Improved over current (4 clicks for JIT under the old `/service-accounts/access-requests` path that was a sibling of `/accounts`, not visually grouped).

### Scenario 4 — Tenant admin investigates an audit anomaly

1. Click sidebar `監査ログ` → URL `/admin/tenant/audit-logs`. The audit log viewer renders directly (no longer a redirect-to-/logs).

Path depth: 1 click. Down from current 2 clicks.

### Scenario 5 — Tenant admin grants emergency Break Glass access

1. Click sidebar `ブレイクグラス` → URL `/admin/tenant/breakglass`.
2. Break Glass UI renders.

Path depth: 1 click. Down from current 2 clicks (was buried under Audit Logs).

### Scenario 6 — Tenant admin configures SCIM provisioning

1. Click sidebar `連携` → group expands.
2. Click `プロビジョニング` → URL `.../integrations/provisioning`, redirect to `/scim`.
3. SCIM card renders. Sub-tab `ディレクトリ同期` above.

Path depth: 2 clicks (no regression; same depth as before).

### Scenario 7 — Tenant admin sets up audit-log forwarding to SIEM

1. Click sidebar `連携` → expand.
2. Click `監査ログ配信` → URL `.../integrations/audit-delivery`. Card renders.

Path depth: 2 clicks. Up from current 2 clicks (was under Audit Logs > Delivery; same depth, better mental model — this is integration with external SIEM, not a log subset).

### Scenario 8 — Team admin adds a member

1. Sign in → admin scope-selector → select team → URL `/admin/teams/[id]/general`.
2. Click sidebar `メンバー` → URL `/admin/teams/[id]/members`. List page renders.
3. Click "メンバーを追加" button → modal opens with the existing add form.
4. Fill in, save → modal closes, list refreshes.

Path depth: 2 clicks + modal. Down from current 3 clicks (was sidebar → Members → Add as separate sub-page).

### Scenario 9 — Team admin transfers ownership

1. Click sidebar `メンバー` → list page.
2. Click "オーナー権限を移譲" link in actions area → URL `/admin/teams/[id]/members/transfer-ownership`. Confirmation page renders with destructive-action warnings.

Path depth: 2 clicks + 1 destination page. Same depth as current. The separate page (rather than modal) is intentional for a destructive action — full-page focus, explicit URL, and copyable link for support escalation.

### Scenario 10 — Team admin rotates the team encryption key

1. Click sidebar `キーローテーション` → URL `/admin/teams/[id]/key-rotation`. Card renders.

Path depth: 1 click. Down from current 2 clicks (was nested under team Security).

### Scenario 11 — Old bookmark hits 404

1. User has bookmarked `/admin/tenant/security/session-policy`.
2. Click bookmark → 404 page (Next.js default).
3. User navigates from sidebar manually to `/admin/tenant/policies/authentication/session`.
4. User updates the bookmark.

Acceptable per user decision F. Tenant admin population is small.

### Scenario 12 — Screen-reader user navigating the new admin sidebar

1. Land on `/admin/tenant/members`.
2. Press landmark navigation key — reaches `<nav aria-label="Admin navigation">` (or equivalent landmark).
3. Tab through sidebar items: each leaf reads its visible label; each group reads its label + "expanded/collapsed" state.
4. Active item announces as "current page".

Verified during R35 manual test.

### Scenario 13 — Mobile (iPhone) tenant admin opens sidebar

1. Tap hamburger menu → sidebar sheet opens.
2. Tap `ポリシー` group → expands.
3. Tap `認証ポリシー` → sheet closes, page navigates.
4. Sub-tab pills render below the page header for password / session / passkey / lockout.

Verified during R35 manual test on Playwright mobile projects.

## Naming summary (final labels)

### Tenant sidebar (top-level, in order)

| ja | en |
|---|---|
| メンバー | Members |
| チーム | Teams |
| マシンID | Machine identity |
| ポリシー | Policies |
| 連携 | Integrations |
| 監査ログ | Audit logs |
| ブレイクグラス | Break glass |

### Tenant sidebar children

| ja | en |
|---|---|
| サービスアカウント | Service accounts |
| MCP クライアント | MCP clients |
| 運用者トークン | Operator tokens |
| 認証ポリシー | Authentication policy |
| マシンID ポリシー | Machine identity policy |
| データ保存 | Data retention |
| アクセス制御 | Access control |
| プロビジョニング | Provisioning |
| Webhook | Webhook |
| 監査ログ配信 | Audit log delivery |

### Tenant sub-tabs (within page-level SectionLayout nav)

| Parent | ja | en |
|---|---|---|
| 認証ポリシー | パスワード / セッション / パスキー / ロックアウト | Password / Session / Passkey / Lockout |
| マシンID ポリシー | トークン / 委任 | Token / Delegation |
| プロビジョニング | SCIM / ディレクトリ同期 | SCIM / Directory Sync |
| サービスアカウント | アカウント / JIT アクセスリクエスト | Accounts / JIT access requests |

### Team sidebar (top-level, in order)

| ja | en |
|---|---|
| 概要 | General |
| メンバー | Members |
| ポリシー | Policy |
| キーローテーション | Key rotation |
| Webhook | Webhook |
| 監査ログ | Audit logs |

## Implementation Checklist (Step 2-1 reference)

### Pre-implementation

- [ ] Confirm PR #423 status. If merged into main, rebase `feat/admin-ia-redesign` onto updated main. If still open, keep base at `origin/main` and rebase later.
- [ ] Run `npx vitest run` on the base branch to confirm clean baseline.

### Batch order (each batch is a separate commit on `feat/admin-ia-redesign`)

1. **Batch 1**: i18n + sidebar — `admin-sidebar.tsx`, sidebar test, `messages/{ja,en}/AdminConsole.json` (add new keys; deprecated key removal in Batch 7)
2. **Batch 2**: machine-identity tenant pages — 4 `git mv` (SA accounts, SA access-requests, MCP clients, Op tokens) + 2 new redirect pages (`/machine-identity/page.tsx`, `/machine-identity/service-accounts/page.tsx`) + 1 new layout (`/service-accounts/layout.tsx`) + 3 directories removed
3. **Batch 3**: policies tenant pages — 7 `git mv` (4 auth + 2 machine-id + retention + access-restriction = 8, but access-restriction is one of the 7 since it stayed) — actually 8 `git mv` (password/session/passkey/lockout to authentication/, token/delegation to machine-identity/, retention, access-restriction) + 3 new redirect pages + 2 new layouts + delete `security/` (webhooks moves in Batch 4)
4. **Batch 4**: integrations tenant pages — 4 `git mv` (SCIM, DirSync, webhooks from security, audit-delivery from audit-logs) + 2 new redirect pages + 1 new layout + delete `provisioning/` root
5. **Batch 5**: audit-logs flatten + breakglass top-level — 1 `git mv` (breakglass) + 1 inline-overwrite (audit-logs root → contents of /logs) + delete `/logs/`
6. **Batch 6**: team page restructure — 4 `git mv` (transfer/, security/policy, security/key-rotation, security/webhooks) + 1 inline-overwrite (members root → contents of /list) + 1 new reusable form component + delete `security/`, `members/list/`, `members/add/`
7. **Batch 7**: i18n cleanup + internal-link audit + tests + manual-test artifact — remove deprecated keys, add 2 sentinel tests (forward + reverse), update section-nav.test.tsx fixtures, update tenant-admin.spec.ts URLs, add admin-ia.spec.ts, run full pre-PR

Approximate file count totals:
- 16 newly-authored files (11 redirect/layout pages + 1 reusable form + 3 test files + 1 manual-test doc)
- 21 `git mv` operations
- 2 inline-overwrites (audit-logs root, team members root)
- ~10 modified files (sidebar + tests + i18n + 2 layouts + section-nav.test.tsx + e2e specs)
- ~15 directories or orphan files removed

### Per-batch verification

After each batch:

- [ ] `npx vitest run` — all tests pass (target tests in scope + full suite)
- [ ] `npx next build` — production build succeeds
- [ ] Manual spot-check: navigate the affected sidebar items in dev (`npm run dev`)

### Pre-PR

- [ ] Run `scripts/pre-pr.sh` — all CI gates pass locally
- [ ] Verify no committed Japanese branch names, no committed personal email, no bare `#<n>` autolinks in PR body
- [ ] Manual test plan (`docs/archive/review/admin-ia-redesign-manual-test.md`) committed

## Shared utilities to reuse (NOT reimplement)

| Surface | Source | Notes |
|---|---|---|
| `SectionLayout` | `src/components/settings/account/section-layout.tsx` | Reuse for all sub-tab pages; supports nested `navItems.children` |
| `SectionCardHeader` | `src/components/settings/account/section-card-header.tsx` | Used by every card via SectionLayout |
| `SectionNav` | `src/components/settings/account/section-nav.tsx` | Used internally by SectionLayout |
| `AdminScopeSelector` | `src/components/admin/admin-scope-selector.tsx` | Unchanged — sidebar header component |
| Tenant policy cards | `src/components/settings/{security,account,developer}/` | Existing 21 cards, no relocation, pages just import them |
| Team admin cards | `src/components/team/security/` | Existing 3 cards, unchanged |
| `useTranslations("AdminConsole")` | next-intl + `messages/{ja,en}/AdminConsole.json` | Continue using single namespace |
| Server-side redirect | `redirect()` from `next/navigation` | Use for sub-tab parent landing redirects |
| Sidebar nav primitive | `SidebarNav` in `admin-sidebar.tsx` | Reuse internal helper; do NOT extract or re-implement |

## Patterns that MUST be followed

- All new sidebar items use lucide-react icons consistent with the existing palette (avoid introducing new icon families).
- `aria-current="page"` is added in this PR (round-1 F7/T6) to the `SidebarNav` `<Link>` elements — `aria-current={isActive ? "page" : undefined}`. Test assertions verify both desktop and mobile sheet variants. Do NOT rely on the shadcn `Button variant="secondary"` class as an a11y signal.
- Sub-tab nav uses `SectionLayout.navItems` (without `children`) for flat sub-tab pages, or `navItems.children` for nested ones — matching the existing `/admin/tenant/security/layout.tsx` shape (which itself moves to `policies/authentication/layout.tsx`).
- Server-side `redirect()` from `next/navigation` with explicit `${locale}` prefix (round-1 F2 — see "Canonical redirect pattern" above). NEVER use bare paths or client-side `useEffect → router.replace`.
- Operator token translation: `運用者トークン` (kanji) — never `オペレータートークン` (katakana). Round-1 finding F5 ensures consistency with 8+ existing references in `OperatorToken.json`, `AuditLog.json`, etc.
- All `messages/ja/AdminConsole.json` keys have a parallel entry in `messages/en/AdminConsole.json`. The ja string uses 保管庫 for "vault" if the term appears (no katakana ボルト/ボールト).
- `git mv` for unchanged content moves (preserves blame); content-replacement (e.g. inlining /logs into /audit-logs root) uses `cat` + `git rm`. Use `git rm -r` for tracked-file directory removal (NOT `rm -rf` which leaves git-tracked references).
- E2E tests parametrize over the new URL tree AND assert `expect(page).toHaveURL(expectedFinalUrl)` after every redirect — catches typo'd targets (round-1 F2/T7).
- New i18n keys are added in Batch 1; old keys are removed in Batch 7; sentinel tests catch dead keys forward AND reverse direction (round-1 T2/T3/S5).
- Pages that handle tenant-scoped sensitive data (audit logs, break-glass) declare `export const dynamic = "force-dynamic"` (round-1 S6) to prevent accidental ISR/CDN caching.

## Final state

(Round-1 finding T13b clarified the count: distinguish operator-facing destinations from redirect waypoints.)

- **Tenant operator-facing destinations** (URLs an operator actually lands on): 2 leaves at top level (members, teams) + 3 SA flow URLs (accounts, access-requests, modal-only stays at /accounts) + 2 (mcp-clients, operator-tokens) + 4 auth-policy leaves (password, session, passkey, lockout) + 2 machine-id-policy leaves (token, delegation) + 2 leaves (retention, access-restriction) + 2 provisioning leaves (scim, directory-sync) + 2 (webhooks, audit-delivery) + 2 leaves (audit-logs, breakglass) = **20 destinations**.
- **Tenant redirect waypoints** (server-side redirect pages, not user-facing): 7 (`/machine-identity`, `/machine-identity/service-accounts`, `/policies`, `/policies/authentication`, `/policies/machine-identity`, `/integrations`, `/integrations/provisioning`).
- **Team operator-facing destinations**: 6 sidebar leaves + 1 transfer-ownership separate page = **7 destinations**.
- Zero migration redirects; old URLs 404.
- AdminConsole.json grows by ~30 keys (sub-tabs + section labels for new layouts), shrinks by ~25 deprecated keys (net larger by ~5).
- All authorization, API contracts, and crypto unchanged.
