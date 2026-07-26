# Plan Review: pre-pr-parallelization
Date: 2026-07-26
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening ran first (3 findings, all fixed before expert review): missing parallel-output synchronization detail, `.mjs`-port behavioral-drift risk, and unspecified stderr handling.

## Headline outcome

Three experts reviewed independently. **Two converged on the same Critical**: the plan's C1 safety argument was a vacuous oracle. Per the perspective-convergence rule this sets a Critical severity floor, and it was the finding that reshaped the plan.

The security expert did not merely assert it — they **built the counter-example**: a narrowed gate (merging the `arg_window` `+3` and `opt_window` `+10` reads at `check-step-up-client-coverage.sh:501-502`, exactly what the plan's own "read each client file once" wording invites) that passed **30/30 self-tests AND produced a byte-identical differential**, while genuinely losing detection of a `"PUT"` literal at offset +6.

Independently re-verified by the orchestrator: the gate emits **0 lines / 0 bytes on a clean tree**, so the original `C1-AC2` reduced to `diff /dev/null /dev/null`. It would have passed `exit 0 # optimized`.

Four defects were red-proven with executable probes rather than argued:

| # | Claim | Probe result |
|---|---|---|
| 1 | `wait -n` status capture mis-attributes verdicts | declaration truth `0 0 7` → reported **`7 0 0`** (failing step reported as passing) |
| 2 | Per-index join under `set -e` aborts the run | `SCRIPT EXIT=7`, steps 1–2 never joined, Results block never printed |
| 3 | Backgrounded jobs cannot mutate parent counters | `passed=0` after a job incremented it |
| 4 | Gate is silent when healthy | `0 0` lines/bytes, exit 0 |

## Functionality Findings

**F1 (Critical)** — `wait -n` status capture mis-attributes verdicts. Bash's `wait -n` returns *a* status without identifying which job produced it, so assigning it to the dispatch loop's index blames the wrong step. Orchestrator-verified: `7 0 0` against a truth of `0 0 7` — a failing security gate reported as passing (R44 fail-open). The plan's stated hazard (that a later per-PID `wait` returns 127) was also factually wrong: bash retains reaped-child statuses, verified `0 7 0 9 0` across a `wait -n` throttle. **Resolution**: `wait -n` demoted to a pure throttle with its status discarded; statuses read only in the join phase per index. Old mechanism added to forbidden patterns.

**F2 (Critical)** — Exit status 127 is ambiguous: a step whose interpreter is missing exits 127, indistinguishable from `wait`'s "no such job". Branching on it as a bookkeeping artifact fails open exactly on environment drift. **Resolution**: contract now forbids treating any `wait` return as a control signal; `C2-AC6` added.

**F3 (Major)** — Invariant I4 mandated a `PIPESTATUS[0]` read that the pipeline-free design structurally removes (design deadlock), and dropping `tee` silently loses *passing*-step stdout. Verified: `check-gate-selftest-coverage.sh` and `check-destructive-wrapper-derivation.mjs` both print CI-auditable config on success. **Resolution**: I4 rewritten around `wait`; new I8 + `C2-AC7` require replaying passing-step logs.

**F4 (Major)** — Plan never stated that counters must be mutated only in the parent shell. Verified hazard: a backgrounded increment is silently discarded, yielding `Passed: 0 / Failed: 0` with exit 0. **Resolution**: I7 added.

**F5 (Major)** — The enqueue/dispatch split breaks the script's non-`run_step` steps. Mechanically derived member set: **6 `printf`-only skip notices + 9 inline counter mutations** would execute at enqueue time and print before all replayed results. **Resolution**: C2 scope narrowed to the contiguous `run_step` block at `pre-pr.sh:158-184`; everything from `:186` on is unchanged (`SC4`).

**F6 (Major)** — C1's `declare -A` hoist would silently revoke a documented bash-3.2 guarantee. Verified: the target script states it twice (`:154`, `:203-204`), the SC2 sibling four times. **Resolution**: `declare -A` added to forbidden patterns; indexed-array hoist mandated.

**F7 (Major)** — Forbidden-pattern list named only `manifest_line_for`, permitting a half-fix that leaves 4–6 spawns per iteration; and the plan conflated per-file with per-call-site windows — hoisting `arg_window` to file scope would widen matching from 4 lines to the whole file. **Resolution**: scope table added distinguishing the four windows; four more forbidden patterns added.

**F8 (Minor)** — NFR1's ≤10 s target is arithmetically unreachable: SC2's untouched 9.82 s check alone consumes it. **Resolution**: retargeted to ≤15 s (dev) / ≈20 s (CI), with the reasoning recorded.

**F9 (Minor)** — Parallel-safety table asserted a completeness claim ("only two writers") by inspection. **Resolution**: re-derived mechanically. The suspected third writer (`check-workflow-supply-chain.mjs`) has no write calls, and `check-dockerignore-secrets.sh`'s probe paths are string literals, not files. The two-writer claim held, but is now auditable (R42).

**F10 (Minor)** — Consumer B note was inaccurate: a basename-preserving `.sh`→`.mjs` port *keeps* the self-test binding; the real hazard is leaving the `.sh` as a wrapper. **Resolution**: corrected; `C1-AC7` machine-checks it.

**F11 (Minor, [Adjacent])** — `C2-AC2`'s "not last" red-proof is too weak to catch mis-attribution. **Resolution**: folded into the strengthened `C2-AC2` (see T6).

## Security Findings

**S1 (Critical, escalate: true)** — C1's verification is a vacuous oracle; counter-example built and verified (see Headline outcome). Impact: check 6 is the tripwire catching *new, unmarked* privileged call sites for already-covered ids; a narrowing silently stops enforcing step-up reauth in CI as well as locally, and stays green forever. **Resolution**: `C1-AC5` (decision-trace over ~10,150 pairs) and `C1-AC6` (one mutant per narrowable dimension, corpus code-derived per R42) promoted from escalation-only to **mandatory on every path**; the retracted "zero-line diff is strong evidence" claim is explicitly marked retracted in the plan.

**S2 (Critical, escalate: false)** — The specified join phase aborts under the harness's own `set -euo pipefail` (`pre-pr.sh:4`). Orchestrator-verified: `SCRIPT EXIT=7` with steps 1–2 never joined and no Results block. Not fail-open (CI still reds), but it **truncates the gate run** — every check after the first failure is never evaluated, so fixing one gate can reveal a second previously-unreported violation with no sign the set was cut short. **Resolution**: `set -e`-safe capture (`if wait …; then ec=0; else ec=$?; fi`) mandated with the probe recorded; `C2-AC10` added.

**S3 (Major)** — Restates F1 from the security angle (mis-attribution as R44 fail-open). Merged with F1.

**S4 (Major)** — No criterion pins the executed **step set**. A silently un-dispatched gate lowers both the set and the count consistently, so count-vs-count cannot detect it — any of ~40 guards could stop running while the harness reports all-green. **Resolution**: `C2-AC8` added (label set-equality against a checked-in manifest, failing in both directions).

**S5 (Major)** — `PRE_PR_JOBS` unvalidated: `0` blocks forever, huge values oversubscribe (NFR2 unenforced). CI never sets it, so this is developer-robustness. **Resolution**: clamping mandated; `C2-AC11` added.

**S6 (Major)** — The step-up gate honors five path overrides plus a window override with **no CI guard**; its comment merely assumes "Production CI uses the defaults". Pointing `STEPUP_CLIENT_GUARD_CLIENT_DIR` at an empty dir greens it entirely. The sibling `check-gate-selftest-coverage.sh:63-70` already implements the needed `ENV_POLLUTION_GUARD`, making this gate the outlier. **Resolution**: new contract **C4** folds the guard into C1, with a red-proven self-test.

**S7 (Minor)** — `C1-AC4` counted only `grep` spawns; converting `grep`→`awk` would satisfy it. **Resolution**: counts all spawn types; demoted to diagnostic.

**S8 (Minor)** — Escalation re-binds Consumer B with no criterion. **Resolution**: `C1-AC7`.

**S9 (Minor, [Adjacent])** — SC2 defers a *known repeat member* of the R45 class on a percentage basis. **Resolution**: deferral now carries a concrete re-measure trigger (>15 s, or manifest growth >1.5×).

## Testing Findings

**T1 (Critical)** — `C1-AC2` measured vacuous (0 bytes). Converges with S1. **Resolution**: as S1.

**T2 (Critical)** — The oracle's **call-site × manifest-id cross-product is empty**: no fixture has two ids that can both reach one call site, so every check-6 execution in the suite iterates a manifest of cardinality 1. Cross-contamination between ids or files — the exact bug class hoisting introduces — is unobservable. **Resolution**: `C1-AC0` multi-id and multi-file fixtures.

**T3 (Critical)** — The token word-boundary rule and ERE escaping are untested, yet **12 genuine prefix pairs exist in the live manifest** (e.g. `apiPath.tenantBreakglass` / `…ById`). A rewrite mis-implementing the boundary as a full-word anchor *narrows* matching (fail-open) and passes all 30 cases. **Resolution**: `C1-AC0` fixtures using a real live prefix pair, plus an escaping fixture (`API_PATH.WIDGETS` vs `API_PATHxWIDGETS`).

**T4 (Major)** — Plan claimed 5 `UNMARKED_CALLSITE_CANDIDATE` assertions. Orchestrator-verified: 5 raw occurrences, but 1 is a header comment and 1 asserts the *pass* path — so **3 failure assertions**, two sharing a fixture shape. **Resolution**: corrected in `C1-AC1`, which is now explicitly a floor rather than the oracle.

**T5 (Major)** — Three hot-loop branches have no fixture: exempt-id skip (`:512`), comment-prefix skip (`:491-494`), and window edges (all 20 fixture call sites are single-line, so `+3`/`+10`/`-3` bounds are never probed). **Resolution**: `C1-AC0`.

**T6 (Major)** — `C2-AC2`/`AC3` under-specified: "not last" is under-constrained under bounded concurrency; a single failure cannot observe `failures[]` ordering; "prints its context" is not an assertion (three distinct `show_failure_context` branches); no stdout volume pinned, though the truncation regression needs >64 KiB. **Resolution**: both criteria rewritten with concrete shapes (≥2 non-adjacent failures, fast-fail-early + slow-after, named context branch, ≥1 MB stdout + stderr markers).

**T7 (Major, RT4)** — **C2's entire acceptance set is unfalsifiable**: since C1 alone meets the wall-clock target, C2 could be a complete no-op and `C2-AC1/AC4/AC5` would still be green. A dispatcher that silently degenerates to serial passes everything. **Resolution**: `C2-AC9` observes peak overlap directly (≥2 and ≤`PRE_PR_JOBS`), which also pins NFR2 for the first time.

**T8 (Major)** — No self-test for `run_step`, and the gap is structural: `check-gate-selftest-coverage.sh` enumerates `scripts/checks/*` only, so the harness is never a member; existing pre-pr tests explicitly refuse to spawn the script. Eight fail-open-annotated invariants on the runner of all 40 gates, with zero enforcement. **Resolution**: new contract **C3** (harness self-test), with the extractability decision flagged as a **design-time** prerequisite (RT2), plus adding the harness to the meta-gate member set (R42).

**T9 (Major)** — "Unchanged and green" conflates *edit* with *extend*; sound as a floor, unsound as sufficiency. **Resolution**: testing strategy restated as sequenced extend-then-freeze, with each new case required green-on-current and red-on-narrowed-copy (RT7).

**T10 / T11 / T12 (Minor)** — spawn-count proxy, missing measurement protocol, missing Consumer B criterion. **Resolution**: all folded into `C1-AC3`/`C1-AC4`/`C1-AC7`.

**T13 (Minor, [Adjacent])** — `PRE_PR_JOBS` boundary values. Merged with S5 → `C2-AC11`.

## Adjacent Findings

- F11 → merged into `C2-AC2` (testing scope)
- S9 → SC2 re-measure trigger (functionality scope)
- T13 → merged into S5 / `C2-AC11` (security scope)

## Quality Warnings

One reviewer claim was **not** confirmed and was rejected rather than adopted: F9's suspected third temp-writer (`check-workflow-supply-chain.mjs`) has no write calls at all. The completeness *concern* was still valid, so the member set was re-derived mechanically — but no false entry was added. Similarly, a reviewer's "49 manifest ids" was off by one (verified: 50), and the same reviewer's claim that `wait <pid>` returns 127 after `wait -n` was refuted by probe.

## Resolution summary

| Severity | Count | Status |
|---|---|---|
| Critical | 5 (F1, F2, S1/T1, S2, T2, T3 — S1/T1 converged) | all resolved in plan |
| Major | 13 | all resolved in plan |
| Minor | 8 | all resolved in plan |

Plan grew from 2 contracts to 5 (C1-AC0 prerequisite, C1, C2, C3 harness self-test, C4 env guard), from 11 to 24 acceptance criteria, and from 6 to 8 invariants. Implementation order: **C1-AC0 → C1 (+C4) → C2 (+C3)**.

## Recurring Issue Check

### Functionality expert
R1 pass · R2 pass · R3 **fail** (F6, F7) · R4 n-a · R5 n-a · R6 n-a · R7 n-a · R8 n-a · R9 n-a · R10 n-a · R11 n-a · R12 n-a · R13 n-a · R14 n-a · R15 n-a · R16 **fail** (F6, F8) · R17 n-a · R18 n-a · R19 n-a · R20 n-a · R21 n-a · R22 n-a · R23 n-a · R24 n-a · R25 n-a · R26 n-a · R27 n-a · R28 n-a · R29 n-a · R30 n-a · R31 n-a · R32 pass · R33 pass · R34 n-a · R35 n-a · R36 n-a · R37 n-a · R38 n-a · R39 n-a · R40 n-a · R41 n-a · R42 **fail** (F5, F9) · R43 n-a · R44 **fail** (F1, F2, F3) · R45 pass · R46 n-a

### Security expert
R1 pass · R2 pass · R3 **fail** (S1) · R4-R41 pass/n-a · R42 **fail** (S4, S1) · R43 pass · R44 **fail** (S2, S3) · R45 **fail** (S9) · R46 pass
RS1 pass · RS2 pass · RS3 **fail** (S1 — mutation-proof was escalation-only, so the bash path shipped with no red-proof) · RS4 pass · RS5 pass · RS6 pass

### Testing expert
R1-R41 pass (R35 n-a) · R42 **fail** (T8) · R43 pass · R44 pass · R45 pass · R46 pass
RT1 pass · RT2 **fail** (T8 — monolithic harness untestable; extraction is design-time) · RT3 pass · RT4 **fail** (T7) · RT5 pass · RT6 pass · RT7 **fail** (T1, T2, T3, T5) · RT8 **fail** (T5 — exempt-id and comment-prefix denial paths unexercised) · RT9 pass

## Next round

All findings are reflected in `pre-pr-parallelization-plan.md`. Round 2 should verify the plan edits are correct and complete, focusing on: the rewritten C2 scheduling section, the C1-AC0 fixture list's coverage of the C1-AC6 mutant dimensions, and whether C3's extractability requirement is specified concretely enough to implement.
