# Plan Review: fail-closed-tranche3
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Round 1: initial review, 9 findings (1 High, 2 Major, 1 Med×2-perspective, 5
Minor/Low) — all applied to the plan.

## Round 2 (verification)
All 9 Round-1 fixes verified correct and complete against source. The approve-route
reference shape (`.../reset-vault/[resetId]/approve/route.test.ts`) confirmed real
(mockImplementationOnce×2 + module-scope results[0]/[1].value capture). Auth
post-import capture confirmed feasible. One NEW Low finding (F-new-1): auth test has
two separate describe blocks with per-test `resetModules` and ~14 existing wrapper
tests referencing the shared `mockRateLimitCheck` — "leave existing cases untouched"
needed a precise wiring note (two distinct result objects both delegating to
`mockRateLimitCheck`; capture in a dedicated import-once describe block). Applied. No
Critical/High/Major findings in Round 2. Plan review converged.

## Merged Findings

1. **High** [Security] — M9 logAuditAsync-exclusion under-enumerated. The per-route
   table annotates "NOT logAuditAsync" only on #9–12, but ALL 12 post-auth routes
   (#2–13) pass non-null userId + resolvable tenantId to `checkRateLimitOrFail`, so
   `emitRateLimitFailClosed` fires `logAuditAsync` on the 503 path for every one.
   Following the table literally invites adding `logAuditAsync` to `assertNoMutation`
   for #2–8,#13 → races the un-awaited emission (flake) or invites an
   audit-suppressing stub on a fail-closed control. R42 member-set gap: M9 applied to
   a hand-picked subset, not code-derived from the primitive (non-null userId +
   resolvable tenantId → logAuditAsync fires). Not Critical: C4 grep is a diff-scoped
   backstop and the plan prose states the correct universal rule; the table
   contradicts it. Fix: annotate every post-auth row #2–13 + state the derivation
   rule once.

2. **Major** [Functionality, Testing] — auth/[...nextauth] test uses dynamic
   `await import()` inside test bodies (with `resetModules()`), so module-scope
   `snapshotFactory` + `mock.results[i].value` capture reads empty `mock.results` →
   undefined limiters. The cited precedent (approve route, static import) does NOT
   transfer. Fix: add an auth-specific sub-task — capture+snapshot after the first
   dynamic import (or a `beforeAll` import once); budget auth as a hard case
   alongside reset-vault.

3. **Major** [Functionality, Testing] — #9 reset-vault (and #1 auth) share ONE
   `check` mock across both limiters, distinguished only by `mockResolvedValueOnce`
   ordering. `findIndex(r => r.value === limiter)` returns 0 for both (same object) →
   wrong attribution; and `Promise.all` runs both `.check()` concurrently so both
   mocks must be pre-armed. Fix: adopt the approve route's exact shape — two distinct
   `check` fns, `mockImplementationOnce`×2 returning distinct `{check}` objects in
   creation order, module-scope capture of `results[0]/[1].value`, sibling
   `check.mockResolvedValue({allowed:true})` per case. Reference in-repo, not as
   "fallback".

4. **Medium** [Security, Testing] — #5 dcr-cleanup is a 410 stub with no DB write;
   only downstream effects are `requireMaintenanceOperator` (guard) + `logAuditAsync`
   (forbidden by M9). The helper throws on empty `assertNoMutation`. Fix: specify
   `requireMaintenanceOperator.not.toHaveBeenCalled()` as the fail-closed witness
   (first effect after the limiter). Do NOT use `logAuditAsync`.

5. **Minor** [Functionality] — the helper strengthens 503 assertions (body
   `{error:SERVICE_UNAVAILABLE}` + `Retry-After` integer>0) beyond the current
   status-only direct-503 cases; the plan calls output "unchanged". Documentation gap
   only (production reaches `serviceUnavailable()`).

6. **Minor** [Functionality] — #9 table lists "adminVaultReset.updateMany (or
   .create)" but the POST route only calls `.create` + `createNotification`.
   `updateMany` is a copy-forward from tranche-2 row #20 (approve). Fix to
   `adminVaultReset.create`, `createNotification`.

7. **Minor** [Functionality] — #1 `assertNoMutation` uses a handler-proceed spy
   (wrapped handler `.not.toHaveBeenCalled`), valid via the tranche-2 read-only-route
   semantic extension but not restated. Fix: cite the extension for #1.

8. **Low** [Testing] — plan says "non-recording `vi.fn(()=>...)`" but purge-history:36,
   dcr-cleanup:20, auth:34, sign-authorize:35 use a PLAIN ARROW (no `vi.fn`).
   `snapshotFactory` reads `mock.mock.calls` → throws on a plain arrow. Fix: correct
   the F-refactor to "plain arrow OR non-recording vi.fn → convert to recording
   vi.fn unconditionally".

9. **Low** [Testing] — gate comment :61 and self-test comments :49,:966-967 say
   "16 (13 routes + 3 lib members)" but the real constant is 13, no lib members in
   legacy; doubly stale after 13→0. Fix: C2 also corrects these comments to the
   post-tranche end-state.

## Quality Warnings
None. All findings carry specific file/route references, concrete failure modes, and
actionable remediation.

## Recurring Issue Check
### Functionality expert
R1 pass · R2 pass · R17 FLAG (F2/F3 multi-limiter helper adoption) · R42 pass (both
greps recomputed, zero delta: 13 routes, 4 stubs) · all others n-a.

### Security expert
R42 flag (F1 — M9 applied to subset not code-derived member-set) · RS2 flag (F1
audit-suppression risk on fail-closed control) · RS1/RS3-RS6 ok · ratchet
bypass-proof; C6 exemption-emptying safe (broadened anti-evasion sweep found no
additional stub forms — the 4 are the whole class); no Critical, no fail-open member
missed.

### Testing expert
RT7 WARN (#1/#9 distinct-limiter wiring) · RT8 WARN (#5 empty assertNoMutation, #9
shared-check vacuity) · RT1/RT3/RT5/RT9 ok · classifier-no-change confirmed for 12/13
(M-refactor probe yields distinct=2); self-test ratchet insulated (no hardcoded 13 in
the constant path).
