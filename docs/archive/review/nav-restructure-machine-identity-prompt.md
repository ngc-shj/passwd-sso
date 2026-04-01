# Task: Restructure Machine Identity Navigation

## Background

The tenant admin sidebar has a "Machine Identity" section with three children:
- Service Accounts
- MCP Clients
- Access Requests

Service Accounts and Access Requests are tightly coupled (Access Requests require
selecting a Service Account and display SA names), while MCP Clients is an independent
OAuth 2.1 client management feature. Grouping all three under "Machine Identity" makes
the relationship unclear.

## Current Structure

### Sidebar
```
Machine Identity (parent)
├── Service Accounts
├── MCP Clients
└── Access Requests
```

### Routes
```
/admin/tenant/machine-identity/              → redirect to service-accounts
/admin/tenant/machine-identity/service-accounts/
/admin/tenant/machine-identity/mcp-clients/
/admin/tenant/machine-identity/access-requests/
```

### Layout
`/admin/tenant/machine-identity/layout.tsx` wraps all three pages with SectionLayout
(icon: Bot, title: "Machine Identity").

### Cross-references
- `access-request-card.tsx` fetches from `apiPath.tenantServiceAccounts()` to populate
  the SA dropdown when creating access requests
- Both share the `/api/tenant/service-accounts/` and `/api/tenant/access-requests/` API paths
- MCP Clients has no dependency on either SA or Access Requests

## Proposed Structure

### Option A: Split into two parent sections
```
Service Accounts (parent)
├── Accounts           ← SA list, create, tokens
└── Access Requests    ← JIT access management

MCP Integration (parent)
├── Clients            ← OAuth 2.1 client registration
└── Connections        ← (future) user's MCP connections
```

### Option B: Keep one parent, reorder children
```
Machine Identity (parent)
├── Service Accounts
├── Access Requests     ← moved next to SA (grouped by relationship)
├── MCP Clients         ← separated by visual gap or divider
└── Connections         ← (future)
```

## Implementation

### Sidebar changes
- File: `src/components/admin/admin-sidebar.tsx`
- Nav items are defined as `NavItem[]` with optional `children: NavItem[]`
- Modify the machine-identity section or split into two sections

### Route changes (if Option A)
- Move `/admin/tenant/machine-identity/mcp-clients/` to `/admin/tenant/mcp-integration/clients/`
- Create new layout for `/admin/tenant/mcp-integration/layout.tsx`
- Update redirects in parent `page.tsx`
- Rename `/admin/tenant/machine-identity/` to `/admin/tenant/service-accounts/` (optional)

### i18n changes
- `messages/en/AdminConsole.json` and `messages/ja/AdminConsole.json`
- Add new section names (e.g., `sectionServiceAccounts`, `sectionMcpIntegration`)
- Update `sectionMachineIdentityDesc` or remove if splitting

### No component changes needed
- Card components (ServiceAccountCard, McpClientCard, AccessRequestCard) are self-contained
- They don't reference the nav structure

## Constraints

- Keep all API endpoints unchanged (only UI/routing changes)
- Keep existing card components unchanged
- Run `npx vitest run` + `npx next build` after changes
- Update i18n keys in both en and ja

## Verification

1. Navigate to each page via sidebar and confirm correct routing
2. Verify the relationship between SA and Access Requests is clear from the menu structure
3. Confirm MCP Clients is visually distinct from SA-related items
4. Check that all sidebar links are active/highlighted correctly
