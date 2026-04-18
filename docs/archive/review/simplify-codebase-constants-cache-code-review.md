# Code Review: simplify-codebase-constants-cache
Date: 2026-04-17
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 Major: Tenant download route while-loop guard inconsistency
- File: `src/app/api/tenant/audit-logs/download/route.ts:123`
- Problem: `while (hasMore)` missing `&& totalRows < AUDIT_LOG_MAX_ROWS` guard; issues spurious `take: 0` DB query at exact row cap; inconsistent with the two routes this PR aligned
- Fix: Change to `while (hasMore && totalRows < AUDIT_LOG_MAX_ROWS)`

### F3 Minor: Log message mixes structured key with freeform prose
- File: `src/auth.ts:30`
- Problem: `"auth.bootstrap.migration_blocked: expected 1 active member"` breaks dot-key log convention
- Fix: Move prose to `reason` field in the structured payload

## Security Findings

### S2 Minor: Structured logger exposes full error objects
- File: `src/auth.ts:295-299`
- Problem: `{ err: error }` passes full pino error serialization to structured logs
- Impact: Prisma error metadata may appear in log aggregators
- Note: Pre-existing `console.error` also goes to stdout; practical difference is small

## Testing Findings

### T3 Minor: audit-csv.test.ts does not test AUDIT_LOG_CSV_HEADERS
- File: `src/lib/audit-csv.test.ts`
- Fix: Add test verifying actorType position in shared headers

### T6 Minor: auth.test.ts does not mock @/lib/logger
- File: `src/auth.test.ts`
- Problem: New `getLogger().error()` call emits to stdout during tests
- Fix: Add logger mock

## Adjacent Findings
None

## Quality Warnings
None (local LLM pre-screening found no issues)

## Resolution Status

### F1 Major: Tenant download route while-loop guard — Resolved
- Action: Added `&& totalRows < AUDIT_LOG_MAX_ROWS` to while-loop guard
- Modified file: `src/app/api/tenant/audit-logs/download/route.ts:123`

### F3 Minor: Log message format — Resolved
- Action: Moved prose to `reason` field in structured payload
- Modified file: `src/auth.ts:30`

### S2 Minor: Structured logger error serialization — Accepted
- **Anti-Deferral check**: Acceptable risk
- **Justification**:
  - Worst case: Prisma error metadata (tenantId, query context) in log aggregator
  - Likelihood: Low — auth callback errors are rare and Prisma errors in this path don't contain user credentials
  - Cost to fix: Moderate — requires custom error serializer that risks losing diagnostic value
- **Orchestrator sign-off**: Acceptable risk. Pre-existing `console.error` also went to stdout. Log access controls are the correct mitigation.

### T3 Minor: AUDIT_LOG_CSV_HEADERS test — Resolved
- Action: Added 2 tests verifying header content and position
- Modified file: `src/lib/audit-csv.test.ts`

### T6 Minor: Logger mock in auth.test.ts — Resolved
- Action: Added `vi.mock("@/lib/logger")` to prevent test stdout pollution
- Modified file: `src/auth.test.ts`
