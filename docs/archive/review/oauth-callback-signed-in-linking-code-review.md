# Code Review: oauth-callback-signed-in-linking
Date: 2026-10-26

Issue `#966`, found as S9 in the `#959` plan review. Fix: the `[...nextauth]` route drops
session cookies from `/api/auth/callback/*` requests, so Auth.js never links an unlinked
provider account to whoever is signed in. While doing this, the callback and magic-link rate
limits turned out never to fire under a basePath, and that is fixed too.

## Round 1 (3a58b5ffc)

### Security
No Critical or Major findings. The class is closed for every path:
- the session reaches Auth.js only through the cookie header, through the prefix-matched
  `SessionStore`, and the strip set is a superset of it;
- only the `callback` action links.

Minor findings:
- S1: classification used `startsWith`, while Auth.js drops empty segments. `//callback` is
  only blocked today because Next answers it with a 308.
- S2: the previous session is no longer revoked on a re-sign-in.
- S3: the issue's acceptance test, run through real Auth.js, was missing.

### Functionality
No Critical or Major findings. Minor findings:
- F1 (= S2): left-over session rows count toward `maxConcurrentSessions` eviction, and the
  magic-link user-switch `deleteSession` was lost.
- F2: a basePath of `/api` defeats the strip-then-`startsWith` check.

### Testing
- F1 Major (= S3): the acceptance was proven only through mocked handlers. A real `@auth/core`
  test is feasible, following `auth.config.jackson-wire.test.ts`.
- F2 Major: no cell covered a non-chunk prefix key such as `authjs.session-tokenX`.
- F3–F6 Minor:
  - the legacy cookie literal;
  - the no-cookie path;
  - cookie-rebuild fidelity;
  - the exported-describe limiter reset and a basePath end-to-end cell.

## Resolution Status (round 1)
- **S1/F2:** `authPathReadings` parses the path as Auth.js does (non-empty segments), once as
  given and once with the basePath removed.
  - The callback check is `api/auth/callback/<provider>`.
  - The magic-link check is exactly `api/auth/signin/{nodemailer|email}` on POST.
  - The cells cover empty segments, a basePath of `/api`, and a trailing slash.
  - Residual: Auth.js's own base regex reads `/api/authcallback/x` as a callback. That path is
    unreachable, because Next routes only `/api/auth/*` to this handler.
- **S2/F1:** the wrapper remembers the token `readSessionCookie` resolved. When the response
  sets a new, non-empty configured session cookie, it calls the new
  `deleteSessionByToken`, which does `deleteMany` under `AUTH_SESSION_LIFECYCLE`, then evicts
  the cache. A failure is logged by error class only, and the sign-in still succeeds.
- **S3/testing F1:** `route.auth-core.test.ts` runs real `Auth()` with a fake adapter and a
  mocked OIDC IdP.
  - Through the wrapper, `getSessionAndUser` and `linkAccount(victim)` are never called.
  - An in-file control that calls `Auth` directly does link the victim.
- **Testing F2–F6:** fixed.
  - Prefix-suffixed keys are stripped.
  - Legacy literals, the no-cookie path, `=` and percent-encoded values byte-for-byte, a
    non-session header passed through unchanged, the limiter reset, and a basePath `route.GET`
    end-to-end cell are all covered.
- **Red proofs:** every rule was red-proved on scratch copies. Among them:
  - the strip removed from the exports;
  - non-basePath-aware checks;
  - exact or chunk-only key matching;
  - `startsWith` restored;
  - `=== 4` loosened to `>= 4`;
  - revocation removed;
  - try/catch removed;
  - the same-token and empty-value guards dropped;
  - any session name accepted;
  - the ambiguity rule bypassed;
  - the error added to the log;
  - the pass-through removed;
  - `delete` instead of `deleteMany`;
  - eviction before the delete;
  - the wrong grant.
  
  One cell was found to be vacuous: the non-segment basePath prefix case cannot become a
  callback. It was replaced by a cell for a path that arrives without its basePath.
- **Verification:** lint, full vitest (1093 files), and build all pass.

## Round 2 (65a1468b7)

### Security
S1–S3 are resolved. Neither round-1 fix widened a predicate:
- the pass-through header carries no key Auth.js's `SessionStore` would match;
- the magic-link check only limits more than round 1 did.

The revocation needs the raw token and a completed sign-in, and the magic-link login-CSRF
case matches upstream Auth.js's own user-switch `deleteSession`.

Minor finding:
- S2-R2-1: the replaced session still counts toward `maxConcurrentSessions`. The revocation
  ran after `createCappedSession`, so at the cap a re-sign-in evicted the oldest session,
  which can be another device's, and sent it a "terminated" notification. Upstream Auth.js
  created no extra row in that case.

### Functionality
- FN-R2-1 (= S2-R2-1), Minor.
- FN-R2-2, Minor, pre-existing: the adapter's `deleteSession` returned `void`.
  - Auth.js hands that value to `events.signOut`, which audits `AUTH_LOGOUT` only when the
    session carries its `userId`.
  - So sign-outs were never audited.

### Testing
- T1: no cell covered the https cookie names (`__Host-`, `__Secure-`).
- T2: the log cell was loose.
- T3: no simulation of P2025.

## Resolution Status (round 2)
- **S2-R2-1/FN-R2-1:** the revocation moved into the transaction that creates the new
  session.
  - **Route:** the wrapper no longer revokes after the response. It runs the handler under a
    copy of the session meta carrying `replacesSessionToken`, which is the token
    `readSessionCookie` resolved, or null.
  - **Adapter:** `createSession` passes it to `createCappedSession`.
  - **Delete:** `createSessionUnderConcurrencyCap` deletes that row by digest under the
    per-user advisory lock, before the cap counts. The row may belong to another user (a
    user switch) or already be gone.
  - **Cache:** the cache entry is evicted once the transaction commits.
  - **Consequences:**
    - The deletion happens only when a sign-in creates a session.
    - It commits atomically with the new session; a failed delete fails the sign-in instead
      of being logged away.
    - `deleteSessionByToken`, the Set-Cookie check, and the error log are gone.
- **FN-R2-2:** `deleteSession` selects `userId` and `expires` from the deleted row and returns
  `{ sessionToken, userId, expires }`. It still uses `delete`; Auth.js's signout catches a
  missing row as `SignOutError` and still clears the cookie.
- **T1:** cells for `__Host-` (https, no basePath) and `__Secure-` (https with a basePath),
  plus a negative cell. On https, a stripped `authjs.session-token` names no session.
- **T2/T3:** obsolete, because the log cell and `deleteSessionByToken` were removed. The
  in-transaction `deleteMany` cannot raise P2025.
- **Tests:**
  - `route.test.ts` uses the real `sessionMetaStorage` and asserts the meta the handler sees.
  - `route.auth-core.test.ts` records the `replacesSessionToken` its fake adapter's
    `createSession` reads under real `Auth()`.
  - The adapter cap cells use a stateful session fake. At a cap of 2, with the other device
    holding the oldest session, the other device survives. The control cell, with no replaced
    token, shows the oldest device evicted.
- **Red proofs:** six mutants, run on a scratch worktree with a green base (135); each turns
  at least one cell red:
  - pre-delete disabled;
  - adapter drops the field;
  - a hardcoded `authjs.session-token` reading;
  - route does not thread the token;
  - `deleteSession` returns nothing;
  - no cache eviction.
- **Verification:** lint, full vitest (1093 files), and build all pass.
