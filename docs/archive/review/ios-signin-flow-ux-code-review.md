# Code Review: ios-signin-flow-ux

Date: 2026-06-15
Review round: 1 (converged)
Scope: `git diff 3b7be112...HEAD -- ios/` (ios-main base → feature/ios-signin-flow-ux)

## Changes from Previous Round
Initial review.

## Outcome
**No Critical or Major findings** from any of the three experts. The implementation
faithfully realizes contracts C1–C6 and honors the plan's S7 no-destructive-cleanup
invariant. All checks (functional correctness, Swift-6 concurrency, security trust
boundaries, test quality) passed.

## Functionality Findings
- **F1 (Minor)** — `PasswdSSOUITests.swift:17` comment was stale (launch now shows a
  splash before routing). → **Fixed** (comment updated).
- All 8 targeted checks clean: `.task` re-entry guard correct; `handleVaultUnlocked`
  always terminates non-`.unlocking`; `hasTokens` double-optional flatten correct;
  `AppState` switch exhaustive (single consumer); `.signedIn` 2-arg everywhere;
  `SignInView.serverURL` sole constructor updated; no retain cycle in `.task`;
  "Sign in again" reuses the persisted SE key via `getOrCreateDPoPKey`.

## Security Findings
- **No findings.** All 7 checks clean: no destructive cleanup in SessionRestorer or
  the `.task` mapping (S1); no token/key logging (S2); production `dpopKeyLabel`
  unchanged + `precondition` in init (S3); `.dead`→`.vaultLocked` grants no new server
  access — unlock is local, dead-token sync fails closed (S4); server-URL display
  leaks no secret (S5); "Sign in again" preserves DPoP cnf-binding (S6); launch-time
  signing without biometric matches the existing SE-key posture (S7).
- S3 observation (non-finding): `getOrCreateDPoPKey` loads via `loadDPoPKey` directly
  rather than the new `keyLoader` seam — test-consistency only, no production impact.

## Testing Findings
- **T-05 (Moderate→Rejected)** — request for a 4th spy arm (signerExportFailed) in
  `testRestore_validateNotCalledWhenPreconditionsFail`. **Rejected**: `restore()` has
  exactly three precondition-failure branches (no config / no tokens / makeSession→nil);
  "signer export failed" is not a distinct branch — it collapses into the single
  `guard let client = await makeSession(config)`. The 3-arm spy is complete; a 4th arm
  would exercise the identical code path.
- **T-06 (Minor→Accepted, by design)** — `.loggedOut` routes to `.setup` (URL screen)
  rather than `.signIn`. **Accepted**: the plan's Considerations explicitly designate
  "Sign Out → `.setup`" as the *deliberate change-server entry point* (it is the only
  remaining way to change the server URL after onboarding). Routing it to `.signIn`
  would remove that capability. Surfaced to the user as an optional future refinement
  (split manual Sign Out vs idle-timeout-logout) — not changed this round.
- **T-01 (Minor→Accepted)** — the two `makeSession→nil` tests are redundant code paths.
  Kept: the plan's T1f2 specified a distinct fixture as a forward-looking guard; both
  correctly assert `.needsSignIn`. Harmless.
- **T-07/T-08 (plan-approved)** — flicker-fix ordering and `.task` guard are not
  unit-tested (no RootView harness). Per the plan's documented "Not unit-tested" note;
  the flicker fix carries the mandatory inline regression-guard comment.
- All other checks clean: 4-way matrix covered; CallCounter await correct; no vacuous
  assertions; offline test uses `URLError` (not `NSError`) per T2f; `acc_test` rotation
  asserted; `loadPersistedSigner` present-case exercises the real coordinator;
  `DebugVaultLoaderTests` preserved and unbroken; MockURLProtocol reset in `setUp`;
  no real-Keychain leakage (FakeKeychain / `kSecAttrIsPermanent:false`).

## Adjacent Findings
None.

## Recurring Issue Check
### Functionality expert
- R8 (missing await): clean — all `loadPersistedSigner`/`ensureValidSession` call sites await.
- R12 (enum-consumer coverage): clean — single `switch appState`, compiler-enforced exhaustiveness for `.launching`/`.unlocking`.
- R25 (persisted-state symmetry): clean — restoration is read-only; destructive ops stay on the explicit sign-out path.
- Dead-code completeness: clean — `onDebugVaultReady`/`Load Test Vault`/`handleDebugVaultLoaded` zero matches; `DebugVaultLoader` survives.

### Security expert
- RS1 (token leakage): clean. RS2 (dead-session cleanup): clean — no destructive ops in `.task`.
- RS3 (trust boundary): clean. RS4 (no-destructive-cleanup invariant): clean — `.needsReauth`→`.vaultLocked` performs no cleanup.
- RS5 (DPoP cnf-binding): clean — "Sign in again" reuses the same SE key.

### Testing expert
- RT1 (untested branches): only the plan-approved RootView view-state.
- RT2 (vacuous assertions): none. RT3 (test isolation): clean. RT4 (bug-fix regression): flicker fix comment-guarded (plan-approved).
- RT5 (mock shape): clean. RT6 (async correctness): clean. RT7 (state leakage): none.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. Build + full suite (525 unit +
2 UI tests) executed `verified-local` on iPhone 16 Pro simulator (iOS 18.0), 0 failures.

## Resolution Status
### F1 Minor — stale UI-test comment
- Action: updated the comment to describe the splash-then-route launch flow.
- Modified file: PasswdSSOUITests.swift:17

### T-05 Moderate — 4th spy arm — Rejected
- **Anti-Deferral check**: not a defect — no distinct code path exists.
- **Justification**: `restore()` has three precondition-failure branches, all covered; a "signer export failed" arm exercises the same `makeSession→nil` guard. Adding it tests identical code.
- **Orchestrator sign-off**: confirmed by reading SessionRestorer.restore().

### T-06 Minor — `.loggedOut`→`.setup` — Accepted (by design)
- **Anti-Deferral check**: out of scope (different concern) — documented design decision.
- **Justification**: the plan's Considerations designate Sign Out → `.setup` as the sole change-server entry point. Cite: plan "Out of scope: changing the server URL after onboarding (only via Sign Out → `.setup`…)". Surfaced to user as optional refinement.
- **Orchestrator sign-off**: confirmed against plan Considerations.
