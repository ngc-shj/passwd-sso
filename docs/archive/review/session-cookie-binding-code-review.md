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
