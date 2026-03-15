# Plan Review: unify-callback-url
Date: 2026-03-15
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] Server-side origin resolution — use `getAppOrigin()` instead of placeholder
- **Status:** Accepted → plan updated
- **Action:** Use `getAppOrigin()` from env vars with try-catch fallback

### F2 [Major] Email `redirect: false` constraint not documented
- **Status:** Accepted → plan updated
- **Action:** Add explicit constraint in plan

### F3 [Major] next-intl `router.push()` with query string verification needed
- **Status:** Accepted → plan updated
- **Action:** Verified: next-intl accepts string href including query params when no pathnames config. Add verification note.

### F4 [Minor] `searchParams` Props type addition for SignInPage
- **Status:** Accepted → plan updated
- **Action:** Add to Step 9 description

### F5 [Minor] `withBasePath` server-side usage
- **Status:** Accepted → plan updated
- **Action:** Use `BASE_PATH` constant directly instead of `withBasePath` function

## Security Findings

### S1 [Critical → Minor (downgraded by Opus)] Server component origin validation
- **Status:** Downgraded to Minor by Opus escalation review
- **Reason:** `getAppOrigin()` reads from env vars (not request headers), proxy always generates relative paths, fail-closed behavior when env vars unset
- **Action:** Use `getAppOrigin()` with try-catch (already in plan). Add error handling for malformed env var.

### S2 [Major] Auth.js trustHost setting interaction
- **Status:** Noted as consideration
- **Action:** Add comment in implementation that callbackUrl is pre-validated. No code change needed — `resolveCallbackUrl` is the first-line defense regardless of Auth.js config.

### S3 [Minor] Relative path validation ordering
- **Status:** Accepted
- **Action:** Implementation will use clear ordering with comments

## Testing Findings

### T1 [Critical] No component-level tests verifying router.push/signIn args
- **Status:** Accepted → plan updated
- **Action:** Add component tests for each modified sign-in component

### T2 [Critical] No test for SignInPage already-logged-in redirect with callbackUrl
- **Status:** Accepted → plan updated
- **Action:** Add test case to page.test.ts

### T3 [Major] Missing encoded query string test case
- **Status:** Accepted → plan updated
- **Action:** Add `/dashboard%3Fext_connect%3D1` test case

### T4 [Major] auto-extension-connect.test.tsx update scope unclear
- **Status:** Rejected — this file tests AutoExtensionConnect which is not modified. No update needed.

### T5 [Major] stripLocalePrefix + resolveCallbackUrl integration test missing
- **Status:** Accepted → plan updated
- **Action:** Add integration test for locale-prefixed callbackUrl flow

### T6 [Minor] Hook test should verify return value
- **Status:** Accepted → plan updated
- **Action:** Test both call args and return value

## Adjacent Findings

### [Adjacent] S4 [Major] Extension token DOM injection XSS risk
- **Status:** Out of scope for this plan. Existing behavior, not introduced by this change.
- **Action:** Note for future security review
