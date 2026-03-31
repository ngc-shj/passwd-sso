# Code Review: mcp-connections-page
Date: 2026-04-01
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### [F-1] Critical (ACCEPTED): DELEGATION_REVOKE audit log missing + Redis eviction inside transaction
- File: `src/app/api/user/mcp-tokens/[id]/route.ts:66-91`
- Problem: When MCP token revocation cascades to delegation sessions, no DELEGATION_REVOKE audit entries were created. Redis eviction was inside the transaction callback.
- Fix: Added individual DELEGATION_REVOKE audit log entries for each revoked delegation session. Moved Redis eviction after transaction commit.

### [F-2] Major (ACCEPTED): Existing revokeDelegationSession() utility bypassed
- Merged with F-1. The inline implementation is justified because revokeDelegationSession() requires individual session lookup and our batch revoke is more efficient. Added the missing audit log entries to achieve parity.

### [F-3] Major (ACCEPTED): Hardcoded "Cancel" in AlertDialogCancel
- File: `src/components/settings/mcp-connections-card.tsx:141`
- Fix: Changed to `{t("cancel")}`, added `cancel` key to MachineIdentity.mcpConnections namespace (en/ja).

### [F-4] Minor (SKIPPED): Unnecessary "use client" on page.tsx
- Existing project pattern: delegation/page.tsx also uses "use client". Consistent with codebase convention.

## Security Findings

### [S-1] Major (ACCEPTED): Proxy middleware not covering /api/user/mcp-tokens
- File: `src/proxy.ts:171`
- Problem: New endpoints bypassed IP access restriction enforcement.
- Fix: Added `pathname.startsWith(API_PATH.USER_MCP_TOKENS)` to proxy session enforcement block.

### [S-2] Minor (SKIPPED): TOCTOU in findFirst → update
- Practical risk is negligible (UUID v4, no tenant reassignment path). Existing pattern in codebase.

### [S-3] Minor (SKIPPED): userId nullable intention comment
- Code behavior is correct. Comment would be documentation improvement only.

### [S-4] Minor (SKIPPED): Redis eviction failure logging
- Existing project pattern uses `.catch(() => {})` for best-effort Redis operations.

## Testing Findings

### [T-1] Critical (ACCEPTED): Missing test — initial load failure
- Fix: Added "shows empty state when initial fetch throws network error" test.

### [T-2] Critical (ACCEPTED): Missing test — revoke network error
- Fix: Added "shows error toast when revoke throws network error" test with item-remains assertion.

### [T-3] Major (ACCEPTED): Revoke flow split into incomplete tests
- Fix: Merged into single test verifying DELETE call + URL + success toast + item removed.

### [T-4] Major (ACCEPTED): DELETE URL not verified
- Fix: Added exact URL assertion `/api/user/mcp-tokens/token-1` in revoke test.

### [T-5] Major (ACCEPTED): Comma-separated scope untested
- Fix: Changed second sample connection scope to comma-separated, added badge assertion.

### [T-7] Minor (ACCEPTED): Item-remains assertion missing in error test
- Fix: Added `expect(screen.getByText("My MCP Agent")).toBeInTheDocument()` after error toast.

## Adjacent Findings
- RS2: DELETE rate limit — project-wide pattern, not specific to this feature
- clientName DCR validation — DCR endpoint scope, not this feature

## Quality Warnings
None

## Resolution Status
All Critical and Major findings resolved. 3 Minor findings skipped (consistent with project patterns).
