# Code Review: fix-auth-adapter-rls
Date: 2026-04-01
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
No findings.

## Security Findings

### S1 [Minor] `resolveTenantIdForUser` implicitly depends on Prisma proxy for RLS bypass
- File: src/lib/auth-adapter.ts:24-32
- Evidence: Function uses `prisma.user.findUnique` without explicit `tx` parameter. Currently works because callers (`linkAccount` line 211, `createSession` line 249) invoke it inside `withBypassRls` callback, and the Prisma proxy routes via AsyncLocalStorage `ctx.tx`.
- Problem: Implicit dependency on proxy routing makes the code fragile. If `resolveTenantIdForUser` is called outside `withBypassRls` in future refactoring, it will fail with the same RLS error.
- Impact: No current runtime impact; future regression risk.
- Fix: Pre-existing code pattern, not introduced by this diff. No action required in this PR.

### S2 [Minor] `getAccount` uses `findFirst` instead of `findUnique`
- File: src/lib/auth-adapter.ts:390-408
- Evidence: `getUserByAccount` (line 70) uses `findUnique` with the composite unique constraint, while `getAccount` uses `findFirst`. The base PrismaAdapter also uses `findFirst` for `getAccount`.
- Problem: Consistency concern. In practice, `(provider, providerAccountId)` has a UNIQUE constraint (`@@unique([provider, providerAccountId])` in schema), so `findFirst` returns the same result as `findUnique`.
- Impact: No functional or security impact due to the unique constraint.
- Fix: No action required. Matches base adapter behavior.

### S3 [Dismissed] `deleteUser` cascade risk with RLS bypass
- Original finding: `deleteUser` with `withBypassRls` could delete any user regardless of tenant.
- Assessment: `deleteUser` and `unlinkAccount` are defined in the adapter interface but NOT called anywhere — neither by `@auth/core` runtime code (verified: zero references in `@auth/core/*.js`) nor by application code. They are dead code, included only for adapter interface completeness. No attack surface exists.
- Decision: No action required.

## Testing Findings

### T1 [Critical] No tests for 8 new adapter methods
- File: src/lib/auth-adapter.test.ts
- Problem: `getUser`, `getUserByEmail`, `getUserByAccount`, `updateUser`, `deleteUser`, `unlinkAccount`, `deleteSession`, `getAccount` have zero test coverage.
- Impact: RLS bypass behavior (the core of this bug fix) is unverified by tests.
- Fix: Add tests for each method verifying: (1) `withBypassRls` is called, (2) correct return value, (3) null/not-found cases.

### T2 [Major] Mock objects missing methods needed for new tests
- File: src/lib/auth-adapter.test.ts:10-23
- Problem: `mockPrismaUser` lacks `update` and `delete`. `mockPrismaAccount` lacks `findUnique`, `findFirst`, and `delete`.
- Fix: Add missing mock methods.

### T3 [Major] Null email guard branches untested
- File: src/lib/auth-adapter.ts:50, 62, 91, 361
- Problem: `getUser`, `getUserByEmail`, `getUserByAccount` return null when email is missing. `updateUser` throws `USER_EMAIL_MISSING`. These branches are untested.
- Fix: Add test cases with null email responses.

## Adjacent Findings
None.

## Quality Warnings
None.

## Resolution Status
### T1 [Critical] No tests for 8 new adapter methods
- Action: Added 16 tests across 8 new describe blocks (getUser, getUserByEmail, getUserByAccount, updateUser, deleteUser, unlinkAccount, deleteSession, getAccount)
- Modified file: src/lib/auth-adapter.test.ts

### T2 [Major] Mock objects missing methods
- Action: Added `update`, `delete` to `mockPrismaUser`; added `findUnique`, `findFirst`, `delete` to `mockPrismaAccount`
- Modified file: src/lib/auth-adapter.test.ts:10-25

### T3 [Major] Null email guard branches untested
- Action: Included null-email test cases in getUser, getUserByEmail, getUserByAccount, and updateUser describe blocks
- Modified file: src/lib/auth-adapter.test.ts
