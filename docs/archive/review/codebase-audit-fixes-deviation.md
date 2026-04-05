# Coding Deviation Log: codebase-audit-fixes
Created: 2026-04-05T13:15:00+09:00

## Deviations from Plan

### D-1: cursorInvalid field replaced with standalone isValidCursorId function
- **Plan description**: Add `cursorInvalid: boolean` field to `AuditLogParams` interface
- **Actual implementation**: Added standalone `isValidCursorId(cursor: string | null | undefined): boolean` function exported from `audit-query.ts`. Each consumer calls the function directly.
- **Reason**: Avoids changing the `AuditLogParams` interface, which would require updating all 4+ type references. The standalone function approach requires the same 3-line check in each consumer but avoids interface changes.
- **Impact scope**: All 8 cursor-paginated routes, audit-query.ts

### D-2: Download routes excluded from cursor validation
- **Plan description**: Listed `audit-logs/download`, `teams/[teamId]/audit-logs/download`, `tenant/audit-logs/download` as routes covered via audit-query.ts
- **Actual implementation**: Download routes were excluded — they use internal cursors (from previous query results, not user input) and do not call `parseAuditLogParams`.
- **Reason**: Download routes iterate with `while (hasMore)` loop, deriving cursor from `batch[last].id`. No user-supplied cursor to validate.
- **Impact scope**: No change needed in download routes

### D-3: Report-To include_subdomains simplified (no env var)
- **Plan description**: Originally proposed `REPORT_SUBDOMAINS=true|false` env var (later revised to simple removal)
- **Actual implementation**: Removed `include_subdomains: true` line from Report-To JSON
- **Reason**: No subdomains in use; simpler than adding configuration
- **Impact scope**: src/proxy.ts only

### D-4: Seven existing test files required cursor value updates
- **Plan description**: Not mentioned in plan
- **Actual implementation**: Updated cursor values in 7 existing test files from non-UUID strings (e.g., "abc123", "log-5") to valid UUID format ("550e8400-e29b-41d4-a716-446655440000") to work with new validation. "Prisma error" tests updated to use "00000000-0000-0000-0000-000000000000" (valid UUID that doesn't exist in DB).
- **Reason**: New validation rejects non-UUID cursor values before reaching Prisma, causing existing tests to receive 400 instead of expected 200
- **Impact scope**: Test files only — no production code change

---
