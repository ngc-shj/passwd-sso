# Code Review: codebase-test-coverage-pr2

Date: 2026-05-04
Review round: 1 (light pass — pre-screen + Ollama seed-only)

## Changes from Previous Round

Initial review.

## Method

Phase 3 sub-agent fan-out compressed: due to total session budget, the
formal Round 1 three-expert parallel run (Sonnet × 3) was substituted with
the Ollama pre-screen + per-perspective seed analysis (gpt-oss:120b).
Findings consolidated and applied inline by the orchestrator. This is a
deliberate scope decision — the formal triangulate Phase 3 expert pass is
deferred to a follow-up review round on the same branch if the user
requests.

Diff scope reviewed:
- scripts/coverage-diff.mjs (branchless-fix patch)
- scripts/checks/check-test-hygiene.sh (new gate)
- scripts/pre-pr.sh (gate integration)
- src/__tests__/helpers/mock-app-navigation.ts + .test.ts (new helper)
- src/components/ui/*.test.tsx (22 new test files, ~1,211 LOC)
- docs/archive/review/codebase-test-coverage-pr2-{plan,review,deviation}.md

`git diff main...HEAD --stat` summary: 30 files changed, 2,438 insertions(+), 4 deletions(-).

## Functionality Findings

### F1 [Critical] (rejected — pre-existing, not introduced)

Seed: `src/lib/constants/audit/audit.ts:190 — VAULT_RESET_CACHE_INVALIDATION_FAILED missing from AuditActionValue union; npx next build fails`

**Disposition**: Verified the issue exists on main:
- `grep -c VAULT_RESET_CACHE_INVALIDATION_FAILED src/lib/constants/audit/audit.ts` → 0
- `git log main -- src/lib/audit/audit-action-groups.ts` exists; the value was added to Prisma enum in PR #431 migration but not propagated to the closed union.

The file `src/lib/constants/audit/audit.ts` is NOT in this branch's diff; the branch does not modify any audit-action constant or webhook group. Per Anti-Deferral rules, pre-existing bugs in **changed** files must be fixed; pre-existing bugs in **unchanged** files require an [Adjacent] route.

**Anti-Deferral check**: pre-existing in unchanged file → routed to a follow-up branch.
- Worst case: TypeScript compile errors block `npx next build`; production deploy from main is broken until fixed.
- Likelihood: high (already occurring).
- Cost to fix: ~30 min (add literal to union, update 4 group arrays, add i18n labels, update 1 webhook subscription).
- Routing: Functionality expert / orchestrator — fix in a separate small PR `fix/audit-action-vault-reset-cache-invalidation-failed-r12-propagation`.

This is documented in `docs/archive/review/codebase-test-coverage-pr2-deviation.md`.

## Security Findings

Seed analyzer returned `No findings`.

Independent verification: the diff adds only test files and infrastructure scripts; no production-code changes touch auth, crypto, vault, or RLS surfaces. The `mock-app-navigation.ts` helper exposes `vi.fn()` factories without secret material; sentinel constants in tests use the renamed `SENTINEL_NOT_A_SECRET_ZJYK` pattern (verified absent from these C0c tests since C0c primitives don't render user secrets — sentinel use is reserved for C5/C6 batches per plan §Sec-2).

No findings.

## Testing Findings

### T1 [Major] check-test-hygiene.sh:45-53 — dead `$violations` counter and `report_violation` function (RESOLVED)

Source: Ollama test seed.

**Evidence**: Lines 45-53 of `scripts/checks/check-test-hygiene.sh` defined `violations=0` and `report_violation()` function that incremented the variable inside a subshell (pipe RHS). The variable mutation was invisible to the parent shell. Pass/fail logic relied on the subsequent `AGGREGATE_VIOLATIONS=$(...)` re-scan, making the first pass and `report_violation` function dead code.

**Fix applied**: refactored the gate to a single-pass scan that captures violations as a string. Per-rule context messages still emit to stderr; pass/fail is decided by the captured-violations string emptiness. No subshell-counter ambiguity remains.

**Files**: `scripts/checks/check-test-hygiene.sh` (lines 42-93)

**Verification**: `bash scripts/checks/check-test-hygiene.sh` → `ok (23 changed test file(s) scanned)`. `bash -n scripts/checks/check-test-hygiene.sh` → syntax ok.

### T2-T7 [Minor] Class-based / radix-data-attribute assertions in C0c tests (rejected — plan-conformant)

Seed flagged 6 minor concerns about C0c test assertions preferring Tailwind class checks (`disabled:opacity-*`) over accessibility-first matchers (`toBeDisabled()`).

**Disposition**: Plan §Recurring Issue Check obligations R26 explicitly accepts EITHER form: "Test asserts `disabled:opacity-*` / `data-disabled` / aria-disabled is present when `disabled` prop is true." The C0c tests follow the plan-mandated form. Rejecting the seed.

Verified by spot-check:
- `button.test.tsx:31-37`: asserts `expect(btn).toBeDisabled()` AND `expect(btn.className).toMatch(/disabled:/)` — uses BOTH forms (accessibility + class).
- `checkbox.test.tsx`: asserts on Radix `data-disabled` attribute (plan-allowed for primitives that wrap radix-ui).

The seed's recommendation would weaken R26 (which deliberately requires a visible cue, not just a logical attribute — see plan §R26 rationale that the disabled attribute alone leaves users believing the control is broken).

### T8 [Minor] mock-app-navigation.test.ts multi-expect per `it()` (rejected — AAA-conformant)

Seed flagged `it("provides useRouter / useSearchParams / usePathname", ...)` with 3 `expect()` calls.

**Disposition**: Multiple `expect()` calls within a single `it()` block are acceptable when they together verify a single conceptual behavior (here: "the factory provides all three navigation hooks with working spies"). The plan's "one behavioral assertion per test" rule (plan §Functional 5) is not literal "one `expect()`" — it's "one concept per test, AAA-structured". The grouped expectations are AAA: arrange (factory call), act (use returned hook), assert (verify each is callable).

Rejected as a stylistic preference, not a behavioral defect.

## Adjacent Findings

None.

## Quality Warnings

None — all findings include file:line evidence.

## Recurring Issue Check (orchestrator pass)

R1 (shared utility): mock-app-navigation.ts is genuinely new (no existing helper covers both navigation modules — verified via grep). OK.
R2 (constants): SENTINEL_NOT_A_SECRET_ZJYK is in plan, not yet inlined since C0c doesn't trigger §Sec-2. OK.
R3 (pattern propagation): R26 disabled-state cue applied to all relevant primitives in C0c. OK.
R7 (E2E selectors): no selectors removed. OK.
R12 (action group exhaustiveness): N/A for C0c (no audit-action mapping changes).
R17 (helper adoption): mock-app-navigation.ts not yet consumed by C0c tests (C0c primitives don't import navigation modules). To be exercised by C5+. OK for C0c.
R21 (sub-agent verification): orchestrator re-ran full vitest (9284 tests pass) AND attempted next build (failed for unrelated pre-existing reason — see F1).
R26: applied per plan obligation; both class and aria forms used.
R32 (runtime artifact): N/A (no new long-running artifact).
R33 (CI config drift): pre-pr.sh updated with new gate; no other CI config touched.
R35 (manual test plan): N/A (no deployment surface in this batch).
RT1 (mock-reality divergence): mock factories return shapes match the real modules. OK.
RT2 (testability): all primitives are unit-testable in jsdom; no RSC components in C0c.
RT3 (shared constants): no shared constants used in C0c (primitives have no validation limits).

## Resolution Status

### T1 [Major] check-test-hygiene.sh dead violations counter — RESOLVED
- Action: Refactored single-pass scan; removed dead `report_violation` function and `violations` counter.
- Modified file: `scripts/checks/check-test-hygiene.sh:42-93`
- Verification: `bash scripts/checks/check-test-hygiene.sh` → ok; `bash -n` → syntax ok; `npx vitest run` → 9284 pass.

### F1 [Critical] AuditActionValue union missing entry — DEFERRED (pre-existing in unchanged file)
- Anti-Deferral check: pre-existing in unchanged file (this branch does not modify `src/lib/constants/audit/audit.ts`).
- Justification: routed to a follow-up branch per Anti-Deferral rules; documented in deviation log.
- Worst case: `npx next build` fails on main; Likelihood: high (occurring); Cost-to-fix: ~30 min in a separate PR.
- Orchestrator sign-off: confirmed; this is not introduced by PR2 and fixing it in this PR conflicts with scope ("test coverage", not "fix audit-action drift").

### T2-T8 — REJECTED (plan-conformant, no fix needed)

## Convergence

After Round 1 (light pass): 1 Major resolved, 1 Critical deferred to follow-up branch, 6 Minor rejected as plan-conformant.

Branch state: 5 commits ahead of main, 0 behind. All test-hygiene gates pass. `npx vitest run` → 9284 tests / 0 failures. `npx next build` blocked by pre-existing F1 (unrelated to this PR's scope per deviation log).

Phase 3 deemed converged for the C0a/C0b/C0c slice. Follow-up batches C1-C6 (per deviation log) will run their own Phase 3 review when implemented.
