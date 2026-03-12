# Code Review: team-member-direct-add
Date: 2026-03-12
Review round: 3

## Round 1 Findings (from initial review)

### F2 [Major] isPrismaUniqueConstraintError doesn't verify constraint target
- Resolution: Added `meta.target` check for `teamId` and `userId` fields with safe fallback to `false`.

### F3 [Minor] UI shows same error for ALREADY_A_MEMBER and SCIM_MANAGED_MEMBER
- Resolution: Read response body and distinguish error codes in toast message.

### S3 [Minor] Pending invitation email→userId query missing tenantId filter
- Resolution: Added `tenantId: team.tenantId` to the User findMany query.

### T1 [Major] No test file for search route
- Resolution: Created `route.test.ts` with 8 tests (auth, permission, validation, results, exclusions, RLS).

### T2 [Major] No tests for POST handler
- Resolution: Added 10 POST tests to existing test file (auth, permission, validation, creation, reactivation, SCIM, tenant checks, race condition).

### T3 [Minor] AbortController not aborted on component unmount
- Resolution: Added `abortRef.current?.abort()` to effect cleanup function.

## Round 2 Findings

### F2-followup [Minor] Fallback `return true` too permissive
- Resolution: Changed fallback from `return true` to `return false` — unknown constraints now re-throw.

### F3-B [Minor] Pre-existing bug: handleInvite uses wrong error string
- Resolution: Fixed to `data.error === "ALREADY_A_MEMBER"`.

### T2-B [Minor] Second 404 path untested
- Resolution: Added dedicated test case.

## Round 3 Findings (sub-tab refactor + comprehensive review)

### F1 [Major] search/route.ts — withTeamTenantRls exception not caught
- Problem: `withTeamTenantRls` throws `TENANT_NOT_RESOLVED` if team deleted between auth and RLS
- Resolution: Added try/catch around `withTeamTenantRls` call, returns `[]` on error

### F2-R3/S3-R3 [Major] isPrismaUniqueConstraintError — Array.isArray guard
- Problem: `meta.target` could be non-array; string `target` would cause substring match
- Resolution: Added `Array.isArray(meta?.target)` runtime guard

### S1 [Major] LIKE wildcard characters not escaped
- Problem: `%` and `_` passed directly to Prisma `contains` (→ ILIKE) → DoS via full-table scans
- Resolution: Added `query.replace(/[%_\\]/g, "\\$&")` escaping

### S2 [Major] No self-add guard
- Problem: ADMIN could add themselves, changing own role via reactivation path
- Resolution: Added `userId === session.user.id` check returning 400

### F3-R3 [Minor] SCIM_MANAGED_MEMBER error message too generic
- Problem: UI showed generic failure for SCIM-managed members
- Resolution: Added `scimManagedCannotAdd` i18n key with IdP guidance

### T1-R3 [Major] P2002 race condition test missing edge cases
- Resolution: Added tests for P2002 with no meta (re-throw) and unrelated constraint (re-throw)

### T2-R3 [Major] Reactivation test doesn't verify key cleanup
- Resolution: Added `expect(mockPrismaTeamMemberKey.deleteMany)` assertion

### T3-R3 [Major] Audit log test doesn't assert arguments
- Resolution: Changed to `toHaveBeenCalledWith(expect.objectContaining({...}))`

### T4-R3 [Minor] Missing boundary test for q > 100 chars
- Resolution: Added test with 101 chars expecting 400

### T5-R3 [Minor] Self-add test
- Resolution: Added test expecting 400

## Final Status

All Critical and Major findings resolved across 3 rounds.
Tests: 381 files, 4150 tests passing.
Build: Production build successful.
