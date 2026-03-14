# Code Review: fix-invitation-callback-vault
Date: 2026-03-14T00:00:00+09:00
Review round: 1 (final)

## Changes from Previous Round
Initial review — all findings resolved in single pass.

## Functionality Findings
### F1 (Minor) — `alreadyMember: true` shows empty role in accept message
- File: `src/app/[locale]/dashboard/teams/invite/[token]/page.tsx:98`
- Problem: When API returns `alreadyMember: true` without `role`, the `acceptInviteDesc` template renders with empty role placeholder
- Recommended fix: Use conditional to show `alreadyMember` text instead of `acceptInviteDesc`

## Security Findings
### S1 (Minor) — `error.message` may leak schema information
- File: `src/auth.ts:274`
- Problem: Logging `error.message` from Prisma exceptions can expose database schema details in logs
- Recommended fix: Log `error.constructor.name` only

### S3 (Minor) — `searchParams.error` not validated
- File: `src/app/[locale]/auth/error/page.tsx:32`
- Problem: Unvalidated query parameter reflected into component logic; unknown codes should fall through to generic error
- Recommended fix: Validate against allowed Auth.js error codes list

## Testing Findings
### T2 (Major) — No tests for invite page error states and retry button
- File: `src/app/[locale]/dashboard/teams/invite/[token]/page.test.tsx`
- Problem: Existing tests only cover success and vault-not-unlocked paths; no coverage for 410/404/network error/retry
- Recommended fix: Add tests for error responses and retry button rendering

### T3 (Major) — No test file for auth error page
- File: `src/app/[locale]/auth/error/page.test.tsx`
- Problem: No test file exists for the rewritten auth error page
- Recommended fix: Create test file covering Verification, AccessDenied, unknown code, and missing param scenarios

## Resolution Status
### F1 Minor — alreadyMember empty role display
- Action: Added conditional branch — `result.alreadyMember` shows `t("alreadyMember")` instead of `acceptInviteDesc`
- Modified file: src/app/[locale]/dashboard/teams/invite/[token]/page.tsx:98

### S1 Minor — error.message schema leakage
- Action: Changed `error.message` to `error.constructor.name` in log output
- Modified file: src/auth.ts:274

### S3 Minor — searchParams.error validation
- Action: Added `ALLOWED_ERROR_CODES` list validation; unknown codes fall through to generic error
- Modified file: src/app/[locale]/auth/error/page.tsx:37-42

### T2 Major — invite page error state tests
- Action: Added 5 tests covering 410, 404, network error, retry button, and alreadyMember display
- Modified file: src/app/[locale]/dashboard/teams/invite/[token]/page.test.tsx

### T3 Major — auth error page tests
- Action: Created test file with 5 tests covering Verification, AccessDenied, unknown code, no param, and signin link
- Modified file: src/app/[locale]/auth/error/page.test.tsx (new)
