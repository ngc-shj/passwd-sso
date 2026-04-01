# Code Review: mcp-connection-ui-improvements
Date: 2026-04-01
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### FUNC-1 [Major]: tenant/mcp-clients/route.test.ts lastUsedAt assertions missing
- File: src/app/api/tenant/mcp-clients/route.test.ts
- Problem: GET handler now returns lastUsedAt but test didn't verify it
- Resolution: Added lastUsedAt to mock data + assertions. Added user mock for batch-fetch.

### FUNC-2 [Major]: mcp-connections-card.test.tsx search/Revoke All tests missing
- File: src/components/settings/mcp-connections-card.test.tsx
- Problem: Plan-specified test cases for search filtering and Revoke All were not implemented
- Resolution: Added 5 test cases: search by name, no-match empty state, Revoke All success, hidden when no connections, neverUsed display.

### FUNC-3 [Minor]: updateMany WHERE missing revokedAt: null
- File: src/app/api/user/mcp-tokens/route.ts
- Problem: Defensive revokedAt filter missing on first updateMany
- Resolution: Added `revokedAt: null` to WHERE clause.

## Security Findings

### SEC-F01 [Minor]: findMany outside transaction (TOCTOU)
- File: src/app/api/user/mcp-tokens/route.ts
- Problem: Active token lookup was outside the transaction, allowing race condition
- Resolution: Moved findMany inside $transaction for full consistency.

### SEC-F02 [Minor]: Sibling token revoke missing userId guard
- File: src/app/api/user/mcp-tokens/route.ts
- Problem: Related access token updateMany lacked userId+tenantId in WHERE
- Resolution: Added `userId, tenantId` to WHERE clause for defense-in-depth.

## Testing Findings

### TEST-F2 [Major]: delegationSession scope filter not verified
- File: src/app/api/user/mcp-tokens/route.test.ts
- Problem: Assertion didn't verify mcpTokenId in delegationSession WHERE
- Resolution: Added mcpTokenId assertion to updateMany verification.

### TEST-F3 [Major]: Revoke All success path untested
- File: src/components/settings/mcp-connections-card.test.tsx
- Problem: Same as FUNC-2
- Resolution: Same as FUNC-2.

### TEST-F4 [Major]: webhook-dispatcher.test.ts flaky timer pattern
- File: src/lib/webhook-dispatcher.test.ts
- Problem: vi.useRealTimers() + setTimeout(50) was fragile
- Resolution: Replaced with vi.waitFor() for reliable async assertion.

### TEST-F5 [Minor]: Sibling token revocation assertion missing
- File: src/app/api/user/mcp-tokens/route.test.ts
- Problem: Second mcpAccessTokenUpdateMany call not verified
- Resolution: Added `expect(mockMcpAccessTokenUpdateMany).toHaveBeenCalledTimes(2)`.

## Adjacent Findings
- RS2: New auditLog.create lacks actorType field (consistent with existing pattern, not a regression)

## Quality Warnings
None

## Resolution Status

### FUNC-1 [Major] tenant test lastUsedAt
- Action: Added lastUsedAt to mock + assertions + user mock
- Modified: src/app/api/tenant/mcp-clients/route.test.ts

### FUNC-2 [Major] search/Revoke All tests
- Action: Added 5 new test cases
- Modified: src/components/settings/mcp-connections-card.test.tsx

### FUNC-3 [Minor] updateMany revokedAt guard
- Action: Added revokedAt: null to WHERE
- Modified: src/app/api/user/mcp-tokens/route.ts

### SEC-F01 [Minor] findMany inside transaction
- Action: Moved findMany into $transaction block
- Modified: src/app/api/user/mcp-tokens/route.ts

### SEC-F02 [Minor] userId guard on sibling tokens
- Action: Added userId, tenantId to WHERE
- Modified: src/app/api/user/mcp-tokens/route.ts

### TEST-F2 [Major] delegationSession assertion
- Action: Added mcpTokenId scope check
- Modified: src/app/api/user/mcp-tokens/route.test.ts

### TEST-F4 [Major] webhook timer fix
- Action: Replaced with vi.waitFor()
- Modified: src/lib/webhook-dispatcher.test.ts

### TEST-F5 [Minor] sibling token assertion
- Action: Added toHaveBeenCalledTimes(2)
- Modified: src/app/api/user/mcp-tokens/route.test.ts
