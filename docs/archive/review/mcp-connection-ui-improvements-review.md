# Plan Review: mcp-connection-ui-improvements
Date: 2026-04-01
Review round: 3

## Changes from Previous Round
Round 1: All 13 findings addressed (Critical 2, Major 7, Minor 4)
Round 2: 6 new findings addressed (Major 1, Minor 5)
Round 3: 6 new findings addressed (Major 1, Minor 5):
- SEC-Round3-1: DelegationSession userId fix in [id]/route.ts now unconditional (not dependent on helper extraction)
- SEC-Round3-2: tenantId specified in MCP_CONNECTION_REVOKE_ALL audit entry
- FUNC-Round3-1: Stale "Add API path constant" text removed from Step 6
- FUNC-Round3-2: RLS note added for tenant GET lastUsedAt subquery
- TEST-Round3-1: Zero-active-tokens edge case added with no-audit-entry behavior
- TEST-Round3-2: Revoke All button visibility test both branches specified

## Functionality Findings

### FUNC-1 [Major]: Bulk revoke must include refresh token chain processing
- Problem: The plan mentions "transaction: revoke tokens + refresh families + delegation sessions" but does not explicitly describe the familyId-based refresh token chain revoke that the single-revoke endpoint performs. Without explicit chain processing, RefreshTokens remain valid and can be used to issue new access tokens after "Revoke All".
- Impact: Revoke All is functionally broken — agents can re-obtain access via refresh tokens.
- Recommended action: Add to Step 6: "For each revoked token, collect all familyIds from McpRefreshToken, then revoke all tokens in each family. Also revoke all DelegationSessions linked to each token." Consider extracting shared helper from the single-revoke endpoint.

### FUNC-2 [Major]: Missing AuditAction enum and downstream updates
- Problem: Bulk revoke needs a distinguishable audit action. If using existing `MCP_CONNECTION_REVOKE` per-token, it's indistinguishable from individual revokes. If adding `MCP_CONNECTION_REVOKE_ALL`, then:
  - `schema.prisma` AuditAction enum needs update (migration required)
  - `src/lib/constants/audit.ts` AUDIT_ACTION object, AUDIT_ACTION_VALUES array, AUDIT_ACTION_GROUPS need update
  - `audit.test.ts` exhaustiveness test will fail without updates
  - i18n AuditLog keys need the new action
- Impact: Build failure from `satisfies Record<AuditAction, AuditAction>` type check, or indistinguishable audit entries.
- Recommended action: Add `MCP_CONNECTION_REVOKE_ALL` to schema enum (Step 1), audit constants, i18n, and list these files in implementation steps.

### FUNC-3 [Major]: Implementation step ordering for clientCreatedAt is unclear
- Problem: Step 10 (update McpClientConnection interface) depends on Step 4 (API changes) and must be done before Step 8 (UI update). The ordering is ambiguous.
- Impact: Risk of API returning field that UI doesn't display, or type errors.
- Recommended action: Merge Step 10 into Step 8, or reorder to immediately follow Step 4.

### FUNC-4 [Minor]: MCP_TOKEN_LAST_USED_THROTTLE_MS constant already exists
- Problem: `MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS` is already defined in `src/lib/constants/mcp.ts` (line 40). Step 2 proposes adding a new constant.
- Impact: Double definition or name inconsistency.
- Recommended action: Remove Step 2 and reference existing constant in Step 3.

## Security Findings

### SEC-1 [Major]: Bulk revoke WHERE clause must explicitly include userId + tenantId
- Problem: The bulk revoke `updateMany` query must include both `userId` (from session) and `tenantId` in the WHERE clause to prevent IDOR. The plan states "scoped by userId" but doesn't detail the query conditions.
- Impact: Without userId+tenantId in WHERE, could revoke another user's tokens within the same tenant.
- Recommended action: Explicitly specify in plan: `where: { userId, tenantId, revokedAt: null, expiresAt: { gt: now } }`.

### SEC-2 [Major]: Rate limiting missing on bulk revoke endpoint
- Problem: `DELETE /api/sessions` (revoke-all sessions) uses `createRateLimiter({ windowMs: 60_000, max: 5 })`. The new bulk revoke has no rate limiting mentioned.
- Impact: Authenticated attacker can spam Revoke All, triggering mass Redis evictions and DB writes.
- Recommended action: Add `createRateLimiter` with same parameters as DELETE /api/sessions.

### SEC-3 [Minor]: lastUsedAt fire-and-forget should log failures (merged with FUNC-4 context)
- Problem: SCIM token implementation logs failures with `getLogger().warn()`, but plan just says "fire-and-forget" without specifying failure logging.
- Impact: Silent failures hide DB connection issues.
- Recommended action: Use `getLogger().warn()` pattern from SCIM token implementation.

### SEC-4 [Minor]: Audit log granularity — prefer summary entry for bulk operations
- Problem: Per-token audit entries for bulk revoke creates N entries in a transaction. Existing `SESSION_REVOKE_ALL` uses a single summary entry with `revokedCount`.
- Impact: Harder to distinguish bulk from serial individual revokes during incident investigation. Transaction performance with many entries.
- Recommended action: Use single summary entry with `MCP_CONNECTION_REVOKE_ALL` action and `revokedCount` metadata (aligns with FUNC-2).

## Testing Findings

### TEST-1 [Critical]: Bulk revoke endpoint needs comprehensive side-effect tests
- Problem: No tests planned for the full chain of side effects in bulk revoke (refresh token family revoke, delegation session revoke, Redis eviction, audit logging). The existing `mcp-connections-card.test.tsx` only covers single DELETE.
- Impact: Complex multi-step DB transaction can have partial execution bugs that pass tests silently.
- Recommended action: Create `DELETE /api/user/mcp-tokens` route test covering: (1) all tokens revoked, (2) refresh families revoked, (3) delegation sessions revoked, (4) Redis eviction called, (5) audit entries created, (6) mixed revoked/active tokens handled correctly.

### TEST-2 [Critical]: validateMcpToken throttle logic needs Prisma mock update
- Problem: Existing `oauth-server.test.ts` mocks don't include `mcpAccessToken.update` stub. Adding throttle logic without mock update causes either runtime errors or false-positive tests.
- Impact: Throttle logic untestable or silently passes.
- Recommended action: Add 3 test cases: (1) lastUsedAt null → update called, (2) lastUsedAt > threshold → update called, (3) lastUsedAt within threshold → update NOT called. Add `update` mock to existing test setup.

### TEST-3 [Major]: Existing route tests need new field assertions
- Problem: `route.test.ts` for both GET endpoints and `mcp-connections-card.test.tsx` don't assert new fields (allowedScopes, clientCreatedAt, lastUsedAt).
- Impact: API could return wrong format (Date vs string, null vs undefined) without test detection. Known project issue (RT1: mock-reality divergence).
- Recommended action: Update test fixtures with new fields and add assertions for format correctness.

### TEST-4 [Major]: MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS needs value sanity test
- Problem: The constant exists but has no test verifying it's a positive number.
- Impact: Zero or negative value would disable throttling entirely.
- Recommended action: Add value range assertion in `mcp.test.ts`.

### TEST-5 [Minor]: Search filter testing strategy is ambiguous
- Problem: Plan says "unit tests for search filtering logic (if extracted to a shared utility)" — conditional testing is not acceptable.
- Impact: If not extracted, search filtering goes untested.
- Recommended action: Commit to testing search behavior regardless of extraction (component test or utility test).

## Adjacent Findings

### [Adjacent] FUNC → Testing: `mcp-connections-card.test.tsx` lacks coverage for new fields and Revoke All functionality. Testing expert should ensure these are covered.

## Quality Warnings
None — all findings are specific and actionable.
