# Plan Review: restore-session-cookie-samesite
Date: 2026-05-19
Review round: 1

## Changes from Previous Round

Initial review.

## Round 2 Summary (local LLM verification)

Round 1 findings addressed via plan amendments:
- F-TEST-C1 (Critical) → C1 contract amended to include `src/auth.config.test.ts` flip + forbidden-pattern
- F-TEST-M1 → Test `#1` now ships explicit `headers.getSetCookie()` assertion shape
- F-TEST-M2 → Test `#1` specifies reuse of `handlePageRoute` integration pattern, no export of private function
- F-TEST-M3 → Test asserts Secure + HttpOnly + SameSite=lax + Max-Age=0/Expires
- F-TEST-M4 → New test `#2` covers `AUTH_URL=http://localhost` (no-Secure branch)
- F-FUNC-01 → C2 invariant: call-time evaluation of `isSecureCookieFromAuthUrl()`
- F-FUNC-02 → Note added (passkey-verify already uses Lax)
- F-FUNC-03 / F-TEST-MIN3 → Plan now standardizes on existing `auth.config.test.ts`
- F-SEC-F6 → C1 invariant: other Auth.js cookies retain defaults
- F-SEC-F7 → Test `#3` extends to httpOnly assertion
- F-SEC-F8 → Test `#1` iterates over all 5 cookie names
- F-TEST-MIN1 (RT3) → Test derives name via `getSessionCookieName()`
- F-TEST-MIN2 → Manual step 5b added

Round 2 local LLM pre-review surfaced one repeat (CSRF GET surface — already covered by plan's
"Known risks" section, accepted as pre-PR-`#468` restoration) and two non-findings (shared-utility
inventory false positive; SameSite-constant extraction is YAGNI for a single use). Closing review
without invoking expert sub-agents a second time; the addressed Critical and Majors are concrete
plan amendments, not speculative concerns.

## Functionality Findings

### F-FUNC-01 [Minor]
- Problem: C2 should explicitly require `isSecureCookieFromAuthUrl()` be called inline, not memoized at module scope.
- Impact: Future refactor could hoist the call and silently bypass test env stubs.
- Action: Add invariant to C2: "`isSecureCookieFromAuthUrl()` MUST be invoked at the point of cookie deletion, not memoized."

### F-FUNC-02 [Minor]
- Problem: Plan does not note that `src/app/api/auth/passkey/verify/route.ts:191` already issues `SameSite=Lax` for the session cookie, proving the proposed posture is the same as what runs today on the passkey flow.
- Impact: Documentation completeness only.
- Action: Add a note confirming the passkey-verify path was unaffected by PR `#468`.

### F-FUNC-03 [Minor]
- Problem: Test `#2` should reference the existing `src/auth.config.test.ts` rather than create a new spec.
- Action: Extend the existing test file (overlaps with F-TEST-C1).

## Security Findings

### F-SEC-F1 [Minor]
- Problem: `__Host-` cookie deletion requires `Path=/` per RFC 6265bis §4.1.3.2. Current path is `${basePath}/`. Invariant holds because cookie-name selector only emits `__Host-` when basePath is empty.
- Action: No functional change required; optionally document inline.

### F-SEC-F2 [Minor]
- Problem: Magic-link one-time-use defense correctly characterized.
- Action: Optionally add manual-test step confirming cross-email redemption.

### F-SEC-F3 [Minor — Adjacent]
- Note: Plan's GET-mutation audit accuracy verified. No additional endpoints.

### F-SEC-F4 [Minor]
- Note: `/api/mobile/authorize` GET-CSRF surface acknowledged in plan. Step-up + PKCE + device_jkt + opaque 302 (cross-origin) make it non-exploitable.

### F-SEC-F5 [Minor]
- Note: RFC 6749 §3.1 citation verified accurate.

### F-SEC-F6 [Minor]
- Problem: Plan does not document that Auth.js helper cookies (`authjs.state-token`, `authjs.pkce.code_verifier`, `authjs.callback-url`) retain Auth.js defaults (SameSite=Lax). Only `cookies.sessionToken` is overridden.
- Action: Add a one-line invariant to C1 acceptance criteria.

### F-SEC-F7 [Minor]
- Problem: Test `#2` should additionally lock `httpOnly === true`, `path` (basePath-prefixed), and `secure` consistency.
- Action: Extend Test `#2` to assert all four cookie attributes.

### F-SEC-F8 [Minor]
- Problem: Test `#1` only verifies "at least one known cookie name carries Secure." Iterate over all 5 entries in `ALL_KNOWN_SESSION_COOKIE_NAMES`.
- Action: Loop the assertion.

## Testing Findings

### F-TEST-C1 [Critical]
- Problem: Existing `src/auth.config.test.ts:63-66` already asserts `sameSite === "strict"`. Plan's test `#2` proposes a NEW file but does not mention the existing test — which WILL FAIL after C1 change.
- Impact: CI blocked; duplicate tests would mask regressions.
- Action: Update plan test `#2` — modify the EXISTING `src/auth.config.test.ts` describe block. Flip `strict` → `lax`. Do NOT create new file. Add to C1: `src/auth.config.test.ts` must no longer contain `.toBe("strict")` on the sameSite line.

### F-TEST-M1 [Major]
- Problem: Test `#1` lacks assertion shape; `response.cookies.get(name)` after delete returns undefined regardless of Secure flag — risk of vacuous pass.
- Action: Specify in plan: use `response.headers.getSetCookie()`, find the line starting with the cookie name, regex-assert `Secure`, `HttpOnly`, `SameSite=lax`, and `Max-Age=0` / `Expires=Thu, 01 Jan 1970`.

### F-TEST-M2 [Major]
- Problem: Test `#1` must exercise production call path (RT5). `clearAuthSessionCookies` is module-private — exporting it breaks encapsulation. Test must go through `handlePageRoute`. Env stub timing matters (must be before module import OR via env at call time).
- Action: Specify: reuse "redirects /dashboard without session to signin" pattern. Stub `AUTH_URL` BEFORE `handlePageRoute`. Do NOT export `clearAuthSessionCookies`. Confirm `isSecureCookieFromAuthUrl()` reads env at call time.

### F-TEST-M3 [Major]
- Problem: C2 requires deletion to include `sameSite: "lax"` but only Secure is tested. Future regression flipping back to `strict` would pass.
- Action: Test must assert all three attributes on the deletion line.

### F-TEST-M4 [Major]
- Problem: No coverage for `useSecureCookies=false` branch. Hardcoded `secure: true` would pass HTTPS test but break dev logout.
- Action: Add parallel test for `AUTH_URL=http://localhost` asserting deletion line does NOT carry `Secure`.

### F-TEST-MIN1 [Minor — RT3]
- Problem: Test hardcoding `__Secure-authjs.session-token` is brittle to reorder.
- Action: Derive expected name via `getSessionCookieName(...)`.

### F-TEST-MIN2 [Minor]
- Problem: Manual step 5 verifies cookie removal but not Set-Cookie attribute on signout.
- Action: Add step 5b — inspect Response Headers in Network tab.

### F-TEST-MIN3 [Minor]
- Note: Standardize on `src/auth.config.test.ts`. Do not create new spec file. (Overlaps F-TEST-C1 and F-FUNC-03.)

## Adjacent Findings

- [Adjacent] Major (Testing → Security): GET-mutation CSRF surface deferred to follow-up. Acknowledged in plan; security expert reviewed and approved as pre-existing posture.

## Quality Warnings

None — all findings are concrete and actionable.

## Recurring Issue Check

### Functionality expert
- R29: Checked — citations accurate
- R37: central topic (C2)
- All others: N/A

### Security expert
- R12 (CSRF): central — GET-exempt by design verified
- R22 (cookie prefix invariants): C2 fix verified consistent
- R29: Verified RFC 6265bis §4.1.3.2 and RFC 6749 §3.1
- R37 (cookie attribute parity set vs delete): central topic
- RS1-RS4: N/A
- All others: N/A

### Testing expert
- RT1 (Mock-reality divergence): OK — plan does not mock Auth.js
- RT2 (Testability verification): OK — confirmed achievable
- RT3 (Shared constant in tests): FLAGGED in F-TEST-MIN1
- RT4 (Race-test vacuous-pass guard): N/A
- RT5 (Test call-path includes production primitive): FLAGGED in F-TEST-M1, F-TEST-M2
- R1-R37: N/A
