# Code Review: pre-pr-multipackage-build-lint-gate
Date: 2026-06-14
Review round: 1 (code)

## Changes from Previous Round
Initial code review of the implemented diff (uncommitted working tree): `eslint.config.mjs`, `scripts/pre-pr.sh`, `scripts/refactor-phase-verify.mjs`. Three expert sub-agents reviewed against the finalized plan + deviation log.

## Outcome
**Converged in Round 1. Zero actionable findings.** Functionality and Security returned "No findings". Testing returned 3 Minor items — all explicit "Fix: None needed" confirmations that the implementation is correct (not defects).

## Functionality Findings
No findings. Verified:
- C5 control flow: `originSha`/`envSha`/`expectedSha` now block-scoped inside `if (!skipMergeQueueGuards)` (refactor-phase-verify.mjs:80-82); no later reference; `scripts[]` loop runs unconditionally; no-flag (`--force`) path byte-identical in effect.
- C4 predicate safe under `set -euo pipefail` (`grep -qE` exit 1 in `if`-condition does not abort; `-- src` no word-split; two-dot `-M main` mirrors verify-move-only-diff.mjs).
- C2/C3 deps-guards append to `failed`/`failures` (no `exit 1`); `run_step` captures `${PIPESTATUS[0]}` of the `bash -c` subshell correctly.
- Placement: new block after App Build, before Results; C4 block replaced the old one in place (no duplicate).

## Security Findings
No findings (no escalations). Verified:
- C1 `.claude/**` is legitimate scope-exclusion, NOT R36 suppression — root-anchored `src/**`/`e2e/**` rule globs never matched `.claude/worktrees/<id>/...`; zero tracked lintable files under `.claude/`.
- C5 flag skips ONLY the stale-branch + parallel-branch guards; the four security checks (team-auth-rls/bypass-rls/crypto-domains/migration-drift) at `scripts[]` indices 0-3 still run; CI `--force` path unchanged.
- C4 skip path still runs the four security checks via pre-pr.sh:140-143 (defense-in-depth).
- C2/C3 under `STATIC_ONLY!=1`, after all `Static:` guards; `run_step` brackets `set +e`/`set -e` so a package failure cannot abort the run and skip later checks.
- R33: single `PRE_PR_STATIC_ONLY=1` source; no duplicate CI config drift. R31: no state destruction (baseline `writeFileSync` is re-indent only).

## Testing Findings
- **[T1] Minor** — C5 negative test cause is specific: `Branch is stale` (line 101-106, inside `if (!skipMergeQueueGuards)`) precedes `checkParallelRefactorBranches` (line 138), so on the without-flag path with a stale baseline it is the proximate exit cause. Plan's grep-the-string acceptance is sound. **Fix: none.**
- **[T2] Minor** — C4 fire-arm reachable (synthetic `R` line fires the predicate; orchestrator invocation is independently C5-tested). Not vacuous. **Fix: none.**
- **[T3] Minor** — deps-guard appends empty logfile to `failures[]`; `show_failure_context` guards on `[ -n "$logfile" ]` and prints label-only, matching the manual-test-gate precedent. **Fix: none.**
- RT1 PASS (order matches ci.yml byte-for-byte). RT2/RT3 PASS. Contract coverage: all C1–C5 implemented as planned.

## Adjacent Findings
None actionable. (Testing noted "no bats harness" as project-context Minor info — out of scope per plan; script validated by running it: full pre-pr.sh EXIT=0, Passed:36.)

## Recurring Issue Check
### Functionality expert
- R33: clean (closes drift; order pinned to ci.yml with a comment). R36: clean (ignore-path, not suppression). R1–R32, R34–R37: N/A (dev-tooling).
### Security expert
- R31: N/A (no state deleted). R33: clean (single source). R36: clean. RS1–RS4: N/A (no route/auth/crypto/schema). R1–R30, R32, R34, R35, R37: N/A.
### Testing expert
- RT1: PASS. RT2: PASS. RT3: PASS. RT4–RT6: N/A. R33/R35/R36: respected.

## Environment Verification Report
All C1–C5 acceptance paths classified `verified-local`:
- C1: `npx eslint .` EXIT=0.
- C2: CLI Build→Test pass; named extensionless import → TS2835 EXIT=2 (regression class caught).
- C3: Extension Test (769) → Build, both pass.
- C4: 0-rename skip arm (no stale false-fail) + synthetic-rename fire-arm predicate.
- C5: with-flag → 16 scripts run, no stale exit; without-flag → exit 1 on `Branch is stale`.
- End-to-end: full `bash scripts/pre-pr.sh` EXIT=0, Passed:36. STATIC_ONLY path skips new steps.
No `blocked-deferred` paths. N/A constraints declared none beyond fully-local verifiability.

## Resolution Status
No Critical/Major/actionable-Minor findings to resolve. Review complete.
