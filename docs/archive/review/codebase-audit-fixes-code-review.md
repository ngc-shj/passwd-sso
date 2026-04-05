# Code Review: codebase-audit-fixes
Date: 2026-04-05T13:25:00+09:00
Review round: 2 (final)

## Changes from Previous Round
Round 2 fixes:
- F1 [Major] CUID dead code → removed CUID branch from CURSOR_ID_RE
- S1 [Major] No rate limiter → added 20/min IP-based rate limiter to MCP authorize
- F2 [Minor] cursor ?? undefined → changed to searchParams.get("cursor")
- T1 [Minor] parseAuditLogParams cursor test → updated to valid UUID
- T2 [Minor] code_challenge_method default test → added param null assertion

## Functionality Findings

### F1 [Major]: CURSOR_ID_RE CUID branch is dead code — RESOLVED
- File: src/lib/validations/common.ts:18
- Action: Removed CUID branch; all DB models use UUIDv4

### F2 [Minor]: directory-sync cursor `?? undefined` inconsistency — RESOLVED
- File: src/app/api/directory-sync/[id]/logs/route.ts:64
- Action: Changed to `searchParams.get("cursor")` for consistency

### F3 [Minor]: notifications route uses inline error responses — SKIPPED
- File: src/app/api/notifications/route.ts
- Reason: Existing code pattern, not introduced by this change

## Security Findings

### S1 [Major]: MCP authorize has no rate limiting — RESOLVED
- File: src/app/api/mcp/authorize/route.ts
- Action: Added `authorizeLimiter` (20/min, IP-based) before session check

### S2 [Minor]: Timing side-channel in validateOAuthRequest — MITIGATED
- File: src/app/api/mcp/authorize/route.ts:20-21
- Mitigated by S1 rate limiter; statistical timing attack requires high volume

### S3 [Minor]: callbackUrl origin verification — SKIPPED
- File: src/app/api/mcp/authorize/route.ts:37-38
- Reason: `serverAppUrl` always returns APP_URL origin; existing code

## Testing Findings

### T1 [Minor]: parseAuditLogParams cursor test uses non-UUID — RESOLVED
- File: src/lib/audit-query.test.ts:107
- Action: Updated to valid UUID

### T2 [Minor]: code_challenge_method default test insufficient — RESOLVED
- File: src/__tests__/api/mcp/authorize.test.ts:255-260
- Action: Added assertion that param is null in redirect URL

### T3 [Minor]: oversized request test flakiness — SKIPPED
- File: cli/src/__tests__/integration/agent-decrypt-ipc.test.ts
- Reason: Existing test, not introduced by this change

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status

### F1 [Major] CUID dead code
- Action: Removed CUID branch from CURSOR_ID_RE regex, updated tests
- Modified files: src/lib/validations/common.ts:18, src/lib/audit-query.test.ts

### S1 [Major] No rate limiter on MCP authorize
- Action: Added IP-based rate limiter (20 req/min) with extractClientIp + rateLimitKeyFromIp
- Modified files: src/app/api/mcp/authorize/route.ts, src/__tests__/api/mcp/authorize.test.ts

### F2 [Minor] cursor ?? undefined
- Action: Changed to searchParams.get("cursor")
- Modified file: src/app/api/directory-sync/[id]/logs/route.ts:64

### T1 [Minor] cursor test value
- Action: Updated "cursor-id-123" to valid UUID
- Modified file: src/lib/audit-query.test.ts:107

### T2 [Minor] code_challenge_method default
- Action: Added searchParams.get assertion
- Modified file: src/__tests__/api/mcp/authorize.test.ts:260
