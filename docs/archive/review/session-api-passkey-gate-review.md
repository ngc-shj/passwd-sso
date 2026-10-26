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
