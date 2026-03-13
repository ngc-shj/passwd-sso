# Code Review: unify-auth-patterns
Date: 2026-03-14
Review round: 1 (all findings resolved in round 1)

## Changes from Previous Round
Initial review.

## Functionality Findings

### F-Major-1: vault/status scope_insufficient error code normalization
- **Severity:** Major
- **Status:** Accepted (intentional)
- **Problem:** vault/status previously returned `{ error: "UNAUTHORIZED" }` with status 403 for scope_insufficient. New code returns `EXTENSION_TOKEN_SCOPE_INSUFFICIENT` with status 403.
- **Resolution:** This is a documented intentional normalization per the plan. Extension clients should already handle `EXTENSION_TOKEN_SCOPE_INSUFFICIENT` on 403 since other endpoints use this code.

### F-Minor-1: console.warn fires in test environment
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** `process.env.NODE_ENV !== "production"` includes `test` environment.
- **Resolution:** Changed to `=== "development"`. Updated test to set NODE_ENV=development.

### F-Minor-2: Test uses `new Response()` instead of `NextResponse`
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** `check-auth.test.ts` used `new Response()` for access-denied mock instead of `NextResponse.json()`.
- **Resolution:** Changed to `NextResponse.json()`.

## Security Findings

### S-Minor-1: allowTokens JSDoc enhancement
- **Severity:** Minor
- **Status:** No action needed
- **Problem:** JSDoc could note that allowTokens without scope skips scope validation.
- **Resolution:** Existing JSDoc and console.warn in development are sufficient.

### S-Minor-2: skipAccessRestriction comment clarity
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** Comment should clarify this is a deliberate design decision.
- **Resolution:** Strengthened comments in api-keys routes to say "deliberate" and explain rationale.

## Testing Findings

### T-Major-1: POST api-keys missing test paths
- **Severity:** Major
- **Status:** Resolved
- **Problem:** Invalid JSON, key limit exceeded, and user-not-found paths untested.
- **Resolution:** Added 3 test cases.

### T-Major-2: checkAuth call options not verified
- **Severity:** Major
- **Status:** Resolved
- **Problem:** Tests don't verify `{ allowTokens: true, skipAccessRestriction: true }` options.
- **Resolution:** Added option verification tests in both api-keys route test files.

### T-Major-3: api_key + access restriction denied path not tested
- **Severity:** Major
- **Status:** Resolved
- **Problem:** Only token type tested for access restriction denial; api_key with tenantId not tested.
- **Resolution:** Added test case verifying tenantId is passed to enforceAccessRestriction.

### T-Minor-1: hasVerifier: true path never tested
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** vault/unlock/data tests always set `passphraseVerifierHmac: null`.
- **Resolution:** Added test case with non-null `passphraseVerifierHmac`.

### T-Minor-2: authOk helper omits scopes for token type
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** `authOk("...", "token")` returns mock without `scopes` field.
- **Resolution:** Updated helpers in vault/status and vault/unlock/data tests to include `scopes: []` for token type.

### T-Minor-3: Cross-user ownership on DELETE not tested
- **Severity:** Minor
- **Status:** Resolved
- **Problem:** No test for key belonging to another user.
- **Resolution:** Added test case returning 404 for other-user's key.

## Resolution Status
All findings resolved. Tests: 4211 passed (387 files). Build: passed.
