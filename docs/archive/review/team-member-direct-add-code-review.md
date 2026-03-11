# Code Review: team-member-direct-add
Date: 2026-03-12
Review round: 2

## Round 1 Findings

### F2 [Major] isPrismaUniqueConstraintError doesn't verify constraint target
- File: `src/app/api/teams/[teamId]/members/route.ts:220-227`
- Resolution: Added `meta.target` check for `teamId` and `userId` fields with safe fallback to `false`.

### F3 [Minor] UI shows same error for ALREADY_A_MEMBER and SCIM_MANAGED_MEMBER
- File: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx:339-343`
- Resolution: Read response body and distinguish error codes in toast message.

### S3 [Minor] Pending invitation email→userId query missing tenantId filter
- File: `src/app/api/teams/[teamId]/members/search/route.ts:70-73`
- Resolution: Added `tenantId: team.tenantId` to the User findMany query.

### T1 [Major] No test file for search route
- Resolution: Created `route.test.ts` with 8 tests (auth, permission, validation, results, exclusions, RLS).

### T2 [Major] No tests for POST handler
- Resolution: Added 10 POST tests to existing test file (auth, permission, validation, creation, reactivation, SCIM, tenant checks, race condition).

### T3 [Minor] AbortController not aborted on component unmount
- Resolution: Added `abortRef.current?.abort()` to effect cleanup function.

## Round 2 Findings

### F2-followup [Minor] Fallback `return true` too permissive (Functionality)
- Resolution: Changed fallback from `return true` to `return false` — unknown constraints now re-throw.

### F3-B [Minor] Pre-existing bug: handleInvite uses wrong error string (Functionality)
- File: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx:219`
- Problem: `data.error === "User is already a member"` doesn't match API response `"ALREADY_A_MEMBER"`.
- Resolution: Fixed to `data.error === "ALREADY_A_MEMBER"`.

### T2-B [Minor] Second 404 path untested (Testing)
- Problem: Case where user exists but has no active TenantMember was untested.
- Resolution: Added dedicated test case.

### Remaining Minor findings (accepted, not fixed — pre-existing patterns or low impact)
- N1 [Minor] TOCTOU between `requireTeamPermission` and `withTeamTenantRls` — pre-existing pattern across all team routes. Acceptable.
- N2 [Minor] Global `prisma` used inside `withTeamTenantRls` callback — pre-existing pattern, works via AsyncLocalStorage + Prisma extension.
- N3 [Informational] Clipboard auto-write of invite token — pre-existing UX pattern.
- T1-A [Minor] Pending invitation test fragile mock ordering — acceptable for unit tests.
- T1-B [Minor] No max(100) boundary test — low risk, schema validation is declarative.
- T2-C [Minor] Shallow audit log assertion — acceptable, audit integration tested elsewhere.

## Final Status

All Critical and Major findings resolved. All Minor findings either fixed or documented as accepted.
Tests: 381 files, 4146 tests passing.
Build: Production build successful.
