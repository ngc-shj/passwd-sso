# Plan Review: pre-pr-multipackage-build-lint-gate
Date: 2026-06-14
Review round: 1 (plan)

## Changes from Previous Round
Initial review. Three expert sub-agents (functionality, security, testing) reviewed the plan against the live codebase.

## Outcome
**No Critical or Major design findings.** Two Major findings (T1, T2) were testing-acceptance-completeness gaps, not design defects — both resolved by strengthening acceptance criteria in the plan. All Minor findings adopted as plan refinements. No contract design changed; Go/No-Go gate stays all-`locked`.

## Functionality Findings (F1–F7) — all Minor
- **F1** — C4 `-M main` two-dot must stay (mirrors `verify-move-only-diff.mjs:194`). → **Adopted**: added code-comment requirement to C4.
- **F2** — node_modules guard must append to `failed`/`failures` (like manual-test gate `pre-pr.sh:422-431`), NOT `exit 1` under `set -euo pipefail`. → **Adopted**: C2 node_modules-guard spec rewritten.
- **F3** — pre-pr reuses installed deps vs CI `npm ci`; lockfile-drift false-green is a residual gap. → **Accepted (SC3)**: scoped out; NFR2 only requires a clear deps-missing message. Anti-Deferral: worst case = a lockfile-drift bug passes pre-pr but fails CI (caught one layer later, not shipped); likelihood = low; cost-to-fix = high (npm ci every run, slow/destructive). Scoped to SC3.
- **F4** — document that `fetchOriginMainSha()` feeds only the stale-branch block; downstream scripts use local `main` ref. → **Adopted**: added "fetch independence" note to C5.
- **F5** — confirmation: R33 does not apply; no second local lint surface needs the `.claude` ignore. → No action (confirmation).
- **F6** — specify C2/C3 placement (after App Build line ~460, before Results 462). → **Adopted**: added Placement to C2.
- **F7** — C2 negative test validity depends on `cli/tsconfig` NodeNext. → **Verified on-machine** (`module/moduleResolution: NodeNext`); pinned in C2 Invariant.

## Security Findings (S1–S2) — Minor/informational, no gate weakened
- **S1** — `.claude/**` ignore is legitimate scope-exclusion, not R36 suppression (fetch()/e2e rules are root-anchored, never matched worktree copies; only 3 tracked non-lintable files under `.claude/`). → **Adopted**: added clarifying comment requirement + S1-verified note to C1.
- **S2** — skipping the orchestrator (C4) does NOT skip the four security checks — they run directly at `pre-pr.sh:140-143`. → **Adopted**: recorded as C4 Invariant (defense-in-depth).
- Verified clean: R33 (single `pre-pr.sh` for local + CI static-checks, no duplicate guard defs), `set -euo pipefail` early-exit (run_step brackets `set +e`/`set -e`, records to `failures[]`), C5 flag scope (only skips merge-queue guards), R31 (no baseline deletion), secret-scan block untouched. **No escalation.**

## Testing Findings (T1–T6 + Adjacent)
- **T1 [Major]** — acceptance didn't verify Build/Test ORDER, only that both run. → **Adopted**: added grep line-number ordering assertions to C2/C3.
- **T2 [Major]** — no test that a move refactor (rename>0) actually FIRES the orchestrator; only the 0-rename skip arm was tested. → **Adopted**: added "Fire arm" predicate test (synthetic `src` rename) to C4.
- **T3 [Minor]** — clarify the line-416 block is REPLACED, not duplicated. → **Adopted**: C4 Change + End-to-end test note.
- **T4 [Minor]** — STATIC_ONLY test should assert ABSENCE of new step labels; confirm C4 path under STATIC_ONLY. → **Adopted**: C4 condition now includes `STATIC_ONLY != 1`; Static-only test asserts label absence.
- **T5 [Minor]** — C5 negative test could false-confirm via the parallel-branch guard. → **Adopted**: C5 acceptance greps the specific `Branch is stale` message.
- **T6 [Minor]** — C2 negative test should assert `error TS2835` specifically. → **Adopted**: added to C2 negative acceptance.
- **Adjacent** — node_modules deps-guard had no acceptance test. → **Adopted**: added deps-guard test to C2.

## Recurring Issue Check
### Functionality expert
- R2, R33, R36: checked. R33 clean (no second lint/build surface drifts). R36 satisfied (ignore-path not suppression). R1, R3–R32, R34, R35, R37: N/A (dev-tooling, no runtime/app/data path).
### Security expert
- R31 clean (no baseline deletion), R33 clean (single script, no duplicate guards; no security gate drifts), R36 clean (legitimate scope-exclusion). R35 N/A. R1–R30, R32, R34, R37, RS1–RS4: N/A.
### Testing expert
- RT1 flagged (T1, resolved), RT2 flagged (T2/T4/T5, resolved), RT3 (C2 genuine failure-mode test, sharpened T6), RT4 (CI-equivalence orderings verified vs ci.yml), RT5 (end-to-end run-to-green, T3 caveat resolved), RT6 (STATIC_ONLY path, T4 resolved). R1–R37: N/A.

## Convergence
All findings resolved by plan refinement (no design change). Proceeding to Phase 2 (implementation). A second full plan-review round is not warranted — round-1 findings were acceptance/wording completeness, now closed.
