# Plan Review: p2002-put-route-error-handling
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor] Pattern sample does not show withTenantRls wrapper
- Problem: Plan's code sample shows `prisma.*.update()` directly, but actual code uses `withUserTenantRls(...)` / `withTeamTenantRls(...)`. The try-catch must wrap the RLS wrapper call, not the inner update.
- Impact: Implementer could misapply the pattern
- Recommended action: Update plan pattern to show wrapping the RLS call
- **Resolution: Fix — update plan**

### F2 [Minor] Empty updateData edge case
- Problem: If no fields change, `data: {}` is passed to update — P2002 won't trigger in this case
- Impact: None — P2002 handler is unreachable but harmless
- Resolution: No action needed

### F3 [Minor] Tag duplicate check condition gap
- Problem: parentId change to same value skips manual check
- Impact: None after P2002 addition
- Resolution: No action needed (P2002 covers it)

## Security Findings

No Critical or Major findings.

### S1 [Minor] findFirst vs findUnique inconsistency in tag route
- Problem: Tag duplicate check uses `findFirst` while folders use `findUnique`
- Impact: Low — both work correctly
- Resolution: Out of scope for this PR

### [Adjacent] Team tag route missing audit logs
- Flagged by Security expert — may overlap with Functionality scope
- Resolution: Out of scope — separate issue

## Testing Findings

### T1 [Major] Wrong test file for Route 3 (team tags)
- Problem: Plan references `src/__tests__/api/tags/tags.test.ts` but that covers `/api/tags` (personal), not `/api/teams/[teamId]/tags/[id]`. No dedicated test file exists for team tag PUT.
- Impact: Test would be in wrong file or fail to import correct handler
- Recommended action: Create new test file or locate correct existing file
- **Resolution: Fix — update plan with correct test file path**

### T2 [Major] Reference test file path incorrect
- Problem: Plan says `service-accounts/[id]/route.test.ts L203-224` without full path
- Impact: Implementer can't find reference
- Recommended action: Use full path `src/app/api/tenant/service-accounts/[id]/route.test.ts`
- **Resolution: Fix — update plan**

### T3 [Minor] Test sample doesn't show pre-step mock setup
- Problem: Folder PUT has findUnique → findFirst → update flow. P2002 test needs prior mocks to pass manual check before reaching update.
- Impact: Test may return 409 from manual check instead of P2002 path
- Recommended action: Clarify in plan that prior mocks must allow manual check to pass
- **Resolution: Fix — update plan testing section**

### T4 [Minor] mapPrismaError utility exists but uses generic code
- Problem: `src/lib/prisma-error.ts` has `mapPrismaError` but returns generic `API_ERROR.CONFLICT`
- Impact: Plan correctly uses specific error codes — no conflict
- Resolution: No action needed (we want specific codes, not generic)

## Adjacent Findings
- Team tag route missing audit logs (from Security) — tracked as separate issue

## Quality Warnings
None
