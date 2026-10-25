# Code Review: session-cookie-binding
Date: 2026-10-25
Branch: `fix/session-cookie-name-binding`. It has no plan file: this is a security fix found while
planning `#956` (plan review round 2, finding S7). Before Phase 3, two review rounds were run
that did not follow triangulate (two reviewers, no recorded artifact). Their findings and fixes
are recorded in the commit messages of `9fe444a92`, `478511522` and `5114f00a9`.

## Review round 1 (Phase 3)
Seeds: local LLM pre-review found no issues. The seeds were 1 functionality Minor, no security
findings, and 3 testing Minors. All four seeds were rejected with reasons by the experts.

### Security Findings
- S1 Minor — `docs/operations/deployment.md` overstates what `__Host-` guarantees. A same-host app
  at another path can overwrite the cookie at `Path=/`.
- S2 Minor — the step-up freshness lookup is not bound to the userId `auth()` resolved, so the
  protection rests solely on the readers parsing cookies the way Auth.js does.

### Functionality Findings
- F1 Minor (R48) — the sign-in page decides "signed in" with `auth()` while the proxy decides with
  `readSessionCookie`. On a crafted header the two disagree and the browser loops between
  redirects.
- F2 Minor (R38) — a chunk-named or prefixed cookie that caused the refusal is not deleted on the
  redirect.
- F3 Minor (R1) — the DPoP E2E spec reimplements `injectSession`.
- F4 Minor (R3) — the load-test docs and config hardcode `__Secure-` for HTTPS.
- F5 Minor (R29) — the same issue as S1.
- [Adjacent] the load-test seeder stores raw session tokens in a column that holds the digest.
  Pre-existing.

### Testing Findings
- T1 Major (RT8) — the fail-closed cells do not assert that the fixture reached the path under
  test. The reader's refusal yields the same result, so those cells pass vacuously.
- T2 Major (RT5) — no test checks that the tokens the passkey route and Auth.js issue are read
  back by `readSessionCookie`.
- T3 Minor — the non-configured-cookie cell uses an out-of-alphabet value.
- T4 Minor — the differential test does not cover `hasAnySessionCookie`.
- T5 Minor (R53) — the new modules are not in the coverage include list or the per-file floors.
- T6 Minor — a comment splits `await` from its operand.
- T7 Minor (RT9) — the differential test reimplements the Auth.js request-to-`SessionStore`
  wiring.
- [Adjacent] passkey verify computes its cookie name at module load.

### Recurring Issue Check
- Security: R47/R48 parity verified; R3/R17/R42 readers complete; R29 citations verified except
  S1; R49 S1; RS1–RS6 clean or N/A.
- Functionality: R48 F1; R38 F2; R1 F3; R3 F4; R29 F5.
- Testing: RT5 T2; RT7 T3; RT8 T1; RT9 T7; RT10 T4; R53 T5; the rest clean.

### Decisions
- S2 is fixed in this PR, not deferred. The userId is passed into both step-up gates, so the
  compiler enumerates every call site.

### Resolution Status (round 1)
- T1 Major: the fail-closed cells assert that the fixture reached the code under test: cache
  lookup, fetch, tenant resolution, a digest lookup, the recover predicate. They share one
  UUID-shaped `TEST_SESSION_TOKEN`, and refused-side pairs were added. Red proof d2: a reader that
  refuses the shared UUID turns all 29 cells red.
- T2 Major: the passkey verify cell asserts the exact cookie name and that the issued value equals
  the stored `sessionToken`, read back as a token. Both are checked under http and under https
  with a basePath. `src/auth.ts` sets `generateSessionToken: () => crypto.randomUUID()`
  explicitly, which makes the format an owned contract and lets it be tested. Red proofs e1 and
  e2 (base64url generators).
- S2: both step-up gates take the `auth()` userId as a required argument and refuse a row owned
  by another user with 401. That touched 50 production call sites, and all of them already had
  the id. Red proofs a1 and a2.
- F1: the sign-in page asks the reader first and treats a refused header as signed out. Red proof
  b.
- F2: on an ambiguous refusal, the page route deletes the configured-prefix cookies, with the
  same attributes as before. Red proof c.
- F3: the DPoP spec calls `injectSession`. `injectSession` now sets `sameSite: "Lax"`, matching
  `auth.config.ts`. It used to say it matched production but set Strict.
- F4: the load-test docs and config list all three cookie names, and the seeder stores the
  digest through the production `hashSessionToken`.
- S1/F5: the deployment note is corrected. `__Host-` stops sibling subdomains and longer-path
  copies, but not same-host content.
- T3–T7: done. The differential now goes through Auth.js's own `toInternalRequest`, covers
  `hasAnySessionCookie`, and asserts all three arms. The coverage floors are set:
  `session-cookie.ts` 95/95, `auth-gate.ts` 95/92.
- Passkey verify reads the cookie name at call time, not at module load.

### Out of scope — load-test seeder inserts users without `tenant_id`
- **Anti-Deferral check**: out of scope (a different feature: load-test tooling, not the cookie
  reader).
- **Justification**: `users.tenant_id` is NOT NULL, so the seeder's insert fails, and it creates
  no membership. This predates the branch and is unrelated to how cookies are read. The fix needs
  tenant and membership seeding plus a smoke check, tracked in issue `#960`.
  - Worst case: load tests cannot be seeded.
  - Likelihood: certain whenever the seeder is used.
  - Cost to fix: moderate, and separate from this change.
- **Orchestrator sign-off**: filed as `#960`. This branch fixed the two cookie-related defects in
  the same file.

## Review round 2
Scope: `5114f00a9..HEAD` (f5bda5fa6).

### Changes from Previous Round
- Every round-1 finding was verified as resolved.
- S2 was checked by provenance at all 51 call sites. Every one passes the authenticated user, and
  the check also closes a Bearer-plus-another-user's-cookie case.
- No boundary was widened (R43).

### Findings
- **Security**
  - N1 Minor: the passkey reauth routes (options, verify) read the session row by cookie digest
    without binding `row.userId`.
- **Functionality**
  - FN-1 Minor: the cookie deletion omits `partitioned`.
  - FN-2 Minor: the step-up docs and the gate's remediation text show the old one-argument
    signature.
  - FN-3 Minor: the same issue as security N1.
  - FN-4 Minor: the seeder resolves the HMAC key only after it has started writing.
  - [Adjacent] passkey sign-in omits `partitioned`.
- **Testing**
  - N1 Minor: the step-up userId argument is pinned in 4 of 45 route tests.
  - N2 Minor: one auth-gate cell lacks a reach assertion.
  - N3 Minor: the differential feeds the two readers different bytes. This is a regression from
    the T7 change.
  - N4 Minor: the F2 deletion is untested under https with a basePath.
  - N5 Minor: `injectSession` omits `httpOnly`.

### Recurring Issue Check
- Security: R3/R17/R42 found two S2-class members left (N1). R43 none. RS clean.
- Functionality: R38 FN-1; R43 FN-3; R29/R3 FN-2.
- Testing: RT8 N2; RT9 N3; R53 N4 (adjacent). The rest are clean.

### Resolution Status (round 2)
- N1 / FN-3: the reauth options and verify routes select `userId`. A row owned by another user is
  refused with 401 before any audit, verifier call or challenge consumption. The verify write is
  `update({ where: { sessionToken, userId } })`. Red proofs a, b and b2. The integration test
  `reauth-credential-binding` still passes, but it exercises only the denial arms: the success
  path needs a validly signed assertion that tier cannot produce, so the compound `where` is pinned
  by the unit success cell and by the build, not by a real-DB write. (Corrected in round 3.)
- FN-1 + [Adjacent]: one call-time helper, `isSessionCookiePartitioned()`, used by `auth.config.ts`,
  passkey sign-in and the cookie deletion. Stray chunk names stay unpartitioned. Red proofs c and
  c2.
- FN-2: the step-up docs, the gate's remediation text and two gate self-test fixtures show
  `requireRecentCurrentAuthMethod(req, session.user.id)`.
- FN-4: the seeder validates the HMAC key before it writes anything.
- Test N1: seven routes that hold a target id pin the actor id passed to the gate. Red proof d.
- Test N2: the reach assertion is added.
- Test N3: the differential hands both readers the same normalized `Request` header. Run time is
  2.3 s. Red proof e reverts to the raw string and stays green, as expected; it is recorded, not
  claimed as a proof.
- Test N4: the https-with-basePath cells cover Secure, `Path=/passwd-sso/` and Partitioned on and
  off. `page-route.ts` is added to the coverage set at 93/79. Red proof f.
- Test N5: `injectSession` sets `httpOnly: true`.
- Not done: the [Adjacent] sign-in page message for an undeletable stray cookie. It is a UX item,
  outside the scope of a security fix.

## Review round 3
Scope: `f5bda5fa6..HEAD` (f86f33609).

### Changes from Previous Round
- Every round-2 finding was verified as resolved. The reauth 401 contract is unchanged: a row owned
  by another user takes the same arm as a missing row, and the client treats every non-ok response
  alike.

### Findings
- **Security**: no findings. Observation: the round-2 note claimed a real-Prisma pass for the reauth
  write, which the integration suite never reaches.
- **Functionality**
  - FN-5 Major (R38, introduced by the FN-1 fix): a CHIPS browser stores a partitioned and an
    unpartitioned cookie of the same name side by side and sends both, older first. With
    `COOKIE_PARTITIONED=true`, an unpartitioned one left by a flag flip or a pre-fix passkey sign-in
    is the one the reader takes. The refusal deleted only the partitioned variant — the valid new
    cookie — so the user looped through sign-in until the stale cookie expired. `ResponseCookies`
    keeps one entry per name and rewrites `Set-Cookie` on every write, including
    `applySecurityHeaders`' nonce cookie, so the second variant cannot go through it.
- **Testing**
  - M1 Minor: the `auth.config.ts` Partitioned cells use https only; a raw env check without the
    Secure condition passes both.
  - [Adjacent] Minor: the round-2 real-Prisma wording above.

### Resolution Status (round 3)
- FN-5: with the flag on, the configured name gets both deletions. The partitioned one stays in
  `response.cookies` (FN-1 preserved); the unpartitioned one is serialized by a throwaway
  `NextResponse` and appended after `applySecurityHeaders`. With the flag off there is exactly one
  unpartitioned deletion. The cells assert on the final response. Red proofs (scratch copy): drop
  the append; drop the partitioned flag; append before `applySecurityHeaders`; always emit the
  second variant — each reddens.
- M1: an http + `COOKIE_PARTITIONED=true` cell asserts no `partitioned`. Red proof: the raw env
  check in `auth.config.ts` reddens it.
- [Adjacent]: the round-2 note is corrected.

## Review round 4
Scope: `f86f33609..37eac16c5`.

### Findings
- **Security**: no findings. The raw line carries only env-derived name and path, and always
  `Secure` when emitted.
- **Functionality**
  - FN-6 Major (FN-5 reversed): after `COOKIE_PARTITIONED` goes true → false, the stale partitioned
    cookie is sent first and the refusal, gated on the current flag, deleted only the new
    unpartitioned one. The same loop.
  - FN-7 Minor: sign-in and sign-out touch only the current variant, so a user holding both pays
    one extra sign-in after a flip.
- **Testing**
  - T1 Minor: the only dual-deletion cell took the ambiguous path; the FN-5 case itself (a
    duplicated name, read as a token, rejected by the lookup) was untested.
  - T2 Minor: the file pinned `AUTH_URL` against the shell but not `COOKIE_PARTITIONED`.

### Resolution Status (round 4)
- FN-6: which variants a browser holds depends on every value the flag has had, so the configured
  name is now deleted both ways whenever the deployment is Secure (Partitioned cannot exist
  without it), regardless of the current flag. Over http there is one unpartitioned deletion. Red
  proofs (scratch copy): gating on the current flag; emitting both over http; dropping the append;
  dropping the partitioned flag — each reddens.
- T1: a cell with `NAME=A; NAME=B`, a failed lookup (`fetch` called once) and both flag values
  asserts two deletions, one partitioned, and no stray deletions. Red proof: gating the raw
  deletion on `extraNames.length` reddens it.
- T2: the top-level `beforeEach` pins `COOKIE_PARTITIONED` to empty.
- FN-7: not done, recorded as a known limitation. The suggested fix — the sign-in response also
  deleting the other variant — is unsafe: a browser without CHIPS ignores `Partitioned`, so the
  deletion and the new session cookie address the same cookie and the sign-in would delete the
  session it just set. The Auth.js sign-in and sign-out responses are not ours to change either.
  The proxy refusal converges after one extra sign-in, which is the cost.
