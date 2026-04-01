# Plan: mcp-connections-page

## Objective

Add a "My MCP Connections" page to the personal settings developer section where users can view their authorized MCP clients and revoke individual connections.

An "MCP connection" = an active (not expired, not revoked) `McpAccessToken` record associated with the current user via OAuth consent.

## Requirements

### Functional
- Users can see a list of their active MCP connections (authorized OAuth clients)
- Each connection displays: client name, public client ID, granted scopes, created date, expiration
- Users can revoke individual connections (with confirmation dialog)
- Revoking a connection invalidates the access token AND all refresh tokens in the same family
- Empty state shown when no connections exist
- Page accessible from settings developer section sidebar

### Non-functional
- No raw token values exposed in API responses (only metadata)
- IDOR prevention: all queries include userId from session
- API endpoints authenticated via session (authjs)
- i18n keys in both en and ja
- Audit log entry on revocation
- Tests pass, build succeeds

## Technical Approach

### New API Endpoint

**`GET /api/user/mcp-tokens`** — List active MCP tokens for current user

Query (based on existing `availableTokens` pattern in delegation route):
```ts
prisma.mcpAccessToken.findMany({
  where: {
    userId,
    tenantId,
    revokedAt: null,
    expiresAt: { gt: new Date() },
  },
  select: {
    id: true,
    scope: true,
    expiresAt: true,
    createdAt: true,
    mcpClient: {
      select: { name: true, clientId: true },
    },
  },
  orderBy: { createdAt: "desc" },
})
```

Response shape:
```ts
{
  tokens: Array<{
    id: string;
    clientName: string;     // mcpClient.name
    clientId: string;       // mcpClient.clientId (public mcpc_xxx)
    scope: string;          // space-separated scope string
    createdAt: string;      // ISO
    expiresAt: string;      // ISO
  }>
}
```

Both endpoints use `withBypassRls(prisma, ...)` for RLS bypass (same pattern as delegation route). Both extract `userId` and `tenantId` from `auth()` session and include both in WHERE clauses for tenant isolation.

**`DELETE /api/user/mcp-tokens/[id]`** — Revoke a single MCP connection

Design: not found / wrong user / already revoked all return 404 (enumeration prevention — no distinction between "does not exist" and "belongs to another user").

Logic:
1. Auth check: session required (via `auth()`), extract `userId` + `tenantId`
2. Find `McpAccessToken` where `{ id, userId, tenantId }` — IDOR + tenant isolation
3. If not found or `revokedAt` is already set → 404
4. In a `$transaction`:
   a. Set `revokedAt = now` on the access token
   b. Find all `McpRefreshToken` records where `{ accessTokenId: id }` to get `familyId` values
   c. For each unique `familyId`: `McpRefreshToken.updateMany({ where: { familyId, revokedAt: null } })` → set `revokedAt = now`
   d. Collect all `accessTokenId` values from those families: `McpAccessToken.updateMany({ where: { id: { in: relatedAccessTokenIds } } })` → set `revokedAt = now` (catches rotated tokens)
   e. Revoke all `DelegationSession` records where `{ mcpTokenId: id, revokedAt: null }` → set `revokedAt = now`
   f. Evict Redis delegation keys via `evictDelegationRedisKeys` (if delegation sessions existed)
5. Audit log: action `MCP_CONNECTION_REVOKE` (new enum value — see Audit Action section below)
6. Response: 204 No Content

The revocation pattern follows `revokeToken()` in `src/lib/mcp/oauth-server.ts` (familyId chain revocation) but looks up by `id + userId + tenantId` instead of `tokenHash + clientId`. Additionally handles DelegationSession cleanup which `revokeToken()` does not.

### Component

**`src/components/settings/mcp-connections-card.tsx`**

Follow the Card pattern from card-structure-unification:
- `Card` > `CardHeader` (icon + `CardTitle` + `CardDescription`) > `CardContent`
- Icon: `Plug` from lucide-react
- Fetch via `fetchApi(apiPath.userMcpTokens())` on mount
- Display connections as bordered list items:
  - Client name (bold) + public client ID (muted)
  - Scope badges
  - Created date + expiration (formatted with `formatDateTime`)
  - "Revoke" button per row
- Confirmation via `AlertDialog` before revoke
- Toast notification on success/failure
- Empty state with icon + description

### Page

**`src/app/[locale]/dashboard/settings/developer/connections/page.tsx`**
- Render `<McpConnectionsCard />` — follows "1 page = 1 card" pattern

### Navigation

In `src/app/[locale]/dashboard/settings/layout.tsx`, add to developer section children:
```ts
{ href: "/dashboard/settings/developer/connections", label: t("subTabConnections"), icon: Plug },
```

### i18n

Add to `MachineIdentity` namespace under `connections` nested key (same pattern as `delegation` nested object):

```json
{
  "connections": {
    "title": "MCP Connections",
    "description": "View and manage your authorized MCP client connections.",
    "clientName": "Client Name",
    "clientId": "Client ID",
    "scopes": "Scopes",
    "created": "Created",
    "expires": "Expires",
    "revoke": "Revoke",
    "revokeTitle": "Revoke Connection",
    "revokeDescription": "Are you sure you want to revoke this connection? The MCP client will no longer be able to access your account with this token.",
    "revokeSuccess": "Connection revoked successfully.",
    "revokeError": "Failed to revoke connection.",
    "noConnections": "No active connections",
    "noConnectionsDescription": "You have not authorized any MCP clients yet."
  }
}
```

Add `subTabConnections` key to `Settings` namespace:
- en: `"Connections"` / ja: `"接続"`

### API Path Helper

Add to `src/lib/url-helpers.ts` (or wherever `apiPath` / `API_PATH` is defined):
```ts
userMcpTokens: () => "/api/user/mcp-tokens",
userMcpToken: (id: string) => `/api/user/mcp-tokens/${id}`,
```

### Audit Action

Add `MCP_CONNECTION_REVOKE` to `AuditAction` enum:
- `prisma/schema.prisma` — add enum value
- `src/lib/constants/audit.ts` — add corresponding constant (satisfies `Record<AuditAction, AuditAction>`)
- Run `npm run db:migrate` to create migration
- Add to relevant audit action group arrays if applicable

## Implementation Steps

### 1. Add AuditAction enum value + migration
- `prisma/schema.prisma` — add `MCP_CONNECTION_REVOKE` to `AuditAction` enum
- `src/lib/constants/audit.ts` — add corresponding constant
- Run `npm run db:migrate`

### 2. Add API path helpers
- Add `userMcpTokens()` and `userMcpToken(id)` to the shared API path module

### 3. Create GET endpoint
- `src/app/api/user/mcp-tokens/route.ts`
- Auth via `auth()`, extract `userId` + `tenantId` from session
- Use `withBypassRls(prisma, ...)` for query
- Query active tokens with client info, filter by `userId` + `tenantId`
- Map to response shape (no raw token data)

### 4. Create DELETE endpoint
- `src/app/api/user/mcp-tokens/[id]/route.ts`
- Auth via `auth()`, extract `userId` + `tenantId`
- Use `withBypassRls(prisma, ...)` for transaction
- IDOR check: find by `{ id, userId, tenantId }`
- Transaction: revoke access token → revoke refresh family chain → revoke DelegationSessions → evict Redis keys
- Audit log with `MCP_CONNECTION_REVOKE`
- Return 204

### 5. Add i18n keys
- `messages/en/MachineIdentity.json` — add `connections` nested object
- `messages/ja/MachineIdentity.json` — add Japanese translations
- `messages/en/Settings.json` — add `subTabConnections`: "Connections"
- `messages/ja/Settings.json` — add `subTabConnections`: "接続"

Files to update: `messages/{en,ja}/MachineIdentity.json`, `messages/{en,ja}/Settings.json`

### 6. Create component
- `src/components/settings/mcp-connections-card.tsx`
- Card with list display, revoke with confirmation, empty state
- Follow delegation-manager.tsx display patterns

### 7. Create page
- `src/app/[locale]/dashboard/settings/developer/connections/page.tsx`
- Render McpConnectionsCard

### 8. Update navigation
- `src/app/[locale]/dashboard/settings/layout.tsx` — add nav child to developer section

### 9. Create tests
- `src/components/settings/mcp-connections-card.test.tsx`
  - Mock setup: `vi.hoisted()` for `mockFetch`/`mockToast`, mock all UI components, `useTranslations` returns `(key) => key`
  - AlertDialog mock: wire `onClick` on `AlertDialogAction` via `data-testid="alert-action"` pattern (reference: `mcp-client-card.test.tsx` line 529)
  - Test cases:
    1. Loading state (spinner while fetch pending)
    2. Empty state rendering (no connections message)
    3. Initial load failure — `mockFetch.mockRejectedValue(...)` → shows error/empty state gracefully
    4. List rendering — connection details (clientName, clientId, scope badges, created/expires dates)
    5. Revoke flow — click revoke → AlertDialog → confirm via `alert-action` → assert DELETE called → assert item removed from DOM
    6. Revoke success toast — `expect(mockToast.success).toHaveBeenCalledWith("connections.revokeSuccess")`
    7. Revoke HTTP error — `mockFetch` returns `{ ok: false }` → assert `mockToast.error` called, item remains in list
    8. Revoke network error — `mockFetch.mockRejectedValue(new Error("Network"))` → assert `mockToast.error` called, no crash

### 10. Verify
- `npx vitest run` — all tests pass
- `npx next build` — build succeeds

## Testing Strategy

- **Unit tests**: `mcp-connections-card.test.tsx` covering list, empty state, revoke flow
- **API tests**: If API route tests exist for similar endpoints, follow pattern; otherwise card-level fetch mocking is sufficient
- **Build verification**: `npx next build`
- **Manual smoke test**:
  1. Navigate to `/dashboard/settings/developer/connections`
  2. See list of authorized MCP clients (or empty state)
  3. Revoke a connection → confirm dialog → connection disappears
  4. Verify revoked token cannot be used for MCP tool calls

## Considerations & Constraints

- **No `lastUsedAt` field**: `McpAccessToken` has no `lastUsedAt` — skip "last used" display (per prompt recommendation)
- **Scope display**: Show raw scope string as badges (e.g., `credentials:list`, `vault:unlock-data`)
- **RLS strategy**: Both endpoints use `withBypassRls(prisma, ...)` (same as delegation route) with explicit `userId` + `tenantId` in WHERE clauses for tenant isolation
- **Existing delegation endpoint overlap**: The GET `/api/vault/delegation` already returns `availableTokens`, but it's scoped to delegation concerns (hasDelegationScope flag) and requires vault status. The new endpoint is independent — no vault unlock required
- **DelegationSession cleanup**: Revoking an MCP token must also revoke associated DelegationSessions and evict Redis keys — the existing `revokeToken()` in oauth-server.ts does NOT handle this, so it's an additional step in our transaction
- **Rate limiting**: Check if a shared rate limiter exists for `/api/user/*` routes; apply if available
- **Audit action**: `MCP_CONNECTION_REVOKE` must be added to both Prisma enum and constants module (Step 1), requires migration

## User Operation Scenarios

1. **User with active MCP connections views page**:
   - Navigate to Settings → Developer → Connections
   - See list of authorized clients with name, client ID, scopes, and dates
   - Each row has a "Revoke" button

2. **User revokes a connection**:
   - Click "Revoke" on a connection row
   - AlertDialog appears: "Are you sure?"
   - Confirm → API call DELETE `/api/user/mcp-tokens/[id]`
   - Success toast + connection disappears from list
   - The MCP client can no longer use that token

3. **User with no connections**:
   - Navigate to Connections page
   - See empty state: icon + "No active connections" message

4. **Token already expired**:
   - Expired tokens are filtered server-side (`expiresAt > now`)
   - User never sees expired tokens in the list

5. **Concurrent access**:
   - If a token is revoked via MCP `/api/mcp/revoke` while the page is open, the next fetch will exclude it
   - No real-time sync needed — standard fetch-on-action pattern
