# Code Review: restore-session-cookie-samesite
Date: 2026-05-19
Review round: 1 (Phase 3 incremental verification)

## Summary

All three expert reviews returned no Critical / Major findings. Implementation matches plan
contracts C1 and C2 exactly; security audit confirms no regression beyond the documented
pre-PR-`#468` posture restoration; tests are non-vacuous.

## Functionality Review

**No findings.**

Verified:
- C1: `src/auth.config.ts:147` reads `sameSite: "lax" as const`. Comment flipped to OAuth-callback rationale.
- C1: `src/auth.config.test.ts` existing test flipped in place; no duplicate spec created.
- C2: `src/lib/proxy/page-route.ts:134-139` passes all four attributes (`name`, `path`, `secure`,
  `httpOnly`, `sameSite`) to `cookies.delete()`.
- Call-time evaluation invariant: `isSecureCookieFromAuthUrl()` invoked inside `clearAuthSessionCookies()`,
  not at module scope.
- `clearAuthSessionCookies` remains module-private (not exported).
- Forbidden patterns absent from production code (only documentation references in plan/review .md).

## Security Review

**No findings.**

GET endpoint regression spot-check (beyond plan's audit):
- `/api/share-links/[id]/content` — unauthenticated (Bearer share-token), session cookie irrelevant.
- `/api/emergency-access/[id]/vault/entries` — read-only; SameSite shift irrelevant.
- `/api/mobile/authorize/redirect` — static HTML.
- `/api/extension/bridge-code` — POST only, covered by proxy CSRF gate.

No new cross-site GET attack surface introduced by the `Strict → Lax` revert.

Cookie-write/delete inventory (full survey of `src/`):
- `src/auth.config.ts:25` — sets sessionToken (target of this fix). ✓
- `src/app/api/auth/passkey/verify/route.ts:188-194` — sets sessionToken with
  `{ sameSite: "lax", secure: isSecureCookieFromAuthUrl(), httpOnly: true }`. Already correct;
  matches the new delete-time attribute profile.
- `src/lib/proxy/page-route.ts:134` — the new delete site. ✓
- No other session-cookie write/delete sites in `src/`.

Threat-model deltas:
- Login CSRF: still defended by Auth.js `state` cookie + PKCE — unaffected.
- Mutating CSRF: proxy CSRF gate (Origin check on POST/PUT/PATCH/DELETE) load-bearing — unaffected.
- Session-cookie deletion now actually deletes `__Secure-` / `__Host-` prefixed cookies on logout
  and redirect-clear paths — a net security improvement.

## Testing Review

**No findings (one Minor observation resolved before report).**

Verified:
- RT5: new tests invoke `handlePageRoute(makePageRequest("/ja/dashboard/passwords"), dummyOptions)`
  and reach `clearAuthSessionCookies` via the natural redirect path — production primitive exercised.
- RT1: tests use `response.headers.getSetCookie()` which reads the actual `Set-Cookie` byte stream,
  not internal mock state. Matches the API surface browsers consume.
- Non-vacuous behavior: dropping any of `Secure`, `HttpOnly`, `SameSite=lax`, `Max-Age=0`/epoch
  `Expires` fails the test. Hardcoding `secure: true` fails the http-branch test. Shrinking
  `ALL_KNOWN_SESSION_COOKIE_NAMES` fails the loop assertion.
- RT3: `HTTPS_AUTH_URL` and `APP_ORIGIN` introduced as file-local test constants; the matching
  constants in `cors.test.ts` and `callback-url.test.ts` are themselves file-local test scaffolding,
  not shared utilities — importing them would create cross-test-file coupling. Tradeoff judged correct.

Initial Minor (env stub teardown): RESOLVED — the global test setup at
`src/__tests__/setup.ts:21-23` already runs `vi.unstubAllEnvs()` in `afterEach`, so `vi.stubEnv`
calls in the new tests are correctly cleaned up. No code change needed.

## Verdict

Approve. No outstanding findings.
