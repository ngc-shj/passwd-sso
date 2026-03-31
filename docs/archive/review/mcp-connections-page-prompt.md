# Task: Add MCP Connections Page (Personal Settings)

## Background

The personal settings developer section currently has three sub-pages:
- CLI Token (`/dashboard/settings/developer/cli-token`)
- API Keys (`/dashboard/settings/developer/api-keys`)
- Delegation (`/dashboard/settings/developer/delegation`)

Users who authorize MCP clients via OAuth 2.1 have no visibility into which clients
have active access tokens. They cannot see or revoke connections from the settings UI.

## Objective

Add a read-only "My MCP Connections" page to the personal settings developer section
where users can see their authorized MCP clients and revoke individual connections.

```
/dashboard/settings/developer/connections  ← NEW: McpConnectionsCard
```

## What "MCP Connection" Means

An MCP connection = an active (not expired, not revoked) `McpAccessToken` record
associated with the current user. Each token represents an OAuth consent the user
granted to an MCP client.

## Existing Infrastructure

### Prisma Models

**McpAccessToken** (relevant fields):
- `id` (UUID)
- `tokenHash` (stored hash, never exposed)
- `clientId` (FK → McpClient)
- `userId` (FK → User, nullable)
- `scope` (string, space-separated scopes)
- `expiresAt` (DateTime)
- `revokedAt` (DateTime, nullable)
- `createdAt` (DateTime)
- **No `lastUsedAt` field** — do NOT display "last used"

**McpClient** (relevant fields):
- `id` (UUID)
- `clientId` (public client ID, e.g., `mcpc_xxx`)
- `name` (display name, max 100 chars)
- `allowedScopes` (string)
- `isActive` (boolean)
- `isDcr` (boolean — Dynamic Client Registration)

**McpRefreshToken**:
- Linked to McpAccessToken via `accessTokenId`
- Has `familyId` for rotation tracking

### Existing API Endpoints

| Endpoint | Method | Purpose | Usable? |
|----------|--------|---------|---------|
| `/api/vault/delegation` | GET | Returns `availableTokens` (active MCP tokens for current user) | Partial — returns id, clientName, clientId, scopes, expiresAt |
| `/api/vault/delegation/[id]` | DELETE | Revoke delegation session (NOT the MCP token itself) | No — revokes delegation session only |
| `/api/mcp/revoke` | POST | RFC 7009 token revocation | No — requires raw token value + client_id (server stores only hash) |

### Gap: Revocation by Token ID

None of the existing endpoints can revoke an MCP access token **by its database ID**
from a user session. A new endpoint is needed:

```
DELETE /api/user/mcp-tokens/[id]
  Auth: user session (authjs)
  Logic:
    1. Find McpAccessToken where { id, userId } (IDOR prevention)
    2. Set revokedAt = now
    3. Revoke all McpRefreshTokens in the same familyId
    4. Audit log: DELEGATION_REVOKE or new MCP_TOKEN_REVOKE action
  Response: 204 No Content
```

The revocation logic pattern already exists in `src/lib/mcp/oauth-server.ts` → `revokeToken()`.
The difference: `revokeToken()` looks up by `tokenHash`, the new endpoint looks up by `id + userId`.

### Existing Patterns to Follow

**Component pattern**: `src/components/settings/delegation-manager.tsx`
- Card-based layout with list items
- 30-second refresh for TTL display
- Badge components for metadata
- `useTranslations("MachineIdentity")` with nested delegation keys

**Nav item pattern**: `src/app/[locale]/dashboard/settings/layout.tsx`
- Developer section children array at lines 34-43
- Each child: `{ href, icon, label: t("subTabXxx") }`

**i18n namespace registration**: `src/i18n/messages.ts` → `NAMESPACES` array (72 entries)

**Test pattern**: `src/components/settings/mcp-client-card.test.tsx` (fetch + CRUD + revoke)

## Implementation Steps

### 1. New API Endpoint

Create `src/app/api/user/mcp-tokens/[id]/route.ts`:
- DELETE handler: session auth → find token by id + userId → revoke token + refresh family → audit log
- Consider: also create GET `/api/user/mcp-tokens` for listing (or reuse delegation endpoint's `availableTokens`)

### 2. New Component

Create `src/components/settings/mcp-connections-card.tsx`:
- Follow target Card pattern: Card > CardHeader(icon + CardTitle + CardDescription) > CardContent
- Fetch active MCP tokens for current user (via API)
- Display: client name, public client ID, scopes (as badges), created date, expiration
- Actions: revoke individual connection (with confirmation dialog)
- Empty state when no connections
- Icon suggestion: `Plug` or `Link2` from lucide-react

### 3. New Page

Create `src/app/[locale]/dashboard/settings/developer/connections/page.tsx`:
- Render `<McpConnectionsCard />`
- Follow "1 page = 1 card" pattern

### 4. Navigation

Update `src/app/[locale]/dashboard/settings/layout.tsx`:
- Add nav item to developer section children
- Icon: `Plug` or `Link2`
- i18n key: `t("subTabConnections")`

### 5. i18n Keys

Option A: Add to existing `MachineIdentity` namespace under a `connections` nested key
Option B: Create new `McpConnections` namespace

Keys needed:
- `title`, `description` (card header)
- `clientName`, `scopes`, `created`, `expires`
- `revoke`, `revokeConfirm`, `revokeSuccess`
- `noConnections`, `noConnectionsDescription`
- `subTabConnections` (nav label — in Settings namespace)

If creating new namespace: register in `src/i18n/messages.ts` NAMESPACES array.

### 6. Tests

Create `src/components/settings/mcp-connections-card.test.tsx`:
- Mock fetch for token list
- Test render with connections
- Test empty state
- Test revoke flow (confirmation dialog + API call)
- Reference: `mcp-client-card.test.tsx`

## Schema Consideration

`McpAccessToken` has no `lastUsedAt` field. Options:
1. **Skip "last used" display** (recommended for this task — simplest)
2. Add `lastUsedAt` to schema (requires Prisma migration) — defer to separate task

## Constraints

- Follow "1 page = 1 card" layout principle
- Card must use CardHeader/CardTitle/CardDescription/CardContent pattern
- No raw token values exposed in API responses
- IDOR prevention: all queries must include userId
- Run `npx vitest run` + `npx next build` after changes
- i18n keys must exist in both en and ja

## Verification

After implementation:
1. Navigate to `/dashboard/settings/developer/connections`
2. See list of authorized MCP clients (or empty state)
3. Revoke a connection → confirm dialog → connection disappears from list
4. Revoked token can no longer be used for MCP tool calls
