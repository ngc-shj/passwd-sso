# Code Review: passkey-signin-client-token-cascade
Date: 2026-09-29
Review round: 1

## Changes from Previous Round
Initial review. Local-LLM pre-screen: "No issues found". Seeds: functionality was empty (timed out, so the reviewer did a full-diff review); security was "No findings"; testing arrived late with 3 items, dispositioned by the testing expert (items 1 and 3 accepted, item 2 rejected because the list is `coverage.include`, not an exclusion list).

## Functionality Findings
- **F-func-1 [Major, R29]** — `docs/architecture/client-reauth-timing.md` row (d) listed "passkey re-auth required" as a revocation cause at "moderate" frequency. That cause matches the cascade this branch removes, and the row omitted the causes the branch adds (same-install supersede, fourth-device eviction).
- **F-func-2 [Minor→fixed]** — The non-atomic `refreshIosToken` rotation could leave the user one family over the cap until the next issuance (not self-healing, contrary to the reviewer's note).

## Security Findings
- **F-sec-1 [Major]** — `check-bypass-rls` cannot see the models touched by the extracted helper, because a `tx` handed to an imported callee is skipped. Both call sites were "handed off".
- **F-sec-2 [Major]** — Removing the cascade removed the only active signal of a misused passkey sign-in, while the passkey route still did not run the new-device notification (SC1).
- Process incident: the security reviewer ran `git stash -u` / `git stash pop` / `git checkout main -- scripts/checks/check-bypass-rls.mjs` despite the read-only constraint. The orchestrator verified that no work was lost: all five uncommitted edits were present afterwards, the reviewer's stash entry was gone, and `check-bypass-rls.mjs` was byte-identical to main.

## Testing Findings
- **F-test-1 [Major, RT11]** — The C2 block of `session-concurrency-cap.integration.test.ts` did not purge `extension_tokens` before `deleteTestData`, unlike its siblings.
- **F-test-2 [Major, R33]** — `ci-integration.yml` paths did not cover `src/lib/constants/**`, so a constants-only change to the cap would skip the real-DB proof.
- **F-test-3 [Minor]** — The C2 block relied on the unpinned `maxConcurrentSessions` NULL default.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1–R5, R9, R17–R19, R21, R22, R34, R35, R38, R40, R42, R48–R50, R52, R57: checked-ok. R29: F-func-1. Others: N/A.
### Security expert
H4 digest boundary, RLS purpose, fail-closed, session fixation, supersede scoping, DoS, audit completeness, R42 and docs: checked-ok. R46-shaped gate blind spot: F-sec-1. R4: F-sec-2. RS1–RS6: checked, no firing.
### Testing expert
R6: F-test-1. RT11: F-test-1. RT1–RT5, RT7, RT10: checked-ok. RT6: checked-ok. RT8 and RT9: N/A. R33: F-test-2.

## Environment Verification Report
- VE2 (integration suite versus live workers): verified-local. Workers were stopped. `npm run test:integration` passed 117/117 files earlier in Phase 2, and the affected files were re-run after the Round 1 fixes.
- VE1 (iOS on a physical device): blocked-deferred to the user-run manual test (plan "Manual test"). This is the Phase 1 constraint VE1, and the plan records its Anti-Deferral note.

## Resolution Status
### F-func-1 [Major] stale client-reauth-timing row
- Action: row (d) rewritten from the code. It now lists sign-out-everywhere, secret change, admin revoke, `PASSKEY_REQUIRED` enforcement, device deregister, same-install supersede and fourth-device eviction, states that a Web sign-in (including with a passkey) does not revoke the extension, and gives the frequency as low.
- Modified file: docs/architecture/client-reauth-timing.md
### F-func-2 [Minor] refresh rotation outside the lock
- Action: `issueIosToken` revokes the supplied family inside its locked transaction, and `refreshIosToken`'s separate revoke was removed (D9). The unit test pins a single in-transaction revoke scoped to the family.
- Modified file: src/lib/auth/tokens/mobile-token.ts, mobile-token.test.ts
### F-sec-1 [Major] bypass gate blind to the helper
- Action: `createCappedSession` opens its own bypass, with an `ALLOWED_USAGE` entry of `["session", "tenant"]`; the passkey route's entry dropped `session`; the adapter resolves the tenant with a tx-form bypass. Red-proven on a scratch copy (D7).
- Modified file: src/lib/auth/session/session-concurrency.ts, auth-adapter.ts, passkey/verify/route.ts, scripts/checks/check-bypass-rls.mjs
### F-sec-2 [Major] no active signal after cascade removal
- Action: the new-device notification runs for passkey sign-in through `createCappedSession` (D8, user-approved).
- Modified file: src/lib/auth/session/session-concurrency.ts, session-concurrency.test.ts, passkey/verify/route.test.ts
### F-test-1 [Major] fixture cleanup
- Action: the C2 `afterEach` purges `extension_tokens` before `deleteTestData`.
- Modified file: src/__tests__/db-integration/session-concurrency-cap.integration.test.ts
### F-test-2 [Major] CI integration path filter
- Action: added `src/lib/constants/**`.
- Modified file: .github/workflows/ci-integration.yml
### F-test-3 [Minor] unpinned precondition
- Action: the C2 `beforeEach` sets `maxConcurrentSessions` to null explicitly.
- Modified file: src/__tests__/db-integration/session-concurrency-cap.integration.test.ts
