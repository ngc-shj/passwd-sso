# Plan: nav-restructure-machine-identity

## Objective

Restructure the tenant admin sidebar's "Machine Identity" section into two logically distinct groups:
1. **Service Accounts** — SA management + JIT Access Requests (tightly coupled)
2. **MCP** — MCP Client registration + (future) MCP Connections

This clarifies the relationship between SA and Access Requests, and separates the independent MCP Client feature into its own navigation group.

## Requirements

### Functional
- SA and Access Requests are grouped together under one sidebar parent
- MCP Clients is under a separate sidebar parent
- All existing page functionality is preserved (no component changes)
- Sidebar active state highlighting works correctly for all sub-routes
- Navigation between pages works without broken links
- Future MCP Connections page (Task #1) has a clear home under the MCP group

### Non-functional
- API endpoints remain unchanged (only UI routing changes)
- Card components remain unchanged
- i18n keys exist in both en and ja
- All tests pass, build succeeds

## Technical Approach

**Option A (Recommended): Clean route split**

Split into two route prefixes with two sidebar groups:

```
/admin/tenant/service-accounts/                → redirect to accounts
/admin/tenant/service-accounts/accounts        → ServiceAccountCard
/admin/tenant/service-accounts/access-requests → AccessRequestCard

/admin/tenant/mcp/                             → redirect to clients
/admin/tenant/mcp/clients                      → McpClientCard
```

Sidebar:
```
Service Accounts (Bot icon)
├── Accounts        (Key icon)
└── Access Requests (KeyRound icon)

MCP (Cpu icon)
└── Clients         (Monitor icon)
```

**Why Option A over Option B (reorder-only)?**
- `pathname.startsWith(item.href)` drives sidebar active-state detection. Two separate `href` prefixes ensure correct highlighting for each group.
- URL paths match the visible labels (no `/machine-identity/` URL behind a "Service Accounts" label).
- Clean slot for future `/admin/tenant/mcp/connections` page (Task #1).
- Route reference count is small (3 files: sidebar, sidebar test, redirect page) — low migration cost.

**Rejected: Option B (reorder children within single group)**
- Cannot achieve correct active-state highlighting for two visual groups under one `href` prefix.
- URL slug `machine-identity` becomes misleading when the label changes.

## Implementation Steps

### 1. Create new route directories and layouts

Create two new route groups with SectionLayout wrappers:

**`/admin/tenant/service-accounts/layout.tsx`**
- SectionLayout with Bot icon
- Title: `t("sectionServiceAccounts")` / Description: `t("sectionServiceAccountsDesc")`

**`/admin/tenant/mcp/layout.tsx`**
- SectionLayout with Cpu icon
- Title: `t("sectionMcp")` / Description: `t("sectionMcpDesc")`

**`/admin/tenant/service-accounts/page.tsx`**
- Index redirect to `/admin/tenant/service-accounts/accounts`
- Use client-side `"use client"` + `useEffect` + `router.replace` pattern (consistent with `security/page.tsx`, `provisioning/page.tsx`)

**`/admin/tenant/mcp/page.tsx`**
- Index redirect to `/admin/tenant/mcp/clients`
- Same `useEffect` + `router.replace` pattern

### 2. Move existing page files

| From | To |
|------|-----|
| `.../machine-identity/service-accounts/page.tsx` | `.../service-accounts/accounts/page.tsx` |
| `.../machine-identity/access-requests/page.tsx` | `.../service-accounts/access-requests/page.tsx` |
| `.../machine-identity/mcp-clients/page.tsx` | `.../mcp/clients/page.tsx` |

Each page renders the same Card component — only the file location changes.

### 3. Delete old machine-identity route group

Remove:
- `src/app/[locale]/admin/tenant/machine-identity/layout.tsx`
- `src/app/[locale]/admin/tenant/machine-identity/page.tsx`
- `src/app/[locale]/admin/tenant/machine-identity/service-accounts/page.tsx`
- `src/app/[locale]/admin/tenant/machine-identity/mcp-clients/page.tsx`
- `src/app/[locale]/admin/tenant/machine-identity/access-requests/page.tsx`

### 4. Update admin sidebar

In `src/components/admin/admin-sidebar.tsx`:
- Replace the single `machine-identity` NavItem with two NavItems:

```ts
{
  href: "/admin/tenant/service-accounts",
  label: t("navServiceAccounts"),
  icon: <Bot className="h-4 w-4 shrink-0" />,
  children: [
    { href: "/admin/tenant/service-accounts/accounts", label: t("navSaAccounts"), icon: <Key ... /> },
    { href: "/admin/tenant/service-accounts/access-requests", label: t("navAccessRequests"), icon: <KeyRound ... /> },
  ],
},
{
  href: "/admin/tenant/mcp",
  label: t("navMcp"),
  icon: <Cpu className="h-4 w-4 shrink-0" />,
  children: [
    { href: "/admin/tenant/mcp/clients", label: t("navMcpClients"), icon: <Monitor ... /> },
  ],
},
```

### 5. Update i18n keys

**AdminConsole namespace** (`messages/en/AdminConsole.json`, `messages/ja/AdminConsole.json`):

Add:
- `navSaAccounts`: "Accounts" / "アカウント"
- `navMcp`: "MCP" / "MCP"
- `sectionServiceAccounts`: "Service Accounts" / "サービスアカウント"
- `sectionServiceAccountsDesc`: "Manage service accounts and JIT access requests." / "サービスアカウントとJITアクセスリクエストを管理します。"
- `sectionMcp`: "MCP" / "MCP"
- `sectionMcpDesc`: "Manage MCP client registrations." / "MCPクライアント登録を管理します。"

Deprecate (remove):
- `navMachineIdentity`
- `sectionMachineIdentity`
- `sectionMachineIdentityDesc`
- `navDelegation` (orphaned key)

Keep unchanged:
- `navServiceAccounts` (reused as parent label)
- `navMcpClients` (reused as child label)
- `navAccessRequests` (reused as child label)

### 6. Update sidebar test

In `src/components/admin/admin-sidebar.test.tsx`:
- Update expected link count: total leaf links stays at 24, but group breakdown comment changes from `machine-identity×3` to `service-accounts×2, mcp×1`
- Replace expected href values:
  - ~~`/admin/tenant/machine-identity/service-accounts`~~ → `/admin/tenant/service-accounts/accounts`
  - ~~`/admin/tenant/machine-identity/mcp-clients`~~ → `/admin/tenant/mcp/clients`
  - ~~`/admin/tenant/machine-identity/access-requests`~~ → `/admin/tenant/service-accounts/access-requests`
- Update comment at line 76: `security×3, provisioning×2, service-accounts×2, mcp×1, audit-logs×2`
- Add active-state test: set `pathname` to `/admin/tenant/service-accounts/accounts` and verify the "Service Accounts" group's child link renders with `secondary` variant

### 6b. Add redirect page tests

Create minimal tests for each redirect page (pattern: mock `useRouter`, render, assert `router.replace` called with correct path):
- `/admin/tenant/service-accounts/page.tsx` → expects `replace("/admin/tenant/service-accounts/accounts")`
- `/admin/tenant/mcp/page.tsx` → expects `replace("/admin/tenant/mcp/clients")`

Reference: sidebar test already mocks `useRouter` with `replace: vi.fn()` at line 19.

### 7. Verify no other route references

Grep confirms only 3 files reference `machine-identity` paths:
- `admin-sidebar.tsx` (Step 4)
- `admin-sidebar.test.tsx` (Step 6)
- `machine-identity/page.tsx` (Step 3 — deleted)

No API endpoints, no deep links from other components.

## Testing Strategy

- **Unit tests**: Update `admin-sidebar.test.tsx` to verify new link paths, group structure, and active-state for new groups
- **Redirect tests**: Add unit tests for both redirect pages (assert `router.replace` called with correct target path)
- **Build verification**: `npx next build` ensures all route files resolve
- **Manual smoke test**:
  - Navigate via sidebar to each of the 3 sub-pages
  - Verify active/highlighted state on parent and child links
  - Verify redirect from parent `/service-accounts` → `/service-accounts/accounts`
  - Verify redirect from parent `/mcp` → `/mcp/clients`

## Considerations & Constraints

- **No API changes**: All API endpoints (`/api/tenant/service-accounts/*`, `/api/tenant/access-requests/*`, `/api/tenant/mcp-clients/*`) remain unchanged
- **No component changes**: ServiceAccountCard, McpClientCard, AccessRequestCard are self-contained and route-agnostic
- **MachineIdentity i18n namespace**: The `MachineIdentity.json` message file is used by card components (not layout/nav) — it stays unchanged. Only `AdminConsole.json` needs updates.
- **Import changes**: New layout files import `SectionLayout` and `useTranslations("AdminConsole")` — same pattern as existing layouts
- **Orphaned navDelegation key**: Remove it during this cleanup (confirmed unused in sidebar)

## User Operation Scenarios

1. **Admin navigates to Service Accounts via sidebar**:
   - Click "Service Accounts" group → expands to show "Accounts" and "Access Requests"
   - Click "Accounts" → navigates to `/admin/tenant/service-accounts/accounts`
   - SectionLayout header shows "Service Accounts" with Bot icon
   - ServiceAccountCard renders

2. **Admin navigates to Access Requests**:
   - Under "Service Accounts" group, click "Access Requests"
   - Navigates to `/admin/tenant/service-accounts/access-requests`
   - Same SectionLayout header ("Service Accounts")
   - AccessRequestCard renders — SA dropdown still works (API path unchanged)

3. **Admin navigates to MCP Clients**:
   - Click "MCP" group → expands to show "Clients"
   - Click "Clients" → navigates to `/admin/tenant/mcp/clients`
   - SectionLayout header shows "MCP" with Cpu icon
   - McpClientCard renders

4. **Direct URL access to old paths**:
   - `/admin/tenant/machine-identity/*` → 404 (old routes deleted)
   - No redirect needed — this is an internal admin URL, not bookmarkable by end users
   - If needed in future, Next.js rewrites can handle it

5. **Future: MCP Connections page (Task #1)**:
   - Will be added at `/admin/tenant/mcp/connections` under the MCP group
   - Sidebar: new child `{ href: "/admin/tenant/mcp/connections", label: "Connections" }`
