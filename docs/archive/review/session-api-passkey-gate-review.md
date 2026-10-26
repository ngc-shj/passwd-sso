# Plan Review: session-api-passkey-gate
Date: 2026-10-26

## Round 1 (plan revision 1)

### Functionality
- F1 Critical: the root `VaultProvider` fetches `/api/vault/status` on every page. On the minimal
  screen the `fetchApi` reaction then reload-loops, and it also bounces every non-dashboard page.
- F2 Major: a credential registered while locked stores `prfSupported=false`, so PRF
  re-bootstrap is never offered.
- F3 Major: the shared card's unconditional `hardNavigate` locks the vault for ordinary users.
- F4 Major: running the exempt check before `getSessionInfo` drops the 401 and the IP
  restriction; the own-gate routes are not in the predicate.
- F5 Major: the page proxy (cached) and the layout (fresh `auth()`) disagree;
  `register/verify` has no token, so it should bulk-invalidate the user's sessions.
- F6 Major: the exempt set and the scenarios do not match the screen's real consumers
  (`passkey-status` is unused; self-revocation has no UI).
- F7 Minor: the audit dedup keys on raw API paths that carry IDs.
- F8 Minor: the policy doc row is incomplete and its banner claim stale.

### Security
- S1 Major: same as F4. A stolen cookie from outside the network boundary could register a
  passkey or revoke sessions and tokens.
- S2 Major: registration needs only the first factor, so a stolen post-grace cookie clears the
  gate and gains a durable credential. Apply `requireRecentSession`.
- S3 Major: same as F1.
- S4 Minor: the `/api/auth/` prefix covers reauth and future routes; enumerate exact paths.
- S5 Minor: the per-ID revocations are unreachable, and the extension entries are Bearer-only.
- S6 Minor: the audit-emit self-fetch is suppressible (limiter, raw-path cardinality, 4 KB cap);
  emit directly.
- S7 Minor: `openapi.json` accepts a session past the API_V1 early return; the class has no slot
  for skipped kinds.
- S8 Minor: a positive-cached fail-closed bundle blocks every tenant for 30 s.
- Adj1 Minor: `audit-emit` accepts forged blocked rows from any session (it predates this plan).

### Testing
- T1 Critical: the table's oracle is the predicate itself, so two claimed red proofs cannot go
  red.
- T2 Critical: a bare 403 is satisfied by CSRF `INVALID_ORIGIN` or IP `ACCESS_DENIED`.
- T3 Major: the table has no slot for early-return kinds, OPTIONS, or the cookie+Bearer and
  Bearer-only columns.
- T4 Major: the I2 vault denylist contradicts the delegation exemption.
- T5 Major: the existing tests that flip or go vacuous are not listed; cache-hit fixtures fail
  open.
- T6 Major: the fetch spy shares one `Response` and receives `URL` objects; the dedup map is not
  reset.
- T7 Major: the CI e2e job lacks `WEBAUTHN_RP_ID`.
- T8 Major: the E2E helpers are hard-coded to one tenant, and a retry runs on registered state.
- T9 Major: the integration cell cannot drive the real `getSessionInfo`.
- T10 Major: the red-proof list misses most of the new controls.
- T11–T14 Minor: fake timers; predicate spelling cells; unmapped acceptance cells; a real
  `getSessionInfo` in the table.
- T15 Major [Adjacent]: same as F4/S1.

### Revision 2
- C1:
  - two-tier exemption: Tier A is pre-session, with enumerated exact Auth.js paths and
    audit-emit; Tier B is passkey-only, after the 401 and IP checks;
  - per-ID and extension entries dropped, along with `passkey-status`;
  - `openapi.json` is an own-gate route;
  - the fail-closed bundle is cached for 5 s.
- D4: the gate emits audit directly, with bounded metadata and dedup key.
- D5: enrollment requires a recent sign-in while blocked.
- C2:
  - `VaultProvider` skips the status fetch when blocked;
  - the `fetchApi` reaction applies only under `/dashboard`, never on the passkey page, and
    never throws;
  - an `onRegistered` callback replaces the card's navigation;
  - the PRF capability is stored without the wrap;
  - registration bulk-invalidates the user's sessions.
- Testing:
  - the manifest-declared `sessionPasskeyGate` oracle, with columns and literal snapshots;
  - body assertions;
  - URL-dispatch fetch;
  - the inventory of existing tests that change;
  - E2E environment and helper changes;
  - the integration restatement;
  - the full red-proof list.

## Recurring Issue Check (round 1)
- **Functionality:** R13 F1; R22 F3; R29 F8; R41 F2, F6; R42 F1; R43 F4; R48 F5; R49 F7; R3
  checked; R25 checked.
- **Security:** R42 S1, S5, S7; R3 S3; R29 S6; RS1 N/A; RS2 OK; RS3 N/A; RS4 OK; RS5 N/A;
  RS6 N/A.
- **Testing:** RT1 T5, T6; RT2 checked; RT3 partial; RT4 N/A; RT5 T9, T14; RT6 OK; RT7 T1, T10;
  RT8 T2; RT9 not observed; RT10 T12, T2; RT11 T8.

## Round 2 (plan revision 2)

### Functionality (N1–N2 Major, N3–N8 Minor)
- F1–F8 resolved. D5 is feasible: the step-up dialog signs out first, so "sign in again" creates
  a fresh session row. D4 is feasible: the proxy graph already reaches `logAuditAsync`.
- N1 Major: VaultProvider's distinct blocked state.
  - VaultGate falls through on an unknown status and renders the full dashboard.
  - Auto-lock stops when a user is blocked while unlocked.
  - The verdict uses the client clock.

  Fix: keep `VaultStatus`, and suppress only the status fetch by a server-rendered marker.
- N2 Major: the 5 s TTL covers only the missing-field substitution. The `auth.ts` catch bundle
  from a transient fault is still cached for 30 s.
- Minor:
  - N3: `requireRecentSession` in register trips the step-up client-coverage gate.
  - N4: `/admin` is not covered.
  - N5: the PRF capability signal is unnamed, and the re-bootstrap copy claims a key rotation.
  - N6: the invalidation helper is misnamed, and its cross-tenant scope unstated.
  - N7: the audit metadata diverges from `{ blockedPath }`.
  - N8: the Tier A Auth.js methods are not enumerated.

### Security (S9 Major, S10–S13 Minor)
- S1, S3, S4, S5 and S7 resolved.
- S9 Major: a `callback/*` request carrying a signed-in cookie links an unlinked OAuth identity
  to the current user (Auth.js `handleLoginOrRegister` signed-in linking). Holding a stolen
  blocked cookie, an attacker links their own Google account, signs in fresh (which satisfies
  D5), and registers a passkey. Independently of this plan, a stolen cookie can thereby become
  a durable login.
- S10 Minor: same as N2.
- S11 Minor: `routeKey` is attacker-controlled; take it from a closed set.
- S12 Minor: on API_DEFAULT, an ambiguous or chunked cookie gives `valid:false` and passes
  through, while the route's `auth()` still authenticates.
- S13 Minor: the handler scan should match by import binding.

### Testing (T16–T24 Major, T25–T29 Minor)
- T16: own-gate has no proxy-observable outcome.
- T17: the `[...nextauth]` catch-all row cannot express the Tier A sub-paths.
- T18: the existing parity assertion does not force the new field.
- T19: the handler scan should be AST with import binding.
- T20: same as N2.
- T21: the E2E audit delta is suppressed on retry.
- T22: the E2E "no 403" check has no positive control.
- T23: the local RP ID and the authenticator's PRF option are missing.
- T24: red proofs are still missing.
- T25–T29: smaller harness details.

### User decision
S9 is fixed first, in its own PR. This plan continues after it lands, with S9's fix as a
precondition of D5.

## Recurring Issue Check (round 2)
- **Functionality:** R13 N1; R3 N1; R22 N5; R29 N6; R41 N4, N5; R42 N3; R43 N8; R48 N2, N6;
  R49 N7; R25 checked.
- **Security:** R42 S13; R43 no widening; R3 S9; RS1 N/A; RS2 OK; RS3 S11; RS4 OK; RS5 N/A;
  RS6 N/A.
- **Testing:** RT1 T25, T27; RT2 OK; RT3 T18, T19; RT5 T20, T25, T29; RT7 T24; RT8 T16;
  RT9 T21; RT10 T17, T26; RT11 T21, T28.

### Revision 3
- **Precondition:** S9 is fixed by `#966` (merged), which is a precondition of D5.
- **N1 → D6:**
  - The session callback adds a server-computed `passkeyBlocked`.
  - `VaultProvider` keeps `VaultStatus` and only skips the initial status fetch, leaving any
    unlocked state and auto-lock untouched.
  - The client never re-derives the verdict (I5).
- **N2/S10/T20:** the `auth.ts` catch bundle carries `passkeyStateDegraded`. `getSessionInfo`
  caches both a substituted bundle and a marked one for 5 s.
- **N3:** `@stepup` markers on both register routes and the card's two calls, through
  `handleStepUpError`.
- **N4:** the admin layout redirects blocked sessions; the `fetchApi` reaction also covers
  `/admin`.
- **N5:** the client sends `prfCapable` (from `getClientExtensionResults().prf?.enabled`), and
  `prfSupported = hasWrap || prfCapable`. The offer copy no longer claims a key rotation.
- **N6:** a new cross-tenant `invalidateUserSessionsCache(userId)` with its own grant.
- **N7/S11:**
  - The metadata is `{ blockedPath: "<METHOD> /api/<routeKey>" }`.
  - `routeKey` comes from a closed set pinned to `src/app/api/`; anything else becomes `other`.
- **N8/T17:** Tier A enumerates Auth.js actions with their methods. `signin/<id>` and
  `callback/<id>` match exactly one segment, and catch-all routes declare `concretePaths`.
- **S12:** an ambiguous or chunked session cookie on API_DEFAULT gets 401.
- **S13/T19:** the handler scan is an AST scan with import binding and a reader set defined by
  module.
- **T16:** the own-gate step is explicit in the C1 order. Each manifest value maps to a
  (response, session fetch) outcome. `bridge-code` and `openapi.json` are early returns.
- **T18:** a new parity assertion for `sessionPasskeyGate`.
- **T21–T23:** E2E obligations instead of harness specifics:
  - one RP ID source;
  - a PRF-capable authenticator;
  - a user per attempt;
  - polling;
  - a positive control before the no-403 assertion.
- **T24:** red-proof list completed, each naming its expected red cell.
- **T25–T29:** recorded as Phase 2 harness obligations.

## Round 3 (plan revision 3)

### Functionality (N-R3-1, N-R3-2 Major; N-R3-3–N-R3-8 Minor)
- N1–N8 are resolved in design. `useSession` receives `passkeyBlocked` and refetches on every
  navigation.
- N-R3-1 Major: the degraded bundle blocks every tenant.
  - It now produces API `PASSKEY_REQUIRED`, mass vault locks, false audit rows, and the minimal
    screen for tenants that never required a passkey.
- N-R3-2 Major: the API audit dedup is a 1000-entry per-process map.
  - About 240 keys per user thrash it, so refusals write a durable row per request.
- Minor:
  - N-R3-3: the `VaultProvider` effect re-runs on every session update, `LOADING` arms the
    timers, and the pollers keep hitting gated routes.
  - N-R3-4: the reaction's path-based exclusion meets a dashboard layout that persists across
    soft navigation.
  - N-R3-5: the S12 401 precedes own-gate, which breaks `mobile/authorize`'s redirect.
  - N-R3-6: `prfCapable` duplicates `clientExtensionResults.prf`.
  - N-R3-7: the handler scan contradicts reauth being gated.
  - N-R3-8: a transient `valid:false` on API_DEFAULT still passes through.

### Security (S-R3-1, S-R3-2 Minor)
- S9–S13 are resolved.
- Rev-3 additions checked:
  - `POST session` in Tier A is equivalent to GET: CSRF-checked, and the callback ignores
    `newSession`.
  - `signin/<id>` is safe.
  - `prfCapable` has no security consumer.
  - The new grant only narrows.
  - R43: nothing widened beyond `prfSupported`.
- S-R3-1: a non-definitive `valid:false` on API_DEFAULT bypasses the gate for the gated session
  readers (reauth). I1 overclaims.
- S-R3-2: deleting a credential does not invalidate the cache, so the gates fail open for up to
  30 s.

### Testing (T-R3-1–T-R3-6 Major; T-R3-7–T-R3-10 Minor)
- T16–T29 are resolved or correctly deferred.
- Major:
  - T-R3-1: own-gate is unpinned and indistinguishable from `tier-b`.
  - T-R3-2: the scan rule fails on HEAD for reauth.
  - T-R3-3: the `auth.ts` producer of `passkeyBlocked` and the marker is untested.
  - T-R3-4: the E2E audit delta cannot tell the API gate from the page proxy.
  - T-R3-5: the `prfCapable` chain is tested only at its ends.
  - T-R3-6: the S12 cell cannot tell "ambiguous" from "any invalid".
- Minor:
  - T-R3-7: I5 has no distinguishing fixture.
  - T-R3-8: catch-all per-method semantics.
  - T-R3-9: the invalidation cell sits in a single tenant.
  - T-R3-10: no direct test that the next API call is allowed.

### Revision 4
- **N-R3-1 → D7:**
  - a degraded bundle sets `passkeyBlocked: false` plus `passkeyStateDegraded`, carried through
    `SessionInfo` and the session type;
  - the gate answers 503 with no audit;
  - the layouts show a retry state;
  - the reaction ignores 503;
  - the page proxy writes no row for it.
- **N-R3-2:** the audit write is bounded by a Redis limiter
  (`rl:passkey_session_gate_audit:<userId>:<blockedPath>`); methods come from a closed set.
- **N-R3-8/S-R3-1/S12/N-R3-5/T-R3-6:**
  - `getSessionInfo` returns an invalid reason (`none` / `ambiguous` / `transient`).
  - On API_DEFAULT:
    - own-gate passes;
    - only a definitive `none` passes through;
    - `ambiguous` gets 401 and `transient` gets 503.
  - This closes the class at the root, so reauth stays `gated` (resolving the S-R3-1 / T-R3-2
    tension without moving reauth to own-gate).
  - A control cell covers `none`.
- **T-R3-1:**
  - the own-gate set is in the I2 snapshot under the denylist;
  - each own-gate route must call the adjudicator (AST, import-bound);
  - a red proof adds a vault route to own-gate.
- **T-R3-2/N-R3-7:** the scan covers readers declared `tier-a` / `early-return` only, through a
  literal reader-exemption list or a route-level adjudicator.
- **N-R3-3:**
  - the `VaultProvider` condition applies on every run;
  - `LOADING` moves to `LOCKED`;
  - the team and emergency-access pollers suspend while blocked.
- **N-R3-4:** the reaction's exclusion is the screen-mounted flag.
- **N-R3-6/T-R3-5:** the PRF capability is derived server-side from `clientExtensionResults.prf`,
  with no new body field. E2E asserts the re-bootstrap offer.
- **S-R3-2:** the credential DELETE invalidates too, and the `hasPasskey` writers are listed.
- **T-R3-3:** `auth.ts` producer cells.
- **T-R3-4:** the E2E audit matches `blockedPath`.
- **T-R3-7:** the verdict fixture disagrees with the raw fields.
- **T-R3-8:** catch-all routes are evaluated through `concretePaths` only.
- **T-R3-9:** two tenants.
- **T-R3-10:** E2E checks `/api/passwords` → 200.
- **Citation:** issue `#966`, PR `#967`.

## Recurring Issue Check (round 3)
- **Functionality:** R3 N-R3-3; R13 N-R3-1; R43 N-R3-5; R48 N-R3-6; R49 N-R3-2;
  R42 N-R3-7.
- **Security:** R42 S-R3-1, S-R3-2; R43 `prfSupported` only (no security consumer);
  RS2 OK; RS3 OK.
- **Testing:** RT2 T-R3-6, T-R3-7; RT3 T-R3-1, T-R3-2; RT5 T-R3-3, T-R3-5;
  RT8 T-R3-1, T-R3-4; RT10 T-R3-8.

## Round 4 (plan revision 4)

### Functionality (N-R4-1 Major; N-R4-2–N-R4-6 Minor)
- N-R3-1–N-R3-7 are resolved; N-R3-8 is not.
- N-R4-1 Major: `none` cannot be observed. With the database strategy, Auth.js answers a
  swallowed adapter fault with 200-`null`, the same as a dead token, and the negative cache
  stores no reason. So a transient fault still passes through to reauth's `auth()`.
- Minor:
  - N-R4-2: the deactivated member, the `resolveUserTenantId` throw, the outer catch and a
    missing `userId` are unclassified.
  - N-R4-3: the page proxy still redirects degraded sessions to the passkey page.
  - N-R4-4: D5's input is unpinned once D7 sets `passkeyBlocked:false`.
  - N-R4-5: the pollers' predicate differs from `VaultProvider`'s.
  - N-R4-6: after registration the client session is not refreshed.

### Security (S-R4-1, S-R4-2 Minor)
- S-R3-2 is resolved, and the `hasPasskey` writer set is complete.
- S-R4-1 (= N-R4-1): the reason split is unobservable.
- S-R4-2 (= N-R4-4): `passkeyBlocked:false` on a degraded bundle is fail-open in shape for any
  server consumer; D5 must not read it.
- Checked:
  - the degraded state cannot be used to escape the requirement;
  - every own-gate route re-adjudicates;
  - the Redis bound is correct per the refusal-arm rule;
  - PRF has no security consumer.

### Testing (T-R4-1–T-R4-4 Major; T-R4-5–T-R4-7 Minor)
- Major:
  - T-R4-1: about 9 `valid:false` sources against 3 reason cells; the deactivated member and the
    negative cache are unspecified.
  - T-R4-2: the degraded flag is tested only at its ends, through the fetch path and the
    stripping `SessionInfoSchema`.
  - T-R4-3: the Redis bound cannot be told from the in-memory fallback within a single process.
  - T-R4-4: page-proxy degraded and `VaultProvider` degraded have no cells.
- Minor:
  - T-R4-5: a stale path-based `fetchApi` cell.
  - T-R4-6: the own-gate AST predicate accepts `derivePasskeyState` alone and has no red proof.
  - T-R4-7: the own-gate pass cell is satisfiable only on `mobile/authorize`.

### Revision 5
- **N-R4-1/S-R4-1/N-R4-2/T-R4-1:** the invalid-reason split is dropped.
  - On API_DEFAULT, the rule keys on whether the route reads the session.
  - A literal `API_DEFAULT_SESSION_READERS` list (today the two reauth routes) refuses every
    invalid session with 401; every other API_DEFAULT route passes through.
  - The handler scan pins the list to exactly the API_DEFAULT readers that are neither Tier A
    nor own-gate.
  - One cell per `valid:false` source on a reader, plus a stale-cookie control on a non-reader.
- **S-R4-2/N-R4-4:**
  - `passkeyBlocked` is display-only.
  - Server decisions use the raw fields or `derivePasskeyState`.
  - New cell: degraded plus a stale sign-in gives `SESSION_STEP_UP_REQUIRED`.
- **N-R4-3:** the page proxy passes degraded navigations through to the layouts' retry state.
- **N-R4-5:** the pollers use blocked-or-degraded.
- **N-R4-6:** `onRegistered` awaits `update()`, then `hardNavigate`.
- **T-R4-2:** the degraded flag is tested end to end through the real `getSessionInfo` and
  `SessionInfoSchema`.
- **T-R4-3:** a real-Redis cell with two gate instances and one row.
- **T-R4-4:** page-proxy and `VaultProvider` degraded cells.
- **T-R4-5:** the flag-based `fetchApi` cells.
- **T-R4-6:** own-gate requires a `passkeyEnforcementBlocks` call; red proofs remove or alias it.
- **T-R4-7:** `mobile/authorize` passes and `mcp/authorize` gives 401.

## Recurring Issue Check (round 4)
- **Functionality:** R13 N-R4-3; R43 N-R4-4; R3 N-R4-5; R48 N-R4-1.
- **Security:** R43 own-gate ambiguous pass (covered) and Tier B while degraded (S-R4-2);
  RS2 OK.
- **Testing:** RT2 T-R4-5; RT5 T-R4-2, T-R4-3; RT7 T-R4-6; RT8 T-R4-1.
