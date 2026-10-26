# Code Review: session-api-passkey-gate
Date: 2026-10-27
Review round: 2

## Changes from Previous Round
Initial review, on top of the Phase 2 self-R-check (fixed in 32b8e376f).

## Functionality Findings
- **FN-1 Major: the card counts "PRF passkeys" by `prfSupported` alone.**
  - Where: `passkey-credentials-card.tsx` (`prfCount`, `lastPrfDeleteWarning`, `deleteConfirmPrf`).
  - This branch widened `prfSupported` to mean "PRF-capable". With one wrapped and one unwrapped
    passkey, deleting the wrapped one shows no "last PRF passkey" warning.
  - Fix: use the unlock predicate `prfSupported && prfWrappingPresent`.
- **FN-2 Minor: deleting the last passkey past grace forces a full sign-out to re-register.**
  - `authCredentialId` is `SetNull`, so D5 recency is permanently stale for that session.
  - Fix: refuse the delete, with its own error code.
- **FN-3 Minor:** `page-route.ts` re-implements `passkeyEnforcementBlocks` inline.
- **FN-4 Minor:** the policy-doc rows for the grace fields omit the API gate and the layouts.
- **FN-5 Minor:** the autofill-token comment "outcomes match" overstates. A blocked `api_` key
  went from 403 to 401, which is harmless.

## Security Findings
- **SEC-1 Major (pre-existing, in a changed file):** passkey enrollment needs only the session
  cookie whenever the session is not blocked. A stolen cookie could mint a durable credential.
  Credential delete already requires `requireRecentCurrentAuthMethod`.
- **SEC-2 Minor (pre-existing):** page-navigation `PASSKEY_ENFORCEMENT_BLOCKED` rows carry the raw,
  caller-chosen path. Fix: a closed set.
- **SEC-3 Minor:** the policy doc says a stolen post-grace cookie cannot clear the gate. That holds
  only for cookies older than `STEP_UP_WINDOW_MS`.
- **Checked closed:**
  - Tier A/B spellings, HEAD, OPTIONS, and cookie tricks;
  - indirect session readers (the wrapper floor is complete today);
  - forging the degraded marker;
  - D5 under the degraded state;
  - the cache-invalidation writer set;
  - the autofill-token refusals;
  - audit cardinality;
  - logs.

## Testing Findings
- **T-1 Major:** the E2E "no `PASSKEY_REQUIRED` on the minimal screen" check is vacuous after a
  reload, because a body read after `networkidle` is evicted.
- **T-2 Major:** the unit audit limiter hits the real Redis whenever `REDIS_URL` is set (app-ci
  sets it). The reset helper does not clear it, so a re-run within 5 minutes fails.
- **T-3 Major:** the `ci-integration.yml` path filter omits `src/lib/proxy/**` and
  `rate-limit.ts`, so the cross-process audit proof can be skipped.
- **T-4 Major:** the plan's `auth.ts` cross-tenant passkey integration cell (T13) is missing, with
  no deviation entry.
- **T-5 Minor:** no cell shows that a `derivePasskeyState` rejection mints no credential.
- **T-6 Minor:** two reader-scan self-test cells cannot fail for the reason they name.
- **T-7 Minor:** duplicate 200-null cells.
- **T-8 Minor:** the E2E `toHaveURL` check holds before the reload, and a missing PRF secret
  shows up only as a timeout.
- **T-9 Minor:** CI sets `WEBAUTHN_RP_ID` a second time, and the spec redefines `MS_PER_DAY`.

## Adjacent Findings
- **A1 Minor (functionality → testing):** the E2E server env omits `WEBAUTHN_PRF_SECRET`, so a local
  run depends on `.env`.

## Quality Warnings
None.

## User decisions (2026-10-27)
- **SEC-1:** always require a recent sign-in for passkey registration, as delete already does.
- **FN-2:** refuse deleting the last passkey in a passkey-required tenant past grace.

## Environment Verification Report
- **E1 (WebAuthn E2E):** blocked-deferred.
  - Phase 1 constraint: plan "Verification environment constraints" E1.
  - Deviation log: Batch 3, "Deferred: the E2E spec has not been run locally".
  - It becomes verified-CI on a green `e2e` job, after T-1 and T-8 are fixed.

## Recurring Issue Check
### Functionality expert
- **Findings:** R1 FN-3; R3 FN-1; R29 FN-5; R48 FN-1; R16 Adjacent A1.
- **OK:** R2, R7, R8, R17, R18, R25, R26, R36–R42.
- **N/A:** the rest.

### Security expert
- **Findings:** R3 SEC-1; R29 SEC-3; R34 (SEC-1 and SEC-2 raised, not deferred); R49 SEC-3.
- **OK:** R1, R2, R5, R9, R10, R12, R14, R16–R18, R22, R25, R33, R35, R36, R38, R40–R43, R46–R48,
  R51, R52, R54, R55; RS2, RS3, RS4.
- **N/A:** the rest; RS1, RS5, RS6.

### Testing expert
- **Findings:** R2 T-9; R16 T-3; R33 T-3; R50 E1 not executed; RT1 T-2; RT3 T-9; RT7 T-1, T-6;
  RT11 T-2.
- **OK:** R1, R3, R7, R17–R19, R34, R35, R45–R49; RT2, RT5, RT6, RT8, RT10.
- **N/A:** the rest; RT4, RT9.

## Resolution Status

### Round 1 (fixed in c729aa68e)
- **SEC-1 Major:** both register routes call `requireRecentCurrentAuthMethod` unconditionally,
  before the challenge is minted or consumed. This was the user's decision. Plan D5 and I4 are
  updated.
- **FN-2 Minor:**
  - The `DELETE` route refuses deleting the last passkey past grace with 403
    `CANNOT_DELETE_LAST_PASSKEY`. This was the user's decision.
  - The card maps the code, and the manual-test step was rewritten.
- **FN-1 Major:** the card's PRF count, confirm text and warning use
  `prfSupported && prfWrappingPresent`.
- **SEC-2 / FN-3:** `page-route.ts` uses `passkeyEnforcementBlocks`. Its audit `blockedPath` is
  from a closed set (`PAGE /dashboard`, `PAGE /admin`).
- **SEC-3 / FN-4 / FN-5:** the policy doc and the autofill-token comment are corrected.
- **T-1:**
  - The E2E body is read on arrival, and any `/api/*` 403 fails.
  - Main-frame navigations are counted.
- **T-8:** a post-verify navigation waiter, and a precondition naming `WEBAUTHN_PRF_SECRET`.
- **T-2:** the `getRedis` mocks.
- **T-3:** the `ci-integration` path filter.
- **T-4:** a real-DB cross-tenant session-callback cell (new file).
- **T-6:** the reader-scan fixture gains `concretePaths`.
- **T-7:** the duplicate cells are merged.
- **T-9 / A1:** a single E2E env source with the PRF secret, and `MS_PER_DAY` is imported.
- **T-5:** moot. The register routes no longer derive the passkey state.

## Round 2 (incremental, 32b8e376f..c729aa68e)
No Critical or Major findings. The R43 checks found no widening.
- **Functionality:**
  - FN-6: a stale card comment.
  - FN-7: the last-passkey refusal ran after step-up.
  - FN-8: `countUserPasskeys` duplicated `derivePasskeyState`'s count.
- **Security:**
  - S2-1: a compromised sole passkey needs a replacement first.
  - S2-2 [Adjacent]: there is no admin credential revoke.
- **Testing:**
  - T2-1: no e2e cell for the mounted flag.
  - T2-2: `networkidle` bound.
  - T2-3: the cross-tenant integration run is unrecorded.
  - T2-4: no real-DB count cell.
  - T2-5: no fail-closed cell.
  - T2-6: the session double ignores `where`.

### Round 2 resolution
- **FN-8:** `derivePasskeyState` returns `passkeyCount`, and `countUserPasskeys` is removed.
- **FN-7:** the 404 and the last-passkey refusal now come before step-up. Step-up still guards
  every delete that proceeds.
- **FN-6:** the comment is fixed.
- **S2-1:** the incident path is documented in the policy doc and the manual-test plan.
- **S2-2:** follow-up; it predates this branch.
- **T2-1:** a `page.route` cell refuses the mount credentials call and asserts no navigation. Not
  executed: E1 is still blocked.
- **T2-2:** waits on the named mount responses and asserts the set is equal.
- **T2-3 / T2-4:** cross-tenant integration cells. `passkeyCount` = 2 across tenants, a real
  `DELETE` is allowed, and the control is refused. The run exited 0 (5/5). Red-proved with a
  tenant-scoped count.
- **T2-5:** fail-closed cell.
- **T2-6:** the session double matches on the token digest.
- **Red proofs:** step-up moved back first, step-up result ignored, fail-open on a derivation
  error, count collapsed, raw-token lookup, tenant-scoped count. Each turned its cells red.
