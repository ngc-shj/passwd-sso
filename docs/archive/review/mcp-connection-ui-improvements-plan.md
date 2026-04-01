# Plan: mcp-connection-ui-improvements

## Objective

Improve the MCP connection management UI to address five user-reported issues:

1. **Tenant/personal info parity**: The personal connections page lacks information available on the tenant admin page (allowed scopes, active status, etc.)
2. **Registration date missing**: The MCP client registration date (`McpClient.createdAt`) is not shown on the personal connections page
3. **Last used date missing**: No `lastUsedAt` field exists on `McpAccessToken` — neither view can show when a connection was last used
4. **No search functionality**: Neither the tenant admin nor personal connections page supports searching/filtering
5. **No revoke-all on personal side**: The personal page can only revoke individual connections; there is no bulk revoke or "revoke all my MCP connections" action

## Requirements

### Functional Requirements

- F1: Personal connections page displays allowed scopes for each MCP client (not just the token's granted scopes)
- F2: Personal connections page displays the MCP client registration date (`McpClient.createdAt`)
- F3: Both views display `lastUsedAt` for MCP connections — requires schema migration
- F4: Both the tenant admin and personal connections pages support client-side text search (by client name and clientId)
- F5: Personal connections page includes a "Revoke All" button to revoke all active MCP connections at once

### Non-Functional Requirements

- NF1: `lastUsedAt` update must be non-blocking (fire-and-forget) with throttling to avoid excessive DB writes
- NF2: Search must be client-side filtering (consistent with existing patterns like `TenantMembersCard`)
- NF3: All new UI text must have both `en` and `ja` translations
- NF4: No breaking changes to existing API response shapes — add new fields only

## Technical Approach

### Schema Changes

1. Add `lastUsedAt DateTime? @map("last_used_at")` to the `McpAccessToken` model in `prisma/schema.prisma`
2. Add `MCP_CONNECTION_REVOKE_ALL` to the `AuditAction` enum in `prisma/schema.prisma`

Both changes are in a single migration.

### API Changes

#### `GET /api/user/mcp-tokens` — Add fields to response

Current response per client:
```ts
{ id, clientId, name, isDcr, connection: { tokenId, scope, createdAt, expiresAt } | null }
```

New response per client (additions marked with `+`):
```ts
{
  id, clientId, name, isDcr,
+ allowedScopes: string,       // from McpClient.allowedScopes
+ clientCreatedAt: string,     // from McpClient.createdAt
  connection: {
    tokenId, scope, createdAt, expiresAt,
+   lastUsedAt: string | null  // from McpAccessToken.lastUsedAt
  } | null
}
```

#### `GET /api/tenant/mcp-clients` — Add lastUsedAt

Add the most recent `lastUsedAt` from the client's active access tokens to the response. Note: the existing GET handler uses `withTenantRls` which queries `McpClient` (tenant-scoped). The nested `accessTokens` relation select works because Prisma resolves relations via JOINs within the same query, bypassing per-table RLS. Verify this works in dev with `passwd_app` role; if not, use a separate `withBypassRls`-wrapped query for `lastUsedAt` aggregation.

#### `DELETE /api/user/mcp-tokens` (new) — Bulk revoke

New endpoint to revoke all active MCP connections for the calling user. Follows the existing `DELETE /api/sessions` (revoke-all sessions) pattern:
- **Authentication**: Requires session auth via `auth()` — same guard as `GET /api/user/mcp-tokens`. Rejects unauthenticated requests with 401
- **Rate limiting**: `createRateLimiter({ windowMs: 60_000, max: 5 })` — same as `DELETE /api/sessions`
- **Query scope**: `where: { userId, tenantId, revokedAt: null, expiresAt: { gt: now } }` — cannot affect other users' tokens
- **Transaction**: Within a single transaction:
  1. Find all active `McpAccessToken` records for the user (scoped by userId + tenantId)
  2. Mark all as revoked (`revokedAt: now`)
  3. For each token, collect all `familyId` values from `McpRefreshToken` and revoke all tokens in each family
  4. Revoke all `DelegationSession` records linked to each token (include `userId` in WHERE for defense-in-depth, even though `mcpTokenId` already scopes to user)
- **RLS wrapper**: All DB operations must use `withBypassRls` (same as existing GET and single-revoke handlers — `mcp_access_tokens` uses `bypass_rls` policy, not `app.tenant_id`)
- **Audit logging**: Single `MCP_CONNECTION_REVOKE_ALL` audit entry with `revokedCount` metadata and explicit `tenantId` (matches `SESSION_REVOKE_ALL` pattern, consistent with other MCP audit entries that pass `tenantId`). If `revokedCount === 0`, skip the audit entry (no-op revoke is not auditable).
- **Post-commit**: Evict Redis delegation keys for all revoked delegation sessions
- **Response**: `{ revokedCount: number }` so the UI can confirm the action

Consider extracting the per-token revoke logic (refresh family + delegation session + Redis eviction) into a shared helper function that both the single-revoke `[id]/route.ts` and bulk-revoke endpoint can use. When refactoring, also add `userId` to the DelegationSession WHERE clause in `[id]/route.ts` for consistency (currently only scoped by `mcpTokenId`).

#### `validateMcpToken` — Update lastUsedAt

After successful token validation in `src/lib/mcp/oauth-server.ts`, add a throttled best-effort `lastUsedAt` update using the existing `MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS` constant from `src/lib/constants/mcp.ts`. Requires adding `lastUsedAt` to the token query `select`. On failure, log with `getLogger().warn()` (matching SCIM token pattern, not silent `.catch(() => {})`).

### UI Changes

#### `McpConnectionsCard` (personal page)

1. **Show allowed scopes**: Display `ScopeBadges` for `client.allowedScopes` for all clients (not just connected ones)
2. **Show client registration date**: Display `clientCreatedAt` from the new API field
3. **Show last used date**: Display `connection.lastUsedAt` when available, "Never" when null
4. **Add search input**: Inline search field filtering by client `name` and `clientId` — follow `TenantMembersCard` pattern (Search icon + Input with `pl-9`)
5. **Add "Revoke All" button**: Destructive button in card header action area, shown when at least one connection exists. Follow `SessionsCard` / `DelegationManager` pattern with `AlertDialog` confirmation
6. **Update `McpClientConnection` interface**: Add `allowedScopes`, `clientCreatedAt` fields, and `lastUsedAt` to connection

#### `McpClientCard` (tenant admin page)

1. **Show last used date**: Display the most recent `lastUsedAt` for each client
2. **Add search input**: Same inline search pattern, filtering by client `name` and `clientId`

### i18n Keys to Add

In `messages/{en,ja}/MachineIdentity.json`:

**Top-level (tenant admin):**
- `mcpLastUsed` — "Last used" / "最終利用"
- `mcpNeverUsed` — "Never" / "未使用"
- `mcpSearchPlaceholder` — "Search clients..." / "クライアントを検索..."
- `mcpNoMatchingClients` — "No matching clients" / "一致するクライアントがありません"

**In `mcpConnections` (personal):**
- `allowedScopes` — "Allowed scopes" / "許可されたスコープ"
- `registeredAt` — "Registered" / "登録日"
- `lastUsed` — "Last used" / "最終利用"
- `neverUsed` — "Never" / "未使用"
- `searchPlaceholder` — "Search connections..." / "接続を検索..."
- `noMatchingConnections` — "No matching connections" / "一致する接続がありません"
- `revokeAll` — "Revoke all" / "すべて失効"
- `revokeAllTitle` — "Revoke all connections?" / "すべての接続を失効しますか？"
- `revokeAllDescription` — "All active MCP connections will be revoked. Connected agents will lose access immediately." / "すべてのアクティブなMCP接続が失効されます。接続中のエージェントは即座にアクセスを失います。"
- `revokeAllSuccess` — "All connections revoked" / "すべての接続を失効しました"

In `messages/{en,ja}/AuditLog.json`:
- `MCP_CONNECTION_REVOKE_ALL` — "Revoked all MCP connections" / "すべてのMCP接続を失効"

## Files to Update

### Schema & Migration
- `prisma/schema.prisma` — Add `lastUsedAt` to `McpAccessToken`, add `MCP_CONNECTION_REVOKE_ALL` to `AuditAction` enum

### Constants & Audit
- `src/lib/constants/audit.ts` — Add `MCP_CONNECTION_REVOKE_ALL` to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_PERSONAL` (DELEGATION group)
- `src/lib/constants/api-path.ts` — No new constant needed; bulk revoke uses existing `USER_MCP_TOKENS` path with DELETE method

### Backend
- `src/lib/mcp/oauth-server.ts` — Add `lastUsedAt` to `validateMcpToken` select + throttled update
- `src/app/api/user/mcp-tokens/route.ts` — Add new fields to GET response, add DELETE handler for bulk revoke
- `src/app/api/user/mcp-tokens/[id]/route.ts` — Add `userId` to DelegationSession WHERE clause (defense-in-depth fix)
- `src/app/api/tenant/mcp-clients/route.ts` — Add `lastUsedAt` to GET response

### Frontend
- `src/components/settings/mcp-connections-card.tsx` — Add allowed scopes, registration date, lastUsedAt, search, Revoke All, update interface
- `src/components/settings/mcp-client-card.tsx` — Add lastUsedAt, search, update interface

### i18n
- `messages/en/MachineIdentity.json` — Add new keys
- `messages/ja/MachineIdentity.json` — Add new keys
- `messages/en/AuditLog.json` — Add `MCP_CONNECTION_REVOKE_ALL`
- `messages/ja/AuditLog.json` — Add `MCP_CONNECTION_REVOKE_ALL`

### Tests
- `src/lib/mcp/oauth-server.test.ts` — Add throttle test cases (3 scenarios) + update mock
- `src/app/api/user/mcp-tokens/route.test.ts` — Update GET assertions, add DELETE bulk revoke tests
- `src/app/api/tenant/mcp-clients/route.test.ts` — Update GET assertions for lastUsedAt
- `src/components/settings/mcp-connections-card.test.tsx` — Update fixtures, add tests for new fields + search + Revoke All
- `src/lib/constants/mcp.test.ts` — Add value sanity check for MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS

## Implementation Steps

1. **Schema migration**: Add `lastUsedAt` to `McpAccessToken` model and `MCP_CONNECTION_REVOKE_ALL` to `AuditAction` enum. Create single Prisma migration.
2. **Update audit constants**: Add `MCP_CONNECTION_REVOKE_ALL` to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, and `AUDIT_ACTION_GROUPS_PERSONAL` in `src/lib/constants/audit.ts`. Add i18n keys in AuditLog.json (en + ja).
3. **Update `validateMcpToken`**: Add `lastUsedAt` to select, add throttled fire-and-forget update using existing `MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS`, log failures with `getLogger().warn()`.
4. **Update `GET /api/user/mcp-tokens`**: Add `allowedScopes`, `clientCreatedAt`, and `connection.lastUsedAt` to Prisma select and response mapping.
5. **Update `GET /api/tenant/mcp-clients`**: Add most recent `lastUsedAt` from access tokens to each client in response.
6. **Create `DELETE /api/user/mcp-tokens`**: Bulk revoke endpoint with rate limiting, session auth, userId+tenantId scoped query. Transaction: revoke tokens → revoke refresh families (by familyId) → revoke delegation sessions (with userId in WHERE). Single `MCP_CONNECTION_REVOKE_ALL` audit entry with tenantId. Post-commit Redis eviction. Uses existing `API_PATH.USER_MCP_TOKENS` (no new constant). Also fix existing `[id]/route.ts` to add `userId` to DelegationSession WHERE clause (unconditional, not dependent on helper extraction).
7. **Add i18n keys**: Both `en` and `ja` translation files for MachineIdentity.json.
8. **Update `McpConnectionsCard`**: Update `McpClientConnection` interface with new fields. Show allowed scopes, client registration date, last used date. Add search input. Add "Revoke All" button with AlertDialog confirmation.
9. **Update `McpClientCard`**: Update `McpClient` interface. Show last used date. Add search input.
10. **Write tests**: (a) `oauth-server.test.ts`: 3 throttle scenarios + mock update. (b) `route.test.ts` for bulk DELETE: side effects, edge cases. (c) Update GET route test assertions. (d) `mcp-connections-card.test.tsx`: new fields, search, Revoke All. (e) `mcp.test.ts`: constant sanity check. Test search filtering regardless of whether it's extracted to a utility.

## Testing Strategy

- **Bulk revoke endpoint** (`DELETE /api/user/mcp-tokens`):
  - All active tokens for user are revoked
  - Refresh token families are fully revoked (by familyId)
  - Delegation sessions linked to each token are revoked
  - Redis eviction called for each delegation session
  - Single `MCP_CONNECTION_REVOKE_ALL` audit entry with correct `revokedCount`
  - Mixed revoked/active tokens: only active ones processed
  - Zero active tokens: returns `{ revokedCount: 0 }` with 200, no audit entry written
  - Unauthenticated request returns 401
  - Rate limiting enforced (follow `sessions/route.test.ts` pattern: `mockRateLimiter.check.mockResolvedValue({ allowed: false })` → 429)
- **validateMcpToken throttle**:
  - `lastUsedAt` is null → update called
  - `lastUsedAt` older than threshold → update called
  - `lastUsedAt` within threshold → update NOT called
  - Update mock added to existing test setup (prevents false positives)
  - Existing `findUnique` mock objects must also include `lastUsedAt` field to correctly test throttle branches
- **GET endpoint field additions**:
  - `allowedScopes`, `clientCreatedAt`, `lastUsedAt` present in response with correct format (ISO string, not Date)
  - `lastUsedAt` is null when token has never been used
- **UI component tests**:
  - New fields rendered correctly
  - Search filtering: empty query shows all, case-insensitive match on name/clientId, no match shows empty state
  - Revoke All: button hidden when no connections, visible when at least one connection exists, confirmation dialog, API call, state update
- **Constant sanity**: `MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS` is a positive integer
- **Build verification**: `npx vitest run` + `npx next build` must both pass

## Considerations & Constraints

- **Additive API changes only**: Existing clients consuming `GET /api/user/mcp-tokens` or `GET /api/tenant/mcp-clients` must not break. New fields are added alongside existing ones.
- **lastUsedAt throttle**: 5-minute throttle using existing `MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS` prevents excessive DB writes on high-frequency MCP tool calls. Failures logged with `getLogger().warn()`.
- **Bulk revoke audit logging**: Single `MCP_CONNECTION_REVOKE_ALL` summary entry with `revokedCount` metadata (matches `SESSION_REVOKE_ALL` pattern). Individual token revokes continue using `MCP_CONNECTION_REVOKE`.
- **Shared revoke helper**: Consider extracting per-token revoke logic into a shared function for DRY between single and bulk endpoints.
- **No "block client" feature**: The personal page does not add the ability to permanently block a client from future connections. That would require a new `McpClientBlock` model and is out of scope.
- **Client-side search only**: The MCP client list is bounded by `MAX_MCP_CLIENTS_PER_TENANT = 10`, so server-side search is unnecessary.
- **Rate limiting**: Bulk revoke endpoint uses same rate limiter parameters as session revoke-all (`windowMs: 60_000, max: 5`).

## User Operation Scenarios

### Scenario 1: User views their MCP connections
1. User navigates to Settings > MCP > Connections
2. Page loads all tenant MCP clients with the user's connection status
3. Each client shows: name, clientId, DCR badge, allowed scopes, registration date
4. Connected clients additionally show: granted scopes, token creation date, expiry, last used date
5. Unconnected clients show "Not Connected" badge but still display client info (allowed scopes, registration date)

### Scenario 2: User searches for a specific MCP client
1. User types "cursor" into the search field
2. The list filters to show only clients whose name or clientId contains "cursor" (case-insensitive)
3. If no matches, an empty state message is shown
4. Clearing the search restores the full list

### Scenario 3: User revokes all MCP connections
1. User clicks "Revoke All" button in the card header
2. Confirmation dialog appears warning that all agents will lose access
3. User confirms
4. All active tokens, refresh families, and delegation sessions are revoked in a single transaction
5. UI state is updated locally: all clients' `connection` is set to `null`, showing "Not Connected" status
6. Toast confirms success with the number of revoked connections

### Scenario 4: Tenant admin searches MCP clients
1. Admin navigates to Admin > MCP > Clients
2. Types a query into the search field
3. Both active and inactive clients are filtered by name/clientId
4. The inactive collapsible section also respects the search filter

### Scenario 5: Tenant admin checks last activity
1. Admin views the MCP clients list
2. Each client shows "Last used: <date>" or "Never" if no tokens were ever validated
3. Admin uses this to identify unused clients for cleanup
