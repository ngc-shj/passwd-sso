# Plan: Restore session cookie `SameSite=Lax` to fix Google OAuth callback redirect bug

## Project context

- Type: web app
- Test infrastructure: unit + integration + CI/CD (vitest + Next.js build + GitHub Actions)

## Objective

Restore working Google (and SAML) OAuth sign-in. Currently the first request after a successful Google
callback lands on the sign-in page instead of the dashboard, requiring a manual page reload to enter
the authenticated UI. Fix the root cause (`sameSite: "strict"` on the Auth.js session cookie) and the
cookie-cleanup secondary defect that masks the primary bug.

## Requirements

### Functional

- After a successful OAuth (Google or SAML/Jackson) callback, the browser MUST land on the configured
  `callbackUrl` (default: `/dashboard`) and render the authenticated page on the first response —
  no reload required.
- Existing sessions issued with `SameSite=Strict` MUST continue to work (`Lax` is strictly more permissive
  for sending; no server-side validation changes).
- `clearAuthSessionCookies` in the proxy MUST actually delete the named cookies on the browser side,
  including `__Secure-` and `__Host-` prefixed cookies.

### Non-functional / security

- CSRF defense for mutating endpoints MUST remain in place. The proxy CSRF gate (`Origin` header check
  for cookie-bearing mutating requests, [src/lib/proxy/csrf-gate.ts](src/lib/proxy/csrf-gate.ts))
  already covers this — it is NOT dependent on `SameSite=Strict`.
- OAuth login-CSRF protection (forged sign-in to attacker's account) MUST remain in place via Auth.js's
  built-in `state` cookie + parameter validation — unaffected by this change.
- Magic-link token theft via cross-site GET MUST remain mitigated; the magic-link consumption is a GET
  to `/api/auth/callback/nodemailer` which carries the one-time token in the URL — `SameSite=Lax`
  sends the session cookie on top-level GET navigation as well, but the token's one-time-use property
  is what defeats interception, not the cookie's SameSite mode.

## Technical approach

Two changes in two files:

1. **Primary**: `src/auth.config.ts` — revert `sameSite: "strict"` → `"lax"` on the session-token cookie.
   Update the inline comment to describe the new (Auth.js-recommended) trade-off.
2. **Secondary**: `src/lib/proxy/page-route.ts` — make `clearAuthSessionCookies` emit `Set-Cookie`
   deletions with `secure: true` AND `httpOnly: true` AND `sameSite: "lax"` (matching the attributes
   the cookie was originally set with) so the browser will actually accept the deletion for
   `__Secure-` / `__Host-` prefixed names.

### Why both fixes ship together

The cookie-deletion defect currently MASKS the primary bug. Without it, the proxy's "clear session
on unauthenticated /dashboard hit" path would also wipe the just-issued OAuth session cookie, breaking
the manual-reload workaround that today gets users into the app. Shipping the SameSite fix alone
without fixing the cookie-deletion is fine in principle (the redirect chain is gone, so the clear
path is no longer reached on the OAuth flow), but the defect is real (logout cleanup, session-rotation,
etc. silently fail to clear `__Secure-` cookies) and is one line away from being correct in the same
diff.

**Note on path-policy consistency**: the passkey-verify route handler
([src/app/api/auth/passkey/verify/route.ts](src/app/api/auth/passkey/verify/route.ts)) already issues
its session-creation cookie with `SameSite=Lax` today. PR `#468` modified the Auth.js-driven sessionToken
in `auth.config.ts` only; it did not touch the passkey-verify path, which has continued to ship under
`SameSite=Lax` without incident. Reverting `auth.config.ts` to `Lax` restores cookie-policy parity
between the two session-creation paths.

### Why not implement a "session bridge" page

The bridge approach (OAuth callback → same-site intermediate page → JS redirect to final destination)
preserves `SameSite=Strict` but costs an extra round-trip and requires careful handling of
JavaScript-disabled fallbacks. The Auth.js documentation and reference implementations use
`SameSite=Lax`; the proxy already enforces baseline CSRF via Origin checking for mutating cookie-bearing
requests (`src/lib/proxy/csrf-gate.ts`). The added complexity of a bridge is not justified.

## Contracts

### C1 — Session cookie SameSite policy (locked)

- **Files**:
  - `src/auth.config.ts` — production code
  - `src/auth.config.test.ts` — existing test that asserts `sameSite === "strict"` (lines 61-66)
    MUST be updated to assert `"lax"`. The comment justifying the policy choice MUST also flip.
    A duplicate spec MUST NOT be created (do not add `src/lib/auth/session/auth-config-cookie.test.ts`).
- **Signature change**: in the `cookies.sessionToken.options` object, the `sameSite` property MUST
  read `"lax" as const`.
- **Forbidden patterns** (must NOT appear in the diff or final file):
  - `pattern: sameSite: "strict"` — reason: this is the bug being fixed; any reintroduction reverts the fix.
  - `pattern: sameSite: 'strict'` — reason: same as above with single-quote form.
  - `pattern: \.toBe\("strict"\)` in `src/auth.config.test.ts` on the sameSite test — reason: existing
    test that locks the bug; must be flipped to `.toBe("lax")` for the fix to ship.
- **Invariants**:
  - The cookie's `path`, `httpOnly`, `secure`, and `name` options MUST remain unchanged.
  - No other call site of `getSessionCookieName` or the proxy session-extraction must require updates —
    `SameSite` is a browser-side directive only.
  - Other Auth.js cookies (`authjs.state-token`, `authjs.pkce.code_verifier`, `authjs.callback-url`)
    retain Auth.js defaults (SameSite=Lax). Only `cookies.sessionToken` is overridden in this config;
    no new overrides are added.
- **Acceptance criteria**:
  - After re-deploying, signing in via Google from `https://accounts.google.com/...` lands on
    `/dashboard` (or the resolved `callbackUrl`) on the first server response, without manual reload.
  - The session cookie in browser devtools shows `SameSite=Lax`.
  - `src/auth.config.test.ts` test `"sets sameSite=lax on the session cookie"` passes.

### C2 — Cookie deletion matches set-time attributes (locked)

- **File**: `src/lib/proxy/page-route.ts`
- **Function signature**:
  ```ts
  function clearAuthSessionCookies(response: NextResponse, basePath: string = ""): void
  ```
  (unchanged signature; body changes only)
- **Body change**: `response.cookies.delete({ name, path: cookiePath })` MUST become
  `response.cookies.delete({ name, path: cookiePath, secure: useSecureCookies, httpOnly: true, sameSite: "lax" })`
  where `useSecureCookies` is sourced from `isSecureCookieFromAuthUrl()` (already exported from
  `@/lib/auth/session/cookie-name` — same module that exports the cookie-name selection helper).
  Do NOT duplicate the env-parsing logic; import the existing function. Verify usage by grep:
  `grep -n "isSecureCookieFromAuthUrl" src/auth.config.ts src/lib/auth/session/cookie-name.ts`.
- **Call-time evaluation invariant**: `isSecureCookieFromAuthUrl()` MUST be invoked at the point of
  deletion (inside `clearAuthSessionCookies`), NOT memoized at module scope. The helper is explicitly
  designed for call-time env read (see comment block in `cookie-name.ts:62-66`); module-scoping it would
  silently bypass test env stubs (see `cookie-name.ts:isSecureCookieFromAuthUrl` rationale comment).
- **Forbidden patterns**:
  - `pattern: response\.cookies\.delete\(\s*\{\s*name\s*,\s*path:\s*cookiePath\s*\}\s*\)` — reason:
    the bare-options form is the bug; deletion of `__Secure-*` cookies will be ignored by browsers.
  - `pattern: response\.cookies\.delete\(\s*\{\s*name\s*,\s*path:\s*cookiePath\s*,\s*secure:\s*useSecureCookies\s*\}\s*\)` —
    reason: secure-only form drops the `httpOnly` and `sameSite` mirror; the contract requires the full
    four-attribute set.
- **Invariants**:
  - The `cookiePath` derivation (`${basePath}/`) MUST remain unchanged — this matches the set-time path.
  - `ALL_KNOWN_SESSION_COOKIE_NAMES` enumeration MUST remain the source of cookie names; do not inline.
- **Acceptance criteria**:
  - After this fix, a request that goes through `clearAuthSessionCookies` against a browser holding
    `__Secure-authjs.session-token` actually removes the cookie (verifiable via devtools Network tab:
    response `Set-Cookie` line includes `Secure`).

### Consumer-flow walkthrough

Neither contract defines an API response shape, persisted-state shape, or message payload consumed
by other code. Both contracts modify framework-level Set-Cookie behavior — consumed only by the browser.
No consumer walkthrough is applicable.

## Testing strategy

### Automated

1. **Unit test (new, HTTPS branch)** in `src/lib/proxy/page-route.test.ts` — extend the existing
   "redirects /dashboard without session to signin with callbackUrl" pattern (line 113). The new test
   MUST go through `handlePageRoute` — `clearAuthSessionCookies` is module-private (intentional)
   and MUST NOT be exported. Required scaffolding:
   - `vi.stubEnv("AUTH_URL", "https://example.com")` and `vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso")`
     BEFORE invoking `handlePageRoute` (the new code reads `isSecureCookieFromAuthUrl()` at call time,
     so post-import stubs are honored — confirmed in `cookie-name.ts:62-66`).
   - Assertion shape (anchored to a specific cookie line, distinguishes set-vs-delete, fails if any one
     of the four attributes is dropped):
     ```ts
     const headers = response.headers.getSetCookie();
     const expectedName = getSessionCookieName({ useSecureCookies: true, basePath: "/passwd-sso" });
     const line = headers.find((h) => h.startsWith(`${expectedName}=`));
     expect(line).toBeDefined();
     expect(line).toMatch(/;\s*Secure/i);
     expect(line).toMatch(/;\s*HttpOnly/i);
     expect(line).toMatch(/;\s*SameSite=lax/i);
     expect(line).toMatch(/Max-Age=0|Expires=Thu,\s*01\s*Jan\s*1970/i);
     ```
   - Loop the line-find over all 5 entries of `ALL_KNOWN_SESSION_COOKIE_NAMES`; assert exactly 5 set-cookie
     entries are emitted and every `__Secure-` / `__Host-` prefixed one carries `Secure`.

2. **Unit test (new, dev/HTTP branch)** in the same file — `it("does NOT add Secure to deletion when AUTH_URL is http", ...)`:
   - `vi.stubEnv("AUTH_URL", "http://localhost:3000")` and `vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "")`
   - Assert the deletion line for `authjs.session-token` (the plain, unprefixed name selected when
     `useSecureCookies=false`) does NOT carry `Secure`: `expect(line).not.toMatch(/;\s*Secure/i)`.
   - This proves the `useSecureCookies` plumbing is live and not hardcoded — a `secure: true` typo
     trips this case.

3. **Unit test (existing file, modified)** in `src/auth.config.test.ts:61-66` — flip the existing
   `"sets sameSite=strict on the session cookie"` test:
   - Rename to `"sets sameSite=lax on the session cookie"`.
   - Flip `.toBe("strict")` → `.toBe("lax")`.
   - Update the inline comment justifying the policy choice (currently lines 61-62) to reference the
     OAuth-callback-redirect bug rationale.
   - Do NOT create a new spec file. The existing `describe("auth.config session cookie attributes")`
     block is the canonical location.

4. **Unit test (existing, regression)**: re-run the full `src/lib/proxy/page-route.test.ts`,
   `src/__tests__/proxy.test.ts`, and `src/auth.config.test.ts` suites to confirm no other test
   asserts the old `strict` policy and that the proxy redirect cases still pass.

5. **Existing snapshot of cookie name selection**: no change. `getSessionCookieName` and
   `ALL_KNOWN_SESSION_COOKIE_NAMES` tests in `src/lib/auth/session/cookie-name.test.ts` remain green —
   SameSite is not part of that helper.

### Manual (operator)

Documented in a sibling manual-test file (`restore-session-cookie-samesite-manual-test.md`,
created at Phase 2):

- Pre-condition: production-shape deployment (`AUTH_URL=https://...`, basePath = `/passwd-sso`).
- Step 1: Open an incognito window, navigate to `/passwd-sso/ja/auth/signin`, click "Sign in with Google".
- Step 2: Complete Google consent.
- Step 3: Confirm the address bar shows `/passwd-sso/ja/dashboard` (NOT `/passwd-sso/ja/auth/signin?...`)
  and the passphrase prompt renders WITHOUT manual reload.
- Step 4: In devtools Application → Cookies, confirm `__Secure-authjs.session-token` carries `SameSite=Lax`.
- Step 5: Click "Sign out". Confirm the cookie is removed from devtools (not just emptied).
- Step 5b: In devtools Network tab, click the signout request, then Response Headers. Confirm a
  `Set-Cookie: __Secure-authjs.session-token=; Path=/passwd-sso/; Secure; HttpOnly; SameSite=lax; Max-Age=0`
  line is present (or equivalent `Expires=Thu, 01 Jan 1970 ...`). This verifies the C2 fix is wired
  end-to-end.

### Out of scope

- Full E2E test of the OAuth redirect chain — Playwright cannot reliably exercise a real Google OAuth
  flow without test-only credentials and a domain restriction relaxation that we will not introduce
  for one bug fix. The manual test in this plan covers the user-facing acceptance criterion.

## Considerations & constraints

### Known risks

- **CSRF surface change** for state-mutating GET endpoints. Under `SameSite=Strict` the session cookie
  is suppressed on cross-site top-level navigations; under `Lax` it rides on top-level GET (`<a>` clicks,
  `window.location`). The proxy's CSRF gate ([src/lib/proxy/csrf-gate.ts](src/lib/proxy/csrf-gate.ts))
  only enforces `Origin` on POST/PUT/DELETE/PATCH — GET is unprotected.
  - **Audit run on this worktree** — `grep -rlE "^export async function GET\b" src/app/api/`
    intersected with `prisma\.[a-zA-Z]+\.(create|update|delete|upsert|deleteMany|updateMany)` returns
    ~30 route files, but most of those are co-located GET+POST files where the mutation lives in the
    POST handler, not the GET handler. The notable GET-with-side-effect handlers are:
    - `src/app/api/mobile/authorize/route.ts` — issues a one-time bridge code; bound to PKCE +
      device-pubkey supplied by the iOS host app. Attacker cannot fabricate a valid handshake without
      controlling the iOS app, but a click-jack could create a bridge code redeemable by an attacker-
      registered device. **Existing mitigation**: `requireRecentSession` step-up. **Severity under Lax**:
      Major surface increase that pre-existed PR `#468` — the iOS pairing flow was already shipped under
      `SameSite=Lax` before PR `#468` and has not had a reported incident.
    - `src/app/api/mcp/authorize/route.ts` — OAuth 2.1 authorization endpoint. Per RFC 6749 §3.1, the
      authorization endpoint MUST accept GET. Defense relies on PKCE + the consent step.
  - **Pre-existing posture**: every GET-mutation surface enumerated above shipped in production for the
    entire lifetime of this project until PR `#468` (May 16, 2026, three days ago) tightened cookies to
    `Strict`. Reverting to `Lax` restores the pre-existing posture; we are not introducing a new
    surface, we are restoring a state that ran without incident.
  - **Out-of-scope follow-up**: a dedicated audit converting GET-mutation handlers to require a CSRF
    token (URL param, double-submit pattern) is appropriate as separate work. Tracked as a Minor in
    Considerations rather than blocking this fix.
- **Browser support**: `SameSite=Lax` is the default behavior in modern browsers for cookies without
  an explicit `SameSite` attribute, so no browser compatibility concerns.

### Out of scope

- Bridge-page architecture (rejected above).
- General audit of all `cookies.delete` call sites across the codebase — survey on this worktree
  (`grep -rn "cookies\.delete" src/`) found only one site: `src/lib/proxy/page-route.ts:125`.
  Auth.js's own sign-out cookie cleanup goes through its internal route handler, not this code path.
  So C2 covers the full project surface.
- Rotating the existing cookies in user browsers — they will be replaced on the next sign-in.
- Mutating-GET endpoint CSRF hardening (URL-bound token / Origin-via-Sec-Fetch-Site / convert to POST).
  Pre-existing surface that PR `#468` attempted to mitigate as a side effect via `Strict`. Restoring
  `Lax` returns the surface to its pre-PR-#468 state. Follow-up tracked as a separate Minor.

## User operation scenarios

1. **Google sign-in from incognito** — typical onboarding flow. With fix: lands on dashboard on first
   server response. Without fix: lands on `signin?callbackUrl=...`; reload required.
2. **Sign in, then click an external link from a partner site back to `/passwd-sso/ja/dashboard`** —
   with `SameSite=Lax`, the session cookie is sent on top-level GET navigation, so the user lands on
   the dashboard directly (a UX improvement over `Strict`).
3. **CSRF attempt**: attacker hosts a page with `<form action="https://www.example.jp/passwd-sso/api/passwords"
   method="POST">`. Cookie IS sent under `Lax` only for top-level GET; POST does not send the cookie
   cross-site under Lax. Additionally, the proxy CSRF gate rejects mismatched-Origin POSTs. No regression.
4. **Sign out**: the proxy's `clearAuthSessionCookies` path now correctly deletes the
   `__Secure-authjs.session-token` cookie. Previously deletion was silently rejected by the browser
   due to the missing `Secure` attribute.

## Go/No-Go Gate

| ID  | Subject                                              | Status |
|-----|------------------------------------------------------|--------|
| C1  | Session cookie SameSite policy (`strict` → `lax`)    | locked |
| C2  | Cookie deletion matches set-time attributes (Secure) | locked |
