# Plan Review: mcp-connections-page
Date: 2026-03-31
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### [F-1] Major (ACCEPTED): DelegationSession cleanup on revoke
- **Problem**: Revoking an access token via `revokedAt` update does NOT cascade-delete DelegationSessions (cascade only applies to DB delete, not soft-delete). Active DelegationSessions would remain.
- **Resolution**: Added Step 4e/4f to the DELETE transaction: revoke DelegationSessions by mcpTokenId + evict Redis delegation keys.

### [F-2] Major (ACCEPTED): AuditAction enum needs Prisma migration
- **Problem**: `MCP_CONNECTION_REVOKE` (or similar) does not exist in AuditAction enum. `AUDIT_ACTION` constants are 1:1 with the enum via `satisfies Record<AuditAction, AuditAction>`.
- **Resolution**: Added Step 1 (before API endpoints) for enum + constants + migration.

### [F-3] Major (ACCEPTED): withBypassRls not explicitly specified
- **Problem**: Delegation route uses `withBypassRls` for McpAccessToken queries; new endpoints must do the same.
- **Resolution**: Added `withBypassRls` usage to GET and DELETE endpoint descriptions. Merged with S-4.

### [F-4] Minor (ACCEPTED): Settings.json not in file update list
- **Resolution**: Added explicit file list to Step 5.

### [F-5] Minor (SKIPPED): userId null check
- Non-issue: auth() returns non-null userId; SA tokens have null userId and are naturally excluded.

## Security Findings

### [S-1] Major (ACCEPTED): Refresh token family revocation clarity
- **Problem**: Plan steps b→c were ambiguous about whether full familyId chain is revoked.
- **Resolution**: Expanded Steps 4b-4d with explicit flow: find familyId via accessTokenId → updateMany by familyId → also revoke related access tokens from the family.

### [S-2] Major (ACCEPTED): tenantId source not specified
- **Problem**: Query includes tenantId but source (session) not specified.
- **Resolution**: Both endpoints now specify "extract userId + tenantId from auth() session" and include tenantId in WHERE clauses.

### [S-3] Minor (ACCEPTED): 404 enumeration prevention
- **Resolution**: Added design note to DELETE endpoint: "not found / wrong user / already revoked all return 404 (enumeration prevention)".

### [S-4] Minor (ACCEPTED): withBypassRls vs withUserTenantRls
- **Resolution**: Merged with F-3. Specified `withBypassRls` with explicit userId + tenantId filters (matching delegation route pattern).

## Testing Findings

### [T-1] Major (ACCEPTED): Revoke list update verification
- **Resolution**: Test case 5 now includes "assert item removed from DOM" after revoke.

### [T-2] Major (ACCEPTED): Toast verification
- **Resolution**: Added explicit test case 6 (success toast) and incorporated error toast in cases 7/8.

### [T-3] Major (ACCEPTED): Network error vs HTTP error separation
- **Resolution**: Split into test case 7 (HTTP error, ok: false) and case 8 (network exception, Promise.reject).

### [T-4] Minor (ACCEPTED): Initial load failure test
- **Resolution**: Added test case 3 (mockFetch.mockRejectedValue → graceful error/empty state).

### [T-5] Minor (ACCEPTED): AlertDialog mock pattern
- **Resolution**: Added AlertDialog mock wiring note with data-testid reference.

### [T-6] Adjacent (SKIPPED): CLAUDE.md API endpoint list
- CLAUDE.md gets updated after implementation ships, not during plan phase.

## Adjacent Findings
None requiring action.

## Quality Warnings
None
