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

---

# Round 2
Date: 2026-09-29

## Changes from Previous Round
Round-1 fixes (commits `5c1154c2b`, `9f5d352f4` and `2e714c46f`) reviewed incrementally.

## Functionality Findings
- **F-doc-1 [Minor, new]** — Row (d) of `client-reauth-timing.md` said "refresh 401/403/404". The refresh route returns 401 for every token-state rejection and 403 only for `PASSKEY_REQUIRED`; only the client treats 404 as revoked. **Resolved**: the row states exactly that.
- **ADJ-1 [Minor, adjacent]** — `resolveTenantIdForUser(session.userId, tx)` hands the bypass `tx` to the imported adjudicator `resolveOwningTenantIdFromClient`, which is the gate's hand-off shape.
- All other checkpoints verified: the error contract is unchanged, there is no double notify, `SESSION_EVICTED` is written before `AUTH_LOGIN`, and a rolled-back iOS refresh leaves the old row active.

## Security Findings
No findings. F-sec-1 was re-proven independently: the gate reddens on `tx.user` inside the helper. The hand-off sweep found nothing newly invisible. F-sec-2 was verified: the raw token is hashed inside the notifier, the call is post-commit and fire-and-forget inside try/catch, and the email carries only the browser, OS, IP and time. R43: the tenant-resolution split is not a widening (READ COMMITTED gave no cross-statement consistency before either), and the iOS move narrows the race.

## Testing Findings
- **F-test-r2-1 [Major, RT7, new]** — `mobile-token.test.ts` wired the same `vi.fn()` to the top-level `prisma.extensionToken.updateMany` and to the tx one, so the D9 assertions could not tell an in-transaction revoke from the pre-fix separate commit. **Resolved**: the top-level client now has its own mock, `mockPrismaExtUpdateMany`, and the `refreshIosToken` happy-path test asserts it is never called. That is the function whose pre-fix code made the separate top-level revoke. Red proof: running the updated test file against the pre-D9 `mobile-token.ts` (throwaway copies, deleted afterwards) fails that test on the new assertion. The `issueIosToken` refresh-path test fails on its existing in-transaction assertions, because pre-D9 `issueIosToken` made no revoke at all.

## Recurring Issue Check
Functionality: R29 was F-doc-1; the rest stand. Security: H4, R46-shaped gate, R43, RLS nesting and fail-closed re-verified. Testing: RT7 was F-test-r2-1; RT1–RT6 and RT8–RT11 had no new firing.

## Resolution Status
### F-test-r2-1 [Major] shared prisma/tx updateMany mock
- Action: split the mocks; the `refreshIosToken` happy path asserts no top-level revoke. Red-proven against the pre-D9 source.
- Modified file: src/lib/auth/tokens/mobile-token.test.ts
### F-doc-1 [Minor] 404 in the refresh status list
- Action: the row now lists "401; 403 for `PASSKEY_REQUIRED`" and notes that the client also treats a 404 as revoked.
- Modified file: docs/architecture/client-reauth-timing.md
### ADJ-1 [Minor] tenant resolution hands the tx to an imported adjudicator — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: `resolveOwningTenantIdFromClient` is the codebase's single owning-tenant adjudicator, and every caller hands it the client it should read through (for example the passkey route's SSO guard, which was already a hand-off site before this branch). It reads only `user`, which is on `auth-adapter.ts`'s allowlist, and `tenant-context.ts` carries its own `ALLOWED_USAGE` entry. The session-cap models the gate lost sight of in F-sec-1 are now scanned in `session-concurrency.ts`.
  - Worst case: a future edit makes the adjudicator touch a new model under a caller's bypass without the gate noticing. That is the documented, repo-wide hand-off limitation of `check-bypass-rls`, not a new one.
  - Likelihood: low. The function is small and has a single purpose.
  - Cost to fix: moderate. It needs the gate to resolve imported callees (a Program-backed pass), which is a gate-wide change beyond this branch.
- **Orchestrator sign-off**: accepted. A cross-file callee pass for `check-bypass-rls` is a repo-wide follow-up, not specific to this change.

---

# Round 3
Date: 2026-09-29

## Changes from Previous Round
Commit `f219a10de` was reviewed from all three perspectives by a single reviewer, reported separately.

## Functionality Findings
No findings. The row (d) statuses match the route (401 for every token-state rejection, 403 for `PASSKEY_REQUIRED`) and the client (`token-handler.ts` treats 401, 403 and 404 as revoked).

## Security Findings
No findings. No Web sign-in path revokes extension tokens: `events.signIn` only audits, and the only production family revokes are in the refresh cycle and at mint time (supersede or cap).

## Testing Findings
- **QA-1 [Minor]** — The `mockPrismaExtUpdateMany` assertion added to the `issueIosToken` refresh-path test could not discriminate: the pre-fix top-level revoke lived in `refreshIosToken`, which that test does not call. The test still reds on pre-D9 code through its existing assertions.

## Recurring Issue Check
No recurrence of earlier classes. QA-1 concerns where an assertion is placed within the RT7 fix; it does not reopen RT7.

## Tightening-only skip — Round 3
Findings applied directly (no Round 4 review):
- QA-1 [Minor] non-discriminating assertion — `src/lib/auth/tokens/mobile-token.test.ts` (`issueIosToken` refresh-path test) — assertion removed; the Round 2 resolution text was corrected so it no longer claims both tests red on the new line.
Justification: the finding is inside Round 2's fix scope, it is an inline minor (removal of a dead test assertion plus review-log wording), and it changes no production behaviour or security boundary.
