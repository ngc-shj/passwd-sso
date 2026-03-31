# Settings UI Reorganization Plan

## Problem

1. **Tenant settings**: 6 horizontal tabs (`grid-cols-6`) collapse on narrow screens
2. **Nested tabs**: 2-level tab nesting (main tab + subtab) creates visual complexity
3. **Imbalance**: Some tabs contain a single card (Audit Log, Webhooks), while others are packed (Machine Identity has 3 subtabs)
4. **Context mismatch**: Personal Developer > Delegation is MCP-specific but lives alongside generic CLI/API key management
5. **Vault and Admin are mixed**: Vault navigation and organizational management share the same sidebar, unlike 1Password and Bitwarden which fully separate them

## Competitive Research

Both 1Password and Bitwarden share these patterns:

| Pattern | 1Password | Bitwarden |
|---------|-----------|-----------|
| Vault layout | 3-pane (sidebar + list + detail) | 3-pane (same) |
| Admin | **Completely separate context** (`/admin`) | **Completely separate context** (`/organizations/{id}`) |
| Personal settings | Full-page replacement in vault context | Full-page replacement in vault context |
| Context switch | Avatar menu → "Admin Console" | Sidebar bottom → "Admin Console" |
| Admin ↔ Vault return | "Go to vaults" link in admin | "← Back to vault" link in admin |
| Mobile | Stack-based 1-pane drill-down | Bottom tab bar + drill-down |

Key insight: **Personal settings stay in the Vault context**. Admin Console covers only organizational concerns (team/tenant).

## Current Structure

```
Vault Sidebar (single context):
├── Vault items (passwords, favorites, archive, trash, ...)
├── Security (Watchtower, Emergency Access)
├── Settings
│   ├── Personal Settings → /dashboard/settings?tab=X
│   ├── Tenant Settings  → /dashboard/tenant
│   └── Team Management  → /dashboard/teams
└── Tools (Export, Import)

Personal Settings (/dashboard/settings?tab=X)
├── Account          → Sessions
├── Security         → [Passkey | Travel Mode | Key Rotation]
└── Developer        → [CLI Token | API Keys | Delegation]

Team Settings (/dashboard/teams/[id]/settings)
├── General          → Name/Desc/Delete
├── Members          → [List | Add | Transfer Ownership]
├── Security Policy  → [Policy Settings | Key Rotation]
└── Webhooks         → Webhook card

Tenant Settings (/dashboard/tenant)
├── Members          → Members card
├── Security         → Session Policy + Access Restriction
├── Provisioning     → [SCIM | Directory Sync]
├── Machine Identity → [Service Accounts | MCP Clients | Access Requests]
├── Audit Log        → Audit log card
└── Webhooks         → Webhook card
```

## Proposed Architecture

### Core Decision: Vault / Admin Context Separation

Two distinct UI contexts with **hard boundary**, following 1Password/Bitwarden pattern:

```
┌─ Vault Context (/dashboard/*) ──────────────────────┐
│                                                      │
│  Sidebar: vault nav, categories, tags, folders       │
│  + Personal Settings (⚙ icon at bottom)              │
│  + "管理コンソール →" link (admin users only)          │
│                                                      │
└──────────────────────────────────────────────────────┘
         │ click "管理コンソール"
         ▼
┌─ Admin Context (/admin/*) ───────────────────────────┐
│                                                      │
│  Header: "← 保管庫に戻る"  +  "管理コンソール" title   │
│  Sidebar: scope selector + scope-specific nav         │
│                                                      │
│  Visual differentiation (muted header, different      │
│  accent) so user clearly knows they're in admin       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Admin Context: Scope Selector (案A)

Mirror the VaultSelector pattern. A combobox at the top of the admin sidebar
selects the management scope. The sidebar nav items change based on scope.

```
┌──────────────────────────────────────────┐
│ ← 保管庫に戻る        🏢 管理コンソール   │
├──────────┬───────────────────────────────┤
│[テナント▾]│                               │
│ ────────  │                               │
│ ○ チームA │  [コンテンツ]                  │
│ ○ チームB │                               │
│ ────────  │                               │
│ ● テナント│                               │
│           │                               │
│ メンバー  │                               │
│ セキュリティ│                              │
│ プロビ... │                               │
│ マシンID  │                               │
│ 監査ログ  │                               │
├──────────┴───────────────────────────────┤
```

Scope-specific nav items:

| Scope | Nav items |
|-------|-----------|
| **Team** | General / Members / Security (policy + key rotation + webhooks) / Audit Logs |
| **Tenant** | Members / Security (session policy + access restriction + webhooks) / Provisioning / Machine Identity / Audit Logs |

### Personal Settings: Stays in Vault Context

Personal settings is **not admin**. It stays in the Vault context as a full-page
replacement (like 1Password/Bitwarden).

```
/dashboard/settings/                  ← layout with vertical nav or stacked cards
├── /account                          ← Sessions
├── /security                         ← Passkey + Travel Mode + Key Rotation (stacked, no subtabs)
└── /developer                        ← CLI Token + API Keys (stacked, no subtabs)
                                         Delegation moves to Admin > Tenant > Machine Identity
```

### Detailed Page Structure

#### Personal Settings (Vault context)

```
/dashboard/settings/account           ← SessionsCard
/dashboard/settings/security          ← PasskeyCredentialsCard + TravelModeCard + RotateKeyCard
/dashboard/settings/developer         ← CliTokenCard + ApiKeyManager
```

Changes:
- Remove all subtabs — stack cards vertically
- Move Delegation to Admin > Tenant > Machine Identity
- 3 pages, 0 nesting

#### Admin > Team (per team)

```
/admin/teams/[teamId]/general         ← Name/Desc/Delete
/admin/teams/[teamId]/members         ← List + Add + Invite + Transfer (stacked sections)
/admin/teams/[teamId]/security        ← Policy + Key Rotation + Webhooks (consolidated)
/admin/teams/[teamId]/audit-logs      ← Team audit logs (migrated from /dashboard/teams/[id]/audit-logs)
```

Changes:
- Merge Webhooks into Security
- Remove Members subtabs — stacked sections
- Migrate Team Audit Logs from `/dashboard/teams/[id]/audit-logs` to admin
- 4 pages, 0 nesting

#### Admin > Tenant

```
/admin/tenant/members                 ← TenantMembersCard
/admin/tenant/security                ← SessionPolicy + AccessRestriction + Webhooks (consolidated)
/admin/tenant/provisioning            ← SCIM + DirectorySync (stacked cards)
/admin/tenant/machine-identity        ← ServiceAccount + McpClient + AccessRequest + Delegation
/admin/tenant/audit-logs              ← TenantAuditLogCard
```

Changes:
- Merge Webhooks into Security
- Move Delegation here from Personal > Developer
- Remove all subtabs — stack cards vertically
- 5 pages, 0 nesting

## Navigation Component Design

### Admin Layout (`/admin/layout.tsx`)

**IMPORTANT: Must be a Server Component** for security (see Auth Design below).

```tsx
// Server Component — auth check happens server-side before rendering
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const [tenantRole, adminTeams] = await Promise.all([
    getTenantRole(session.user.id),             // src/lib/tenant-context
    getAdminTeamMemberships(session.user.id),    // src/lib/team-auth.ts — new function, uses withBypassRls for cross-team query
  ]);
  // Non-admin users cannot access /admin/* at all
  // (Team-only admins are allowed — team-level checks happen in team layout)
  if (!tenantRole && adminTeams.length === 0) {
    redirect("/dashboard");
  }

  return <AdminShell adminTeams={adminTeams}>{children}</AdminShell>;
}
```

Client components within AdminShell:
- `AdminHeader` — "← 保管庫に戻る" + "管理コンソール" + visual differentiation
- `AdminSidebar` — scope selector (combobox) + scope-specific nav items
- `AdminScopeSelector` — mirrors VaultSelector pattern for Team/Tenant switching

### Tenant Admin Layout (`/admin/tenant/layout.tsx`)

**Must be a Server Component** — blocks team-only admins from accessing tenant pages.

```tsx
export default async function TenantAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const tenantRole = await getTenantRole(session.user.id); // src/lib/tenant-auth.ts — server-side DB query
  if (!tenantRole) notFound(); // team-only admins get 404, not redirect (prevents tenant feature enumeration)

  return <>{children}</>;
}
```

### Team Admin Layout (`/admin/teams/[teamId]/layout.tsx`)

**Must be a Server Component** for authorization.

```tsx
export default async function TeamAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  // getTeamMembership returns null for invalid teamId format AND non-members
  // Using notFound() for both prevents team ID enumeration
  const membership = await getTeamMembership(session.user.id, teamId);
  if (!membership || membership.role === TEAM_ROLE.VIEWER) {
    notFound();
  }

  return <>{children}</>;
}
```

### VaultGate Strategy for Admin Pages

Admin pages do NOT use VaultGate wrapping. Rationale:
- Most admin pages (members, security, provisioning, audit logs) operate on server-side data, not vault-encrypted data
- `machine-identity` page includes DelegationManager which requires vault unlock — this component internally checks vault status and shows an unlock prompt if needed (existing behavior in DelegationManager)
- This avoids blocking the entire admin console behind vault unlock

### AdminShell vs DashboardShell Reuse

Extract shared layout primitives from `DashboardShell` into a `ShellBase` component:

```tsx
// src/components/layout/shell-base.tsx
// Shared: fixed layout, responsive sidebar/sheet, header slot, content slot
interface ShellBaseProps {
  header: React.ReactNode;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}
```

- `DashboardShell` = `ShellBase` + vault sidebar + vault header + VaultGate + ActiveVaultProvider + TravelModeProvider
- `AdminShell` = `ShellBase` + admin sidebar + admin header (no VaultGate, no vault providers)

This avoids duplicating layout logic (responsive behavior, sheet drawer, etc.).

### Personal Settings Layout (`/dashboard/settings/layout.tsx`)

Desktop (md+): vertical sidebar nav (left) + content (right)
Mobile (<md): horizontal scrollable pill bar + content below

Reuses a shared `SectionNav` component:

```tsx
// src/components/settings/section-nav.tsx
interface SectionNavProps {
  items: { href: string; label: string; icon: LucideIcon }[];
}
```

### Mobile Experience

| Context | Desktop | Mobile |
|---------|---------|--------|
| Vault sidebar | Left sidebar (240px) | Sheet (drawer) |
| Admin sidebar | Left sidebar (200px) + scope selector | Sheet (drawer) + scope selector |
| Personal settings nav | Vertical left nav | Horizontal scroll pills |
| Admin section nav | Part of admin sidebar | Part of admin sidebar (in sheet) |

## Auth Design

### Security Boundaries

| Layer | Check | Scope |
|-------|-------|-------|
| **proxy.ts** (middleware) | Session exists + access restriction (IP) | `/admin/*` and `/dashboard/*` equally |
| **`/admin/layout.tsx`** (Server Component) | Tenant admin OR any team admin role | All admin pages |
| **`/admin/tenant/layout.tsx`** (Server Component) | Tenant admin role required | Tenant-scope pages only (blocks team-only admins) |
| **`/admin/teams/[teamId]/layout.tsx`** (Server Component) | Team membership + ADMIN/OWNER role | Per-team admin pages |
| **API route handlers** (existing) | Per-endpoint auth + RBAC | Unchanged |

**CRITICAL**: proxy.ts protection for `/admin/*` MUST be implemented in the very first step,
before any admin pages are created. This prevents an unprotected window during development.

### Scope Selector Security

The AdminScopeSelector combobox shows teams the user has ADMIN/OWNER role in.
- Team list is fetched server-side in the admin layout and passed as props
- Even if a user manipulates the URL with a foreign teamId, the team layout's server-side check blocks access
- Stale team list in client cache is mitigated by revalidation on navigation

## Sidebar Changes

### Vault Sidebar (updated)

```
▾ 保管庫管理
  アーカイブ / ゴミ箱 / 共有リンク / 監査ログ
▾ セキュリティ
  Watchtower / 緊急アクセス
──────
⚙ 個人設定          → /dashboard/settings/account
🏢 管理コンソール →  → /admin/tenant/members  (admin only)
──────
▾ ツール
  エクスポート / インポート
```

Changes:
- "設定" section is replaced by flat links
- "個人設定" is a single link (not a collapsible section)
- "管理コンソール" replaces "テナント設定" + "チーム管理" (both now live in admin)
- Team management link is removed from vault sidebar (it's in admin scope selector)

### Admin Sidebar

```
[← 保管庫に戻る]       ← header link

[テナント ▾]           ← scope selector (combobox)
 ○ チーム A
 ○ チーム B
 ────
 ● テナント

── Scope: Tenant ──
 メンバー              → /admin/tenant/members
 セキュリティ          → /admin/tenant/security
 プロビジョニング      → /admin/tenant/provisioning
 マシンID             → /admin/tenant/machine-identity
 監査ログ             → /admin/tenant/audit-logs

── Scope: Team A ──
 全般                  → /admin/teams/[id]/general
 メンバー              → /admin/teams/[id]/members
 セキュリティ          → /admin/teams/[id]/security
 監査ログ              → /admin/teams/[id]/audit-logs
```

## Implementation Phases

**Invariant: Each phase MUST end with `npx vitest run` + `npx next build` passing.**
Tests are updated in the same phase as the components they test, not deferred.
Phase 0 + Phase 1 should be merged into a single PR to avoid an unprotected window.

### Phase 0: Auth boundary (MUST be first, merge with Phase 1 PR)
1. Add `/admin/*` to proxy.ts matcher and `src/proxy.ts` session + access restriction check
   - Add `pathWithoutLocale.startsWith("/admin")` alongside existing `/dashboard` check
   - Apply `checkAccessRestrictionWithAudit` to `/admin/*` equally

### Phase 1: Admin layout and routing infrastructure
2. Create `getAdminTeamMemberships(userId)` function in `src/lib/team-auth.ts` — uses `withBypassRls` for cross-team query, returns teams where user has ADMIN/OWNER role
3. Create `getTenantRole(userId)` server-side function in `src/lib/tenant-auth.ts` — DB query wrapper for use in Server Components (distinct from `useTenantRole()` client hook)
4. Create `ShellBase` component extracted from `DashboardShell` (shared layout primitive: fixed layout, responsive sidebar/sheet, header slot, content slot)
5. Create `/admin/layout.tsx` as **Server Component** with `auth()` + `getAdminTeamMemberships()` + `getTenantRole()` + `redirect()`
6. Create `/admin/tenant/layout.tsx` as **Server Component** — requires tenant-admin role, returns `notFound()` for team-only admins
7. Create `/admin/teams/[teamId]/layout.tsx` as **Server Component** with team membership + ADMIN/OWNER check, `notFound()` for non-members/invalid IDs
6. Create `AdminShell` using `ShellBase` (admin header + admin sidebar, no VaultGate)
7. Create `AdminScopeSelector` component (combobox for Team/Tenant)
8. Create `AdminSidebar` with scope-aware nav items
9. Create `AdminHeader` with "← 保管庫に戻る" and visual differentiation
10. Add i18n keys for admin navigation (en + ja)
11. Define `NS_ADMIN_ALL` in `src/i18n/namespace-groups.ts` and pass it in admin layout's `NextIntlClientProvider`
12. **Tests**: Add unit tests for `AdminScopeSelector` (scope switching, nav item rendering per scope, "← 保管庫に戻る" always visible)
13. **Tests**: Add `NS_ADMIN_ALL` validation tests in `namespace-groups.test.ts` (same pattern as `NS_DASHBOARD_ALL`: belongs to NAMESPACES, no duplicates, superset of NS_GLOBAL). Also update the existing "NS_DASHBOARD_ALL covers all namespaces" test's `excluded` set to include admin-only namespaces.
14. Verify: `npx vitest run` + `npx next build`

### Phase 2: Migrate Tenant pages to Admin
15. Create `/admin/tenant/members/page.tsx` — move TenantMembersCard
16. Create `/admin/tenant/security/page.tsx` — SessionPolicy + AccessRestriction + Webhooks
17. Create `/admin/tenant/provisioning/page.tsx` — SCIM + DirectorySync
18. Create `/admin/tenant/machine-identity/page.tsx` — SA + MCP + AccessRequests + Delegation
19. Create `/admin/tenant/audit-logs/page.tsx` — TenantAuditLogCard
20. Update `DelegationRevokeBanner` (`src/components/vault/delegation-revoke-banner.tsx:56`): change `router.push` from `/dashboard/settings?tab=developer&subtab=delegation` to `/admin/tenant/machine-identity`
21. Add redirect: `/dashboard/tenant` → `/admin/tenant/members`
22. **Tests**: Update `e2e/tests/tenant-admin.spec.ts` to use `/admin/tenant/*` URLs (rewrite for new structure)
23. **Tests**: Create `e2e/page-objects/admin.page.ts` (admin console PO with scope selector methods)
24. **Tests**: Update `SidebarNavPage` (`sidebar-nav.page.ts`): add `navigateToAdmin(scope, teamId?)`, remove `navigateTo("tenantSettings")`
25. Verify: `npx vitest run` + `npx next build`

### Phase 3: Migrate Team settings to Admin
26. Create `/admin/teams/[teamId]/general/page.tsx`
27. Create `/admin/teams/[teamId]/members/page.tsx` (stacked sections, no subtabs)
28. Create `/admin/teams/[teamId]/security/page.tsx` (policy + rotation + webhooks)
29. Create `/admin/teams/[teamId]/audit-logs/page.tsx` (migrated from `/dashboard/teams/[id]/audit-logs`)
30. Update `/dashboard/teams/page.tsx:100`: change team settings href from `/dashboard/teams/${team.id}/settings` to `/admin/teams/${team.id}/general`
31. Update team delete redirect in admin general page: `router.push` → `/dashboard` (back to vault, since team no longer exists)
32. Add redirect: `/dashboard/teams/[id]/settings` → `/admin/teams/[id]/general`
33. Add redirect: `/dashboard/teams/[id]/audit-logs` → `/admin/teams/[id]/audit-logs`
34. **Tests**: Update `e2e/tests/teams.spec.ts:145` and `e2e/page-objects/teams.page.ts:82` — change `waitForURL(/\/teams\/[^/]+\/settings/)` to match new `/admin/teams/[id]/general`
35. **Tests**: Update `e2e/page-objects/team-dashboard.page.ts` — remove `switchTab("settings"|"policy"|"webhook")`, add navigation to `/admin/teams/[id]/*`
36. **Tests**: Remove `navigateTo("teams")` from `SidebarNavPage` (if not done in Phase 2)
37. Verify: `npx vitest run` + `npx next build`

### Phase 4: Refactor Personal Settings (in Vault context)
38. Create `/dashboard/settings/layout.tsx` with `SectionNav`
39. Split into `/account`, `/security`, `/developer` pages
40. Remove Delegation from Developer (moved in Phase 2)
41. Remove all nested `<Tabs>`
42. Add redirect: `/dashboard/settings` → `/dashboard/settings/account`
43. Add redirect: `/dashboard/settings?tab=security` → `/dashboard/settings/security`
44. Add redirect: `/dashboard/settings?tab=developer` → `/dashboard/settings/developer`
45. Add redirect: `/dashboard/settings?tab=account` → `/dashboard/settings/account`
46. **Tests**: Redesign `e2e/page-objects/settings.page.ts` — replace tab-based methods (`switchTab`, `switchSecuritySubTab`, `switchDeveloperSubTab`) with route-based (`gotoAccount()`, `gotoSecurity()`, `gotoDeveloper()`). Remove `DeveloperSubTab.delegation`.
47. **Tests**: Update `e2e/tests/settings-sessions.spec.ts`, `settings-api-keys.spec.ts`, `settings-key-rotation.spec.ts`, `settings-travel-mode.spec.ts` — use new PO methods
48. Verify: `npx vitest run` + `npx next build`

### Phase 5: Vault sidebar update + hooks
49. Replace "設定" collapsible section with flat links in `sidebar-section-security.tsx`
50. Add "管理コンソール →" link (admin-only; security boundary is admin layout's server-side redirect, not this link's visibility)
51. Remove team management link from vault sidebar
52. Update `useSidebarNavigationState`:
    - Add `isAdminActive` flag for `/admin/*` path detection
    - Change `isSettings` from exact match (`=== "/dashboard/settings"`) to prefix match (`startsWith("/dashboard/settings")`)
    - Remove `isTenantSettings` and `isTeamSettings` from this hook (moved to admin context)
    - Scope `isAuditLog` regex (`auditTeamMatch`) to `/dashboard/` paths only — prevent false match on `/admin/teams/[id]/audit-logs`
53. Update `SidebarContentProps` interface in `sidebar-content.tsx`: remove `isTeamSettingsActive`/`isTenantSettingsActive`, add `isAdminActive?: boolean`
54. Update `sidebar.tsx`: remove `isTenantSettings`, `isTeamSettings`, `isTeamsManage` from `isSettingsActive` calculation — simplify to `isSettings` only; pass `isAdminActive` to `SidebarContent`
55. Remove `/dashboard/teams` from `CROSS_VAULT_PATHS` in `use-vault-context.ts` — team management is now in admin context; `/dashboard/teams` page (team vault list) remains but is vault-context
56. Update `useSidebarSectionsState`: add `isAdminActive` parameter; when `isAdminActive === true`, no settings section auto-opens (user is in admin context, not vault settings)
57. **Tests**: Update `sidebar-section-security.test.tsx` — replace old URL assertions (`/dashboard/tenant`, `/dashboard/teams/[id]/settings`) with "管理コンソール" link and "個人設定" link
58. **Tests**: Update `sidebar-content.test.tsx` — update `baseProps` (remove `isTenantSettingsActive`/`isTeamSettingsActive`, add `isAdminActive`)
59. **Tests**: Update `use-sidebar-navigation-state.test.ts` — add `/admin/*` path test cases, test `isSettings` prefix match for `/dashboard/settings/account`, test `isAuditLog` does NOT match `/admin/teams/[id]/audit-logs`
60. **Tests**: Update `use-sidebar-sections-state.test.ts` — add `isAdminActive` to `baseParams`, test that settings section does not auto-open when `isAdminActive === true`
60. Verify: `npx vitest run` + `npx next build`

### Phase 6: Cleanup and verification
61. Remove old `/dashboard/tenant/page.tsx`
62. Remove old `/dashboard/teams/[id]/settings/page.tsx`
63. Remove old `/dashboard/teams/[id]/audit-logs/page.tsx` (migrated to admin)
64. Remove old `/dashboard/settings/page.tsx`
65. Comprehensive URL grep: search entire codebase for remaining references to old URLs (`/dashboard/tenant`, `/dashboard/settings?tab=`, `/dashboard/teams/*/settings`) and update any remaining occurrences
66. Verify all i18n keys (en + ja)
67. Final verification: `npx vitest run` + `npx next build`

## Files Requiring Changes

### Components
- `src/components/layout/dashboard-shell.tsx` — extract ShellBase
- `src/components/layout/sidebar-section-security.tsx` — replace "設定" section
- `src/components/layout/sidebar-content.tsx` — update props for isAdminActive
- `src/components/layout/sidebar.tsx` — simplify isSettingsActive calculation
- `src/components/vault/delegation-revoke-banner.tsx:56` — update hardcoded URL

### Lib (new functions)
- `src/lib/team-auth.ts` — add `getAdminTeamMemberships(userId)` function (uses `withBypassRls`)
- `src/lib/tenant-auth.ts` — add `getTenantRole(userId)` server-side function for Server Components

### Hooks
- `src/hooks/use-sidebar-navigation-state.ts` — add isAdminActive, change isSettings to prefix match, remove isTenantSettings/isTeamSettings, scope isAuditLog to /dashboard/
- `src/hooks/use-sidebar-sections-state.ts` — add isAdminActive parameter, handle admin context
- `src/hooks/use-vault-context.ts` — remove `/dashboard/teams` from CROSS_VAULT_PATHS

### i18n
- `src/i18n/namespace-groups.ts` — add NS_ADMIN_ALL
- `messages/en/*.json` — add admin namespace
- `messages/ja/*.json` — add admin namespace

### Middleware
- `src/proxy.ts` — add /admin/* session + access restriction check
- `proxy.ts` (root) — add /admin/* to matcher if needed

### Pages (existing, to update)
- `src/app/[locale]/dashboard/teams/page.tsx:100` — update team settings href

### Tests (unit)
- `src/components/layout/sidebar-section-security.test.tsx`
- `src/components/layout/sidebar-content.test.tsx`
- `src/hooks/use-sidebar-navigation-state.test.ts`
- `src/hooks/use-sidebar-sections-state.test.ts`
- `src/i18n/namespace-groups.test.ts`

### Tests (E2E)
- `e2e/page-objects/settings.page.ts` — full redesign (tab → route-based)
- `e2e/page-objects/sidebar-nav.page.ts` — add admin methods, remove old entries
- `e2e/page-objects/teams.page.ts:82` — update waitForURL pattern
- `e2e/page-objects/team-dashboard.page.ts` — remove old tab methods
- `e2e/page-objects/admin.page.ts` — new PO for admin console
- `e2e/tests/settings-sessions.spec.ts`
- `e2e/tests/settings-api-keys.spec.ts`
- `e2e/tests/settings-key-rotation.spec.ts`
- `e2e/tests/settings-travel-mode.spec.ts`
- `e2e/tests/tenant-admin.spec.ts`
- `e2e/tests/teams.spec.ts:145` — update waitForURL pattern

## Migration Notes

- **URL breaking changes**: Old URLs (`/dashboard/tenant`, `/dashboard/settings?tab=X`, `/dashboard/teams/[id]/settings`) need redirects. All `?tab=` and `?subtab=` query params must be mapped.
- **Bookmark compatibility**: Redirect old `?tab=` + `?subtab=` query params to new paths
- **Team invite URLs**: `/dashboard/teams/invite/[token]` stays in the dashboard namespace (not moved to admin). Admin team settings pages continue to generate invite URLs pointing to `/dashboard/teams/invite/...`.
- **Component reuse**: All card components (TenantMembersCard, McpClientCard, etc.) stay in `src/components/settings/` — only the page shells change
- **Auth boundary**: `/admin/*` requires session + access restriction in proxy.ts (Phase 0) AND server-side admin role check in layout (Phase 1)
- **Team audit logs**: Migrated from `/dashboard/teams/[id]/audit-logs` to `/admin/teams/[id]/audit-logs` with redirect
- **DelegationRevokeBanner in admin**: Banner is rendered in `DashboardShell` only, not in `AdminShell`. This is intentional — admin context manages delegation via the machine-identity page directly.
- **E2E PO atomicity**: When updating E2E page objects and their dependent spec files (e.g., Phase 4 Steps 46-47), both PO and specs must be updated in the same commit to avoid intermediate broken state. `vitest` does not run E2E tests, so CI green at verify step does not guarantee E2E health.
- **`teams.page.ts` openTeamVault**: The `waitForURL(/\/teams\/[^/]+\/settings/)` inside `openTeamVault` must also be updated in Phase 3 (Step 34) to match the new admin URL pattern.
- **admin.page.ts scope**: The admin console PO created in Phase 2 (Step 23) must include both tenant-scope and team-scope navigation methods, as Phase 3's team-dashboard PO update depends on it.

## Visual Differentiation (Admin Context)

To make it immediately obvious the user is in Admin:
- Header background: `bg-muted` or subtle `bg-slate-50 dark:bg-slate-900` instead of default
- Header icon: Building2 (🏢) instead of shield/lock
- Optional: thin colored top border (`border-t-2 border-amber-500`) as a persistent indicator
- "← 保管庫に戻る" always visible in header-left

## Summary

| Area | Before | After |
|------|--------|-------|
| Personal Settings | 3 tabs + 6 subtabs, in vault | 3 pages, 0 nesting, in vault |
| Team Settings | 4 tabs + 5 subtabs, in vault | 4 pages, 0 nesting, **in admin** |
| Tenant Settings | 6 tabs + 5 subtabs, in vault | 5 pages, 0 nesting, **in admin** |
| Context separation | None (all in same sidebar) | **Hard boundary** (vault ↔ admin) |
| Narrow screen | Tabs collapse | Scroll pills (settings) / admin sidebar (admin) |
| Auth model | Client-side role check only | Server Component + proxy.ts (defense in depth) |
