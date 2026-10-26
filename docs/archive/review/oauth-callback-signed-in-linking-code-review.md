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
