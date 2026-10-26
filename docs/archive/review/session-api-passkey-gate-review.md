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
