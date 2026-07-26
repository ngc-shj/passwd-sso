# Plan: pre-pr-parallelization

Speed up `scripts/pre-pr.sh` without removing or weakening a single check.

## Project context

- **Type**: mixed (web app + CLI + extension + iOS; this change targets the repo's local/CI verification tooling — bash + node gate scripts)
- **Test infrastructure**: unit + integration + E2E + CI/CD. Gate scripts have their own self-test suite under `scripts/__tests__/*.test.mjs` (vitest), enforced for coverage by `check-gate-selftest-coverage.sh`.
- **Verification environment constraints**:
  - `VC1` — `Test` / `Build` / `Integration tests` / `CLI` / `Extension` steps are heavy and mutually exclusive with a concurrently running `pre-pr.sh`. During plan authoring a second `pre-pr.sh` was running in another session, so these steps were **not** re-timed locally. Classification: `verifiable-local` (deferred to an idle machine), not blocked. Their timings are taken from the script's own structure, not measured, and no contract below depends on their exact duration.
  - `VC2` — `Static: rls-cross-tenant SQL parse` requires a running local docker Postgres (`passwd-sso-db-1`). Absent it, the step self-skips. Classification: `verifiable-local` (requires `npm run docker:up`).
  - `VC3` — `Secret scan (gitleaks)` behavior depends on which gitleaks generation is installed, and the R35 manual-test / refactor-verify gates are branch-state dependent (only fire on `refactor/*` or admin-IA diffs). Classification: `verifiable-local` under constructed branch states.

## Objective

Reduce `scripts/pre-pr.sh` wall-clock time while preserving **exactly** the current set of checks and their pass/fail semantics.

Non-goal: removing, sampling, or making any check conditional to save time.

## Measured baseline (2026-07-26, 20-core machine)

Static checks only (the `PRE_PR_STATIC_ONLY=1` surface, which is also what CI's `static-checks` job runs):

| Step | Time |
|---|---|
| `Static: step-up-client-coverage` | **171.01 s** |
| `Static: fail-closed-routes-have-test` | 9.82 s |
| `Static: api-error-codes` | 1.26 s |
| `Static: session-token-hashed` | 1.07 s |
| `Static: bound-unknown-ip` | 0.99 s |
| `Static: destructive-wrapper-derivation` | 0.95 s |
| `Static: null-tenant-fail-closed` | 0.73 s |
| `Static: cosign-kms-uri` | 0.68 s |
| `Static: critical-audit-atomic` | 0.66 s |
| remaining ~30 static checks | < 0.4 s each, ≈ 2 s total |
| **Total static** | **≈ 187 s** |

**One check is 91% of the static phase.** Root cause, measured: `check-step-up-client-coverage.sh` spawns **66,176 processes** in a single run (`bash -x … | grep -c '^+* grep'`). Its final loop is O(call-sites × manifest-ids) = **203 × 50 ≈ 10,150 iterations** (call sites counted over the gate's own `CLIENT_DIR="$REPO_ROOT/src"` scope, `:109`), and each iteration spawns 4–6 short-lived `awk`/`grep`/`sed`/`wc` processes. The script's own comment at the `file_marker_ids` line concedes the tradeoff — *"cache per file would be an optimization; correctness first — re-grep is cheap at this file count"* — an assumption that no longer holds at this cardinality.

This is R45 (repo-wide gate scaling super-linearly with the scanned set).

**Consequence for the original request**: parallelism alone cannot fix this. A 171 s serial step is a hard floor — parallelizing everything else yields 187 s → 171 s (≈9%). The hotspot must be fixed for parallelism to have anything to work with.

**Precedent in-repo**: `check-fail-closed-routes-have-test.sh` had this identical defect and was already fixed — its comments at lines 428 and 467-468 record collapsing ~65 per-line `node` spawns into one batched call, worth ~13 s. C1 applies that same proven transformation.

## Requirements

### Functional
- FR1 — The set of executed checks is identical before and after. No check removed, skipped, sampled, or made conditional.
- FR2 — Pass/fail outcome is identical for every check, on both green and red inputs.
- FR3 — `PRE_PR_STATIC_ONLY=1` (CI `static-checks` job, `.github/workflows/ci.yml:228`) keeps identical semantics. R33: this script is the single definition shared by the local hook and CI; a local-only speedup that changes CI behavior is a defect.
- FR4 — Failure output remains diff-comparable: steps are reported in the current script order with the current `show_failure_context` formatting, regardless of completion order.
- FR5 — Existing escape hatches (`PRE_PR_FORCE_FULL`, `PREPR_SKIP_INTEGRATION`, `RUN_WEB` auto-skip, docker/gitleaks self-skips) keep working.

### Non-functional
- NFR1 — Static phase wall-clock, **measured on the 20-core dev machine**, ≤ 15 s (from 187 s). The floor is set by the slowest single remaining step, since parallelism cannot beat `max(step)`: after C1 that is `fail-closed-routes-have-test` at 9.82 s (deliberately out of scope, `SC2`), so ≤10 s would leave ~0.2 s for the other ~35 checks plus scheduler overhead — not achievable. On a 2-core CI runner the two heaviest steps serialize against each other, so **CI's expectation is ≈20 s, not 15 s**; C2-AC1 is asserted against the dev machine only and CI is measured separately (SC3). Both figures are a ~10× improvement over today's 187 s.
- NFR2 — Bounded concurrency; must not oversubscribe or exhaust file descriptors on a smaller machine (CI runners are 2–4 core, not 20).
- NFR3 — No new required tooling. GNU `parallel` is **not** installed and must not become a dependency; use bash job control.

## Technical approach

Two independent changes, in this order (C1 first — it is the 91%, and it is independently valuable even if C2 were abandoned).

### C1 — De-spawn the hotspot (`check-step-up-client-coverage.sh`)

Replace per-iteration process spawns with a single pre-pass, keeping the matching logic byte-identical in intent:

1. **Hoist manifest parsing out of the inner loop.** `manifest_line_for`, `method`, and `tokens_raw` are recomputed for all 50 ids at every one of the 203 call sites, though they depend **only on the id**. Parse the manifest **once** into indexed shell arrays before the outer loop (indexed, not associative — see the bash-3.2 constraint below).

2. **Respect the two distinct scopes — do NOT collapse them.** The four window variables are *not* all per-file, and treating them as such silently widens matching:

   | Variable | Line | True scope | Hoist to |
   |---|---|---|---|
   | `file_marker_ids` | :498 | per **file** | per-file (safe to hoist) |
   | `arg_window` | :501 | per **call site** (`l .. l+3`) | must stay per-call-site |
   | `opt_window` | :502 | per **call site** (`l .. l+10`) | must stay per-call-site |
   | `suppress_window` | :545 | per **call site** (`l-3 .. l`) | must stay per-call-site |

   Only `file_marker_ids` is file-scoped. Hoisting `arg_window` to per-file scope would widen its window from 4 lines to the whole file, making unrelated tokens match — a semantic change in the *false-positive* direction that violates FR2. The correct transformation is: read each file's lines **once** into an indexed array, then slice each call site's window from memory, preserving the exact `l..l+3` / `l..l+10` / `l-3..l` bounds. The win comes from eliminating repeated `awk`/`grep` **spawns**, not from widening scope.

3. **Short-circuit ordering preserved.** The existing cheap-first ordering (method check before token scan) is retained so that no additional work is performed.

**Constraint — C1 changes performance only.** The comparison semantics (word-boundary token matching, ERE escaping, comment-prefix skip, suppression reason ≥10 chars, exempt-id skip) are preserved exactly. Any change to *what* the gate flags is out of scope for this plan.

**Optional escalation**: if a faithful bash rewrite proves unreadable, port the loop to a `.mjs` gate (the repo already prefers this — `check-destructive-wrapper-derivation.mjs`, `check-null-tenant-fail-closed.mjs` are node-based and run < 1 s). Decision deferred to implementation.

**Escalation is NOT gated on C1-AC1 alone.** A bash→Node port re-implements locale-sensitive `grep -E` / `sed -E` / `awk` semantics in a different regex engine (ERE vs. JS `RegExp`): character-class behavior, `\b` vs. the hand-rolled `([^A-Za-z0-9_]|$)` boundary, greedy/lazy differences, and `LC_ALL`-dependent collation all differ in ways a 30-case suite passing green cannot rule out. A port that silently *narrows* matching turns a security gate fail-open while every test stays green. The escalation path therefore carries an additional, stricter gate:

C1-AC5 (decision-trace differential) and C1-AC6 (per-dimension mutation-proof) were originally scoped to this escalation path only. **They are now mandatory for every C1 path** — see the Acceptance criteria, where they became the primary oracle after the original criteria were empirically defeated. The escalation path additionally carries the JS-vs-ERE regex-equivalence burden described above.

If the escalation criteria prove impractical, the bash-optimization path (hoisting + single-read) is preferred, since it leaves the regex engine and locale semantics untouched by construction — the transformation is *where* the comparison runs, not *how* it compares.

### C2 — Bounded-parallel `run_step`

Add opt-out-able job-parallel execution to `pre-pr.sh` for the **independent** static checks:

- Each step runs as a background job writing to its own `mktemp` logfile (the script already allocates one logfile per step — this structure is already parallel-ready).
- Concurrency capped at `min(nproc, 8)` by default, overridable via `PRE_PR_JOBS`. `PRE_PR_JOBS=1` restores today's fully-serial behavior as an escape hatch. **`PRE_PR_JOBS` is untrusted input and MUST be clamped**: non-numeric → default; floor 1; cap `min(nproc, 8)`. Unvalidated, `PRE_PR_JOBS=0` makes the slot check (`active >= 0`) block forever or degenerate, and a huge value oversubscribes/exhausts file descriptors (NFR2). Fail closed to serial on anything unparseable rather than to unbounded. CI never sets it (verified: `ci.yml:228` passes only `PRE_PR_STATIC_ONLY=1`), so this is developer-robustness, not a CI bypass — but a mid-run hang reads as "flaky, push anyway", which is its own hazard.
- Results are **buffered and replayed in script-declaration order** (user-selected), so `passed`/`failed`/`failures[]` accumulate deterministically and `show_failure_context` output is unchanged.

**Scheduling / synchronization mechanism (explicit — no implicit races):**

The naive "background everything, then read the logs" shape has two failure modes: reading a logfile before its writer finished (truncated context), and collecting status in completion order (nondeterministic counts). The design pins both:

1. **Enqueue phase.** `run_step` no longer executes; it appends `(label, cmd…)` to an ordered `steps[]` array and pre-allocates that step's logfile, registering it in `tempfiles[]` **before** any job starts (satisfies I5 — the `EXIT` trap can clean up even on Ctrl-C mid-run).
2. **Dispatch phase.** A scheduler walks `steps[]` in order, launching each as a background job with its stdout **and stderr** redirected to that step's own logfile (`> "$log" 2>&1` — no `tee`, no shared pipe, so no interleaving and no `PIPESTATUS` masking). It blocks while `active_jobs >= PRE_PR_JOBS` using `wait -n`, launching the next only as a slot frees. **`wait -n`'s return value is used purely as a throttle signal and MUST be discarded** (`wait -n || true`) — see the mis-attribution proof below.
3. **Join phase.** Each launched job's PID is recorded in `pid[i]` alongside its index. After dispatch, the scheduler reads step *i*'s exit status **per index, in declaration order**. Bare `wait` is a forbidden pattern (see below).

   **The join MUST be `set -e`-safe — red-proven abort otherwise.** `scripts/pre-pr.sh:4` sets `set -euo pipefail` for the whole script, so a bare `wait "${pid[i]}"` returning non-zero is an uncaught failing command that **terminates the script on the spot**. Probe (bash 5.2.21, 2026-07-26): three jobs exiting `0,7,0` joined with a bare per-index `wait` printed `step0 joined ok` and then died with `SCRIPT EXIT=7` — steps 1 and 2 were never joined, the replay never ran, and the `═══ Results ═══` / `═══ Failure Context ═══` blocks never printed. CI still goes red, so this is not fail-open, but it **truncates the gate run**: every check after the first failure is silently never evaluated or reported, so fixing one gate can reveal a second previously-unreported violation with no indication the set was cut short. Violates FR4 and I3.

   Required shape — capture the status through an `if` condition (exempt from `set -e`), or bracket the join in `set +e … set -e` exactly as today's `run_step` already does at `scripts/pre-pr.sh:137-140`:

   ```bash
   if wait "${pid[i]}"; then ec=0; else ec=$?; fi
   ```

   **`wait -n` status capture is FORBIDDEN — red-proven mis-attribution** (bash 5.2.21, probe run 2026-07-26). `wait -n` returns *a* status but does not identify *which* job produced it, so assigning it to the dispatch loop's current index blames the wrong step. Probe: three jobs launched in declaration order as `(slow,ok) (slow,ok) (fast,FAIL 7)`; capturing at `wait -n` time yielded **`7 0 0`** against a declaration-order truth of `0 0 7` — the *failing* step reported as passing and an innocent step marked failed. In a security-gate harness that is a fail-open (red gate reports green). The per-index join on the same input yielded exactly `0 0 7`.

   The per-index join is safe even for jobs already reaped by the throttle: bash retains the exit status of an explicitly-tracked PID. Probe: 5 jobs exiting `0,7,0,9,0` under a `JOBS=2` `wait -n` throttle, joined per-index afterwards, yielded exactly `0 7 0 9 0`. Implementation MUST re-run both probes if the target bash differs, since reaped-child status retention is bash-specific, not POSIX-guaranteed.

   **Status 127 is never a control signal.** A step whose command is missing (`node` absent, `bash -c` "command not found") exits 127, which is indistinguishable from `wait`'s "no such job" return. The scheduler MUST treat every `wait` return value as the step's own status and never branch on 127 as a bookkeeping artifact — otherwise a broken/missing check script is silently reclassified as "not a real failure", which is precisely the environment-drift case a static-gate harness must catch. Every PID is `wait`ed exactly once, from the join phase, unconditionally.

   Note the related hazard the probe also confirmed: **a backgrounded job cannot mutate the parent shell's variables** (`{ passed=$((passed+1)); } &` leaves `passed=0`). This is precisely why counters are accumulated in the replay phase in the parent shell, never inside the job. See I7.
4. **Replay phase.** Only after a step's status is known and its writer has exited is its logfile read and its result printed. Replay walks `steps[]` in declaration order, so `passed`/`failed`/`failures[]` accumulate identically to today regardless of completion order (I3).

Because every job owns a private logfile and nothing writes to a shared stream, there is no output interleaving to serialize against — the ordering guarantee comes from the replay walk, not from constraining execution.

**Stream handling**: each step's stdout and stderr are merged into that step's own logfile (`2>&1`, matching today's `"$@" 2>&1 | tee "$logfile"` which also merges them). No stream is discarded. This matters because `show_failure_context` greps for markers such as `error TS[0-9]+` and `^Error:` that several checks emit on stderr — dropping or splitting stderr would silently blind the failure-context extractor.

**Parallel-safety audit (verified, not assumed):**

**Member-set derivation (R42 — mechanically derived, not asserted).** The writer set was re-derived over the 25 checks in the C2 window with:

```bash
grep -ln 'mktemp' scripts/checks/*.sh          # → check-api-error-body-drift.sh, check-worker-bundle-smoke.sh
grep -ln 'mkdtemp\|writeFileSync' scripts/checks/*.mjs   # → (none)
```

Result: exactly **two** writers, both `mktemp`-based. Two candidates were investigated and cleared: `check-workflow-supply-chain.mjs` has no write calls at all, and `check-dockerignore-secrets.sh`'s `__dockerignore_probe__` paths are **string literals** fed to a matcher, not files created on disk. Every other check in the window is a pure reader of the working tree.

| Concern | Finding |
|---|---|
| Shared temp state | Exactly two writers (derivation above); both use `mktemp -d`/`mktemp` (unique per process). Safe. |
| Repo-`dist/` writes | `check-worker-bundle-smoke.sh` rewrites the esbuild `--outfile` into its own `$TMP_DIR` (verified at its bundling block) — it does **not** write repo `dist/`. Safe. |
| Ordering dependence | The static checks are pure readers of the working tree. No step's input is another step's output. |
| Exit-status masking | `run_step` already reads `${PIPESTATUS[0]}`, not the `tee` status (R44-correct today). Backgrounding must preserve this — see C2-AC3. |

**C2 scope is a bounded window, not the whole script.** Parallel scheduling applies **only** to the contiguous run of pure `run_step` calls at `scripts/pre-pr.sh:158-184` (the 25 static checks that contain the entire measured hotspot). Everything from `:186` onward runs exactly as today, unchanged.

Rationale — the script contains **three** kinds of step, and only the first is enqueueable. Member-set derived mechanically (`grep -nE 'printf.*(skip|▸)|passed=\$\(\(|failed=\$\(\(|failures\+=' scripts/pre-pr.sh`), not by inspection:

| Kind | Sites | Enqueueable? |
|---|---|---|
| `run_step` calls | ~40 | yes |
| `printf`-only skip notices | `:187`, `:228`, `:460`, `:503`, `:535-536`, `:540-541` | **no** — emit output but never call `run_step` |
| Direct counter mutations outside `run_step` | `:478`/`:485-486` (gitleaks fallback), `:512-513`/`:516` (R35 manual-test gate), `:561-562` (CLI deps), `:571-572` (Extension deps) | **no** — mutate `passed`/`failed`/`failures[]` inline |

Under a whole-script enqueue/dispatch split, kinds 2 and 3 would execute at *enqueue* time and therefore print **before** every replayed step result, reordering output versus declaration order and violating FR4/I3. Restricting C2 to `:158-184` sidesteps this entire class: that window contains no conditional notices and no inline counter mutations, so enqueue-time evaluation is vacuous there.

**Explicitly serial (NOT parallelized) in C2:**
- Everything at `scripts/pre-pr.sh:186` and below — including all conditional/branch-guarded steps, the gitleaks secret scan, the R35 gate, and the Web steps. Recorded as `SC4`.
- `Test`, `Build`, `Integration tests`, `CLI: *`, `Extension: *` — heavy, memory-hungry, and mutually contending (`next build` and `vitest` each already parallelize internally). Making these concurrent risks OOM and flakiness for little gain. Recorded as `SC1`.
- `Test` is preceded by `rm -rf node_modules/.vitest` — a repo-global mutation that is unsafe to run beside other steps.

**Passing-step stdout is preserved.** Today `run_step` pipes through `tee` (`scripts/pre-pr.sh:138`), so a *passing* step's output reaches the terminal before its log is deleted at `:152`. Several gates print CI-auditable configuration on success — e.g. `check-gate-selftest-coverage.sh` echoes its resolved `CHECKS_DIR`/`TESTS_DIR`/`DEBT_FILE` paths, and `check-destructive-wrapper-derivation.mjs` echoes `SCAN_ROOT`/`EXEMPT_FILE`/`PATTERNS_FILE`. Dropping `tee` without compensation would silently delete these from both the terminal and CI logs. The replay phase MUST therefore emit each step's captured logfile — **pass and fail alike** — before printing its `✓`/`✗` line, reproducing today's total stdout modulo ordering.

## Contracts

### C1 — `check-step-up-client-coverage.sh` runs in ≤ 5 s with identical verdicts

- **Signature**: unchanged. Same path, same argv (none), same exit codes (`0` pass / `1` fail), same stdout marker strings (`UNMARKED_CALLSITE_CANDIDATE:`, `MANIFEST_ID_MISSING:`, etc.).
- **Invariants**:
  - `I1` (app-enforced) — For every input tree, the set of emitted finding lines is identical to the pre-change script's, as sets (order-insensitive within a file, since the outer iteration order is preserved anyway).
  - `I2` (app-enforced) — Process spawn count is O(files + ids), not O(files × ids).
- **Forbidden patterns** (the inner `while IFS= read -r mid` loop spawns 4–6 processes per iteration; forbidding only one of them permits a half-fix that still misses I2):
  - `pattern: grep -r` inside the call-site/id loop bodies — reason: reintroduces the per-iteration repo walk that is the defect.
  - `pattern: manifest_line_for` called inside the inner `mid` loop — reason: id-only data must be hoisted, not recomputed per call site.
  - `pattern: grep -oE '"method"` inside the inner `mid` loop — reason: `method` is id-only; the `printf | grep -oE | sed -E` chain is 3 spawns × 9,450 iterations.
  - `pattern: grep -oE '"pathTokens"` inside the inner `mid` loop — reason: same, `tokens_raw` is id-only; another 3 spawns per iteration.
  - `pattern: declare -A` anywhere in the rewritten script — reason: revokes the documented bash-3.2 guarantee (see Platform constraints).
  - `pattern: awk -v l=` inside the inner `mid` loop — reason: window extraction must come from the in-memory line array, not a fresh `awk` per iteration.
- **Acceptance criteria**:
  > **The original oracle was empirically defeated — these criteria replace it.** Two independent reviewers converged on this, and one built the counter-example: a single plausible C1-shaped optimization (merging `arg_window` `+3` and `opt_window` `+10` at `:501-502` into one `+3` read — literally what "read each client file once" invites) passed **30/30 self-tests AND produced a byte-identical differential**, while genuinely losing detection (a `"PUT"` literal at offset +6 stopped being flagged). Measured root cause: the gate emits **0 lines / 0 bytes on a clean tree**, so the old C1-AC2 was `diff /dev/null /dev/null` — it passes even for `exit 0 # optimized`. Any criterion that only observes a green tree is worthless here.

  - `C1-AC1` — `npx vitest run scripts/__tests__/check-step-up-client-coverage.test.mjs` passes. The suite is a **necessary floor, not the oracle**: it has **3** (not 5) `UNMARKED_CALLSITE_CANDIDATE` assertions, its call-site × id cross-product is empty (no fixture has two ids reaching one call site), and the word-boundary and ERE-escaping rules are untested. See C1-AC0.
  - `C1-AC0` (**prerequisite — lands BEFORE C1, as its own commit**) — Extend the suite to cover the rewrite's actual decision surface. Each new case must be **green against today's unmodified script** (proving it encodes current behavior) and **red against a scratchpad copy with the corresponding rule removed** (RT7 — proving it can fail). Required fixtures:
    - multi-id / one call site: two ids sharing a path token, differing method → assert only the method-matching id is flagged (pins the per-id `method`/`tokens_raw` pairing that hoisting scrambles).
    - multi-file: file A marked, file B unmarked, same path+method → assert only B flagged (pins the `file_marker_ids` per-file cache).
    - word boundary: use a **real** live-manifest prefix pair (e.g. `apiPath.tenantBreakglass` / `apiPath.tenantBreakglassById`; **12 such pairs exist on today's tree**) → assert only the correct id is named.
    - ERE escaping: token `API_PATH.WIDGETS` with a call line containing `API_PATHxWIDGETS` → must PASS (fails if the `.`-escaping at `:536` is dropped).
    - exempt-id skip (`:512`), comment-prefix skip (`:491-494`, both `//` and `*` forms), and window edges (token at `l+3` flags / `l+4` does not; `method:` at `l+10` / `l+11`; suppression at `l-3` / `l-4`).
  - `C1-AC2` — Differential on the real tree: stdout byte-identical before/after. **This proves only "no NEW findings appeared" — it is not evidence the matching set was preserved**, because both sides are empty. Retained as a cheap regression tripwire, never as the safety argument.
  - `C1-AC5` (**now REQUIRED for every C1 path, not escalation-only**) — Decision-trace differential: instrument both implementations to emit one line per `(call-site, id)` pair — `<file>:<line>\t<id>\t<matched|skipped-method|skipped-token|suppressed|exempt>` — and require the two streams byte-identical. This turns a 0-byte comparison into ~10,150 lines of real signal — **203** non-test `fetchApi(` call sites × **50** manifest ids on today's tree, re-verified against the gate's own `CLIENT_DIR="$REPO_ROOT/src"` scope (`:109`). (Two corrections: the plan's earlier "189" undercounted by scoping to a narrower path set; a reviewer's "49 ids" was off by one — the manifest has 50.) This is the primary oracle.
  - `C1-AC6` (**now REQUIRED for every C1 path, not escalation-only**) — Mutation-proof on a **scratchpad copy** (never the real source): one mutant per independently-narrowable dimension, each required to turn the gate **red**. Corpus derived from the code, not chosen ad hoc (R42): `arg_window` bound (+3), `opt_window` bound (+10), `suppress_window` bound (−3..0), word-boundary suffix (`:537`), ERE escaping (`:536`), comment-prefix skip (`:492-494`), exempt-id skip (`:512`), ≥10-char reason rule (`:550-551`), per-id `method` gating (`:520-524`). A dimension whose mutant leaves the gate green means that dimension is unverified — fix the corpus or the criterion before proceeding.
  - `C1-AC3` — Wall-clock ≤ 5 s (from 171 s), **best of 3 warm runs on the baseline machine**, measured as the baseline was. Non-blocking performance target, explicitly subordinate to the correctness criteria above: a slow-but-correct rewrite is not blocked, and a fast-but-narrowing one is never waved through.
  - `C1-AC4` — Spawn count drops from 66,176 to < 1,000, counting **all** spawn types (`grep -cE '^\++ (grep|awk|sed|wc|tr|cut|head|sort)'`), not only `grep` — otherwise converting `grep` spawns into `awk` spawns satisfies the criterion while leaving the O(files × ids) defect intact. Baseline command: `bash -x scripts/checks/check-step-up-client-coverage.sh 2>&1 >/dev/null | grep -oE "^\+* grep" | wc -l`. Diagnostic, not binding.
  - `C1-AC7` — `bash scripts/checks/check-gate-selftest-coverage.sh` exits 0 after the change (machine-checks the Consumer B binding rather than relying on remembering it).
- **Consumer-flow walkthrough**: this contract's output is consumed by exactly two readers.
  - Consumer A (`scripts/pre-pr.sh:166`) reads `{ exit code, stdout }` and uses the exit code to increment `passed`/`failed` and stdout as `show_failure_context` input. No shape change.
  - Consumer B (`scripts/checks/check-gate-selftest-coverage.sh`) enumerates `scripts/checks/*.sh` and `scripts/checks/*.mjs` and requires a sibling `scripts/__tests__/<basename>.test.mjs` (or a debt entry). C1's bash-optimization path keeps both filenames unchanged, so the binding holds trivially. For the escalation path: a `.sh` → `.mjs` port **preserves the basename**, so the sibling test path is still satisfied automatically — the earlier concern about the test filename needing to move was wrong. The real hazard is the opposite: if the port leaves the old `.sh` in place as a wrapper, **both** files get enumerated and the `.sh` needs its own test or debt entry. A port must therefore *delete* the `.sh`, not wrapper it.

### C2 — `pre-pr.sh` runs independent static checks concurrently, deterministic output

- **Signature**: `run_step <label> <cmd...>` keeps its current call signature at all ~40 existing call sites. Scheduling is internal.
- **Invariants**:
  - `I3` (app-enforced) — Reported step order equals script-declaration order, independent of completion order.
  - `I4` (app-enforced) — Every step's exit status is the direct return of `wait "${pid[i]}"` for that step's own job; **no pipeline may sit between the step command and its status** (R44). The parallel path has no `tee` and therefore no `PIPESTATUS` involvement — the redirect is `> "$log" 2>&1`. (The serial `PRE_PR_JOBS=1` path may keep today's `PIPESTATUS[0]` read if it reuses the existing code path; the two must not be conflated.)
  - `I8` (app-enforced) — Replay emits each step's captured logfile for **passing** steps too, not only failures. Today's `tee` streams passing-step stdout live; a capture-only design that prints logs solely on failure silently drops CI-auditable success output (verified emitters: `check-gate-selftest-coverage.sh`, `check-destructive-wrapper-derivation.mjs`).
  - `I5` (app-enforced) — Every backgrounded step's logfile is registered in `tempfiles[]` before the job starts, so the `EXIT` trap cleans up even on interrupt.
  - `I6` (app-enforced) — `PRE_PR_JOBS=1` produces behavior indistinguishable from today's serial script.
  - `I7` (app-enforced) — `passed`, `failed`, and `failures[]` are mutated **only in the parent shell during the replay phase**, never inside a backgrounded job. Verified hazard: a `cmd &` subshell's variable writes are discarded on exit, so a counter incremented inside a job silently stays 0 — which would under-report both passes and, critically, **failures**. This is a fail-open shape and is the most probable way a naive implementation breaks.
- **Forbidden patterns**:
  - `pattern: ^\s*wait\s*$` (bare `wait` with no job-status read) — reason: discards per-job exit status; a failing check would go green (R44, fail-open).
  - `pattern: | tee` in the new background path without a `PIPESTATUS` read — reason: same masking defect.
  - `pattern: status\[[^]]*\]=\$\?` (or any capture of `wait -n`'s status into a per-step slot) in the dispatch loop — reason: **red-proven fail-open**. `wait -n` does not identify which job it reaped, so its status lands on the wrong step: measured `7 0 0` against a truth of `0 0 7`, reporting the failing step as passed. Status is read only in the join phase via per-index `wait "${pid[i]}"`. `wait -n || true` as a pure throttle is the *correct* idiom here, not a defect.
  - `pattern: -eq 127` / `== 127` applied to a `wait` return value — reason: 127 is a legitimate step exit status (missing interpreter / command-not-found inside a `bash -c` gate). Branching on it as "no such job" reclassifies a broken check as a non-failure (fail-open on environment drift).
  - `pattern: 2>/dev/null` applied to a step's command in the dispatch path — reason: discards stderr that `show_failure_context` greps for (`^Error:`, `error TS[0-9]+`), blinding failure reporting.
- **Acceptance criteria**:
  - `C2-AC1` — Full green run on the 20-core dev machine: static wall-clock ≤ 15 s (see NFR1 for why not 10 s, and for the separate ≈20 s CI expectation); `Passed:` count equals today's count for the same tree.
  - `C2-AC6` — A step whose command does not exist (e.g. `run_step "probe" nonexistent-binary`, exit 127) is reported **failed**, not silently absorbed. Guards the 127-ambiguity fail-open.
  - `C2-AC7` — Passing-step stdout is preserved: a green run's total output contains the success-path config lines that `tee` emits today (e.g. `check-gate-selftest-coverage:` and `check-destructive-wrapper-derivation:` prefixed lines). Guards I8.
  - `C2-AC8` (**step-set integrity — fail-closed**) — The run emits its executed step **labels**, and they are asserted set-equal against a checked-in expected-labels manifest, failing on a difference in **either** direction. Rationale: a scheduler bug that silently fails to enqueue a step lowers the step set *and* the `Passed:` count consistently, so a count-vs-count comparison (C2-AC1) cannot detect it — an un-dispatched gate is indistinguishable from a passing one. Any of ~40 security guards could stop running while the harness reports all-green. This is the R42 completeness treatment the repo already applies in `check-gate-selftest-coverage.sh`, which derives its member set from two independent primitives for exactly this anti-evasion reason. Without C2-AC8, FR1 has no enforcement.
  - `C2-AC9` (**concurrency actually happened — RT4 vacuous-pass guard**) — Instrument the dispatcher (or a scratchpad harness copy) with N steps recording start/end timestamps; assert **observed peak overlap ≥ 2** and **≤ `PRE_PR_JOBS`**. Rationale: every other C2 criterion passes if the dispatcher silently degenerates to serial — and since C1 alone already brings static under the NFR1 target, **C2 could be a complete no-op and C2-AC1/AC4/AC5 would all still be green**. This criterion also pins NFR2 (no oversubscription), which otherwise has no criterion at all.
  - `C2-AC10` (**no truncated gate run**) — With gate *k* failing and gates *k+1..n* passing, **all n steps are still reported** and the Results block renders. Guards the `set -e` join abort, which C2-AC2 alone can satisfy coincidentally on a single-failure run.
  - `C2-AC11` (**`PRE_PR_JOBS` input validation**) — `PRE_PR_JOBS` values `0`, `-1`, `abc`, and `99999` each resolve to a safe bounded value (clamped to `[1, min(nproc,8)]`, non-numeric → default) rather than hanging, forking unbounded, or erroring under `set -u`. CI never sets this variable (verified: `ci.yml:228` passes only `PRE_PR_STATIC_ONLY=1`), so this is a local-developer robustness guard — but an unclear hang mid-run is the kind of result a developer reads as "flaky, push anyway".
  - `C2-AC2` — Red-proof (RT7), on a scratch copy: the script exits 1, names the failing steps, and prints their context. A single not-last failure is **insufficient** — it can pass by luck even with the red-proven `wait -n` mis-attribution bug. The proof MUST use:
    - **≥2 failing steps with distinct non-zero exit codes** at **non-adjacent declaration indices** — `failures[]` ordering (I3) is only observable with two or more; a replay that appends in completion order looks correct with exactly one.
    - **a fast-failing step declared early with ≥2 slow steps declared after it**, so the failure is reaped by the throttle well before dispatch completes. "Not last in declaration order" is under-constrained under bounded concurrency — a step that happens to finish last satisfies it while exercising nothing.
    - **a named expected `show_failure_context` output path.** That function has three distinct branches (`pre-pr.sh:109-113` vitest anchor, `:115-117` marker fallback, `:121` `tail -20`); the injected failure must be shaped to hit a specific one and the assertion must name expected content — otherwise the criterion passes on the `tail -20` path even if marker extraction broke entirely.
  - `C2-AC3` — Exit-status fidelity under output pressure: a step emitting **≥1 MB to stdout and ≥100 lines to stderr** before exiting 1 is still reported failed. Volume is pinned deliberately — the `tee` → redirect change alters buffering, and the regression it guards (a truncated/partially-flushed logfile when a job is reaped with output still buffered) only reproduces past the 64 KiB pipe buffer. Assert: (a) status 1 reported, (b) the logfile's **last** line appears in the replay (proves no truncation), (c) a stderr marker such as `^Error:` reaches `show_failure_context` (proves the `2>&1` merge preserved what the extractor greps for).
  - `C2-AC3` — Exit-status fidelity: a step whose command fails *while writing stdout* is still reported failed (guards the `tee`/`PIPESTATUS` masking regression).
  - `C2-AC4` — `PRE_PR_JOBS=1` run reports the identical step list and result as the parallel run.
  - `C2-AC5` — `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` (CI's invocation) passes with identical step set (FR3/R33).
- **Consumer-flow walkthrough**:
  - Consumer A (`.github/workflows/ci.yml:228`, `static-checks` job) reads `{ exit code, stdout }` of `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`. It uses only the exit code to pass/fail the job and stdout for the log. C2 preserves both. It does **not** parse individual step lines, so the buffered-replay change is invisible to it.
  - Consumer B (developer running `npm run pre-pr`) reads the terminal output — the `▸ label` / `✓`/`✗` lines and the `═══ Failure Context ═══` block. FR4 + I3 keep this diff-comparable to today.
  - Consumer C (`package.json` `pre-pr` script) reads `{ exit code }` only.

## Go/No-Go Gate

Implementation order is **C1-AC0 → C1 (+C4) → C2 (+C3)**. C1-AC0 is a hard prerequisite: without the extended fixtures, C1 has no working oracle.

| ID | Subject | Status |
|----|---------|--------|
| C1-AC0 | Extend step-up self-test to cover the rewrite's decision surface (prerequisite, own commit) | locked |
| C1 | De-spawn `check-step-up-client-coverage.sh` (171 s → ≤5 s), verdicts identical | locked |
| C2 | Bounded-parallel `run_step` over `pre-pr.sh:158-184`, declaration-order buffered output | locked |
| C3 | Harness self-test for the scheduler (requires C2 extractability decision) | locked |
| C4 | `ENV_POLLUTION_GUARD` on the step-up gate's path overrides (folded into C1) | locked |

### C3 — Harness self-test for the parallel scheduler

C2 declares eight machine-checkable invariants (I3–I8) and six forbidden patterns, several annotated *fail-open*, on the harness that runs all ~40 security gates. Today that harness has **zero** automated enforcement, and the gap is structural, not accidental:

- `check-gate-selftest-coverage.sh` enumerates `scripts/checks/*.sh` + `*.mjs` (`:123`) — `scripts/pre-pr.sh` is the *harness*, never a member. The repo's own RT7 meta-gate is blind to the one file C2 rewrites.
- The two existing pre-pr tests do not touch `run_step`: `pre-pr-env-drift.test.mjs:4` explicitly refuses to spawn the script ("it would recursively invoke vitest") and settles for a source-text grep.

Every gate under `scripts/checks/` carries a self-test precisely because *"a gate with a broken regex/parse path can silently green forever"*. The harness running all of them has a strictly larger blast radius, so a self-test is proportionate.

- **Signature**: `scripts/__tests__/pre-pr-run-step.test.mjs`, driving the scheduler with an **injected fixture step list** — not the real 40-gate list (avoids the vitest-recursion problem that blocked the existing tests).
- **Testability is a design-time prerequisite (RT2)**: a monolithic `pre-pr.sh` is untestable by construction. C2 MUST therefore either extract the scheduler into a sourceable `scripts/lib/run-steps.sh`, or support an env-injected step list — mirroring the `STEPUP_CLIENT_GUARD_*` fixture-override idiom already used in this repo. **Decide this while designing C2, not after.**
- **Acceptance criteria**: `C3-AC1` — cases covering I3 (declaration-order replay with 2 non-adjacent failures), I4 (status fidelity under ≥1 MB stdout), I6 (`PRE_PR_JOBS=1` equivalence), I7 (counters survive backgrounding), C2-AC9 (observed overlap), C2-AC11 (`PRE_PR_JOBS` boundary values). `C3-AC2` — each forbidden pattern is red-proven: a fixture harness using bare `wait`, or capturing `wait -n`'s status, must make the suite **fail**. `C3-AC3` — add the extracted lib (or `pre-pr.sh`) to `check-gate-selftest-coverage.sh`'s member set, so the coverage cannot silently regress (R42: otherwise the class is closed for today's file but not the next harness change).

### C4 — Env-pollution guard on the step-up gate (security hardening, folded into C1)

`check-step-up-client-coverage.sh:108-112` honors five path overrides (`STEPUP_CLIENT_GUARD_API_DIR/CLIENT_DIR/PATH_ROOT/EXEMPT_FILE/PATHS_FILE`) plus `STEPUP_CLIENT_GUARD_WINDOW` (`:119`) with **no CI guard** — its comment at `:107` merely *assumes* "Production CI uses the defaults". Pointing `STEPUP_CLIENT_GUARD_CLIENT_DIR` at an empty directory greens the gate completely; `STEPUP_CLIENT_GUARD_WINDOW=0` disables the adjacency check.

The sibling `check-gate-selftest-coverage.sh:63-70` already implements exactly the needed guard (`ENV_POLLUTION_GUARD`), so this gate is the outlier and the pattern is established in-repo. C1 is the moment this file is rewritten and re-reviewed — the cheap time to close it.

- **Acceptance criteria**: `C4-AC1` — under `CI=true`, any `STEPUP_CLIENT_GUARD_*` override without an explicit `STEPUP_CLIENT_GUARD_FIXTURE_MODE=1` acknowledgement exits 1 with an `ENV_POLLUTION_GUARD:` message. `C4-AC2` — a self-test case covers it (the existing suite has none), red-proven.

## Testing strategy

- **C1 — "unchanged and green" is a floor, not a sufficiency proof.** The original strategy ("the suite must stay green unchanged; a self-test edit would itself be a red flag") is sound in one half and unsound in the other, and the distinction is what let the vacuous oracle through. Restated as a sequenced two-part rule:
  1. **Before C1 lands (separate commit): EXTEND.** Add the C1-AC0 fixtures. Each must be green against today's unmodified script (it encodes current behavior) and red against a scratchpad copy with the relevant rule removed (RT7). Extending is the *opposite* of the red flag: a case red-proven against a narrowed copy is by construction a behavior-preservation assertion that did not previously exist. This step is independently valuable and low-risk, so it can merge even if C1 is later deferred.
  2. **During C1: FREEZE.** The now-extended suite is frozen. **Editing** an existing case — loosening an assertion, changing an expected string — is exactly the red flag the original strategy described. Forbid it.

  "Unchanged and green" is sufficient only if the suite's coverage is a superset of the rewrite's decision surface. It is not: the call-site × id cross-product is empty, the word-boundary rule is untested against 12 live prefix-pairs, and three loop branches (exempt-id skip, comment-prefix skip, window edges) have no fixture. C1-AC5 (decision-trace) and C1-AC6 (per-dimension mutation-proof) carry the actual safety argument.
- **C2**: red-proof per C2-AC2 on a **scratchpad copy** of the script, never by mutating the real gate (per prior guidance on mutation-proofs). Serial-equivalence via C2-AC4.
- **Regression surface**: run the full `npx vitest run scripts/__tests__/` gate-script suite, since C2 touches the harness those gates run under.

## Considerations & constraints

- `SC1` — Heavy Web steps (`Test`, `Build`, `Integration`, `CLI`, `Extension`) stay serial. Deferred deliberately (memory contention + internal parallelism already present). Owner: a future plan if their wall-clock becomes the dominant term after C1/C2 land.
- `SC2` — `check-fail-closed-routes-have-test.sh` (9.8 s, 479 spawns) is the next hotspot after C1, and is explicitly recorded as **a known repeat member of the R45 scaling class** (plan §Measured baseline notes it already had this identical defect fixed once before). Deferring on a percentage basis alone would be R42-incomplete, so the deferral carries a concrete re-measure trigger rather than a vague "later": re-open when *either* its wall-clock exceeds 15 s *or* the fail-closed manifest grows past ~1.5× its current route count. Not fail-open today; it is a scaling-tail risk. Note it also sets the NFR1 floor (see NFR1), so pulling it into scope is the single change that would move the target below ~10 s.
- `SC3` — CI runner core count (2–4) is much lower than the 20-core dev machine, so CI's realized speedup from C2 will be proportionally smaller. NFR2's cap exists so CI does not oversubscribe. Not a defect; recorded so the measured-on-dev numbers are not mistaken for CI numbers.

### Platform / runner constraints (verified)

- **bash version — DECIDED: keep bash 3.2 compatibility; `declare -A` is forbidden in C1.** The `static-checks` job runs on `ubuntu-latest` (`.github/workflows/ci.yml:165`), i.e. bash 5.x, and the only `macos-latest` job (`ci.yml:344`, iOS) does not invoke `pre-pr.sh` — so bash-4 features would be safe *in CI*. That is not sufficient grounds to adopt them, because **the script C1 rewrites documents the bash-3.2 constraint as a deliberate design decision, twice**: `check-step-up-client-coverage.sh:154` ("3.2 has no associative arrays — keep parallel newline-delimited lists") and `:203-204` ("bash 3.2 has no associative arrays — same idiom as EXEMPT_MARKERS"). The SC2 sibling repeats it at `check-fail-closed-routes-have-test.sh:84`, `:122`, `:477-478`. No script under `scripts/checks/` uses `declare -A` today.

  A performance refactor is not a licence to silently revoke a stated portability guarantee, and a developer on macOS running `npm run pre-pr` under Apple's stock `/bin/bash` 3.2 is a supported-looking path (`#!/usr/bin/env bash` resolves to system bash unless Homebrew's precedes it on PATH). C1 therefore hoists into **indexed arrays plus a built-once linear-scan index** — the idiom the file already uses via `manifest_line_for`. This costs nothing: the target is O(files + ids), and a linear scan over 50 ids is trivial. It also aligns with C1's own preference for the transformation that leaves semantics untouched by construction.

  Forbidden pattern for C1: `declare -A` — reason: revokes the documented bash-3.2 guarantee at `check-step-up-client-coverage.sh:154`; on bash 3.2 it degrades to a *silent wrong-results* path, not a clean error. If a future decision does raise the floor, it must be made explicitly, propagate to the sibling scripts that document the same constraint (R3), and add a `BASH_VERSINFO` guard.
- **CI time budget.** `static-checks` declares `timeout-minutes: 8` (`ci.yml:166`). The current 187 s static phase already consumes ~39% of that budget on a fast machine; on a 2-core runner the 171 s hotspot is proportionally worse. This is the R45 exposure that makes C1 a correctness concern and not merely an ergonomics one — a gate that times out in CI does not run at all, which is fail-open. C1 removes that risk margin.
- **Risk — C1 is a logic-bearing rewrite of a security gate, and the obvious mitigations do not work.** The step-up coverage gate enforces that privileged client call sites carry step-up reauth. A refactor that silently narrows its matching is a fail-open regression.

  This risk was originally mitigated by "the 30-case suite plus a byte-identical differential — a zero-line diff over 189 × 50 pairs is strong evidence the matching set did not move." **That argument was empirically refuted during review and is retracted.** A reviewer built a narrowed gate (merging the `+3` and `+10` windows at `:501-502` — precisely what "read each client file once" invites) that passed **30/30 self-tests and produced a byte-identical differential** while genuinely losing detection. The gate emits **0 lines / 0 bytes on a clean tree**, so the differential compared nothing against nothing; `exit 0 # optimized` passes it too. Zero lines was zero evidence.

  Real mitigation: C1-AC5 (decision-trace differential over ~10,150 real pairs) and C1-AC6 (one mutant per narrowable dimension, each required to turn the gate red), both now mandatory on every path, plus the C1-AC0 fixtures that close the suite's measured blind spots. The general lesson, worth carrying beyond this plan: **for a gate that is silent when healthy, any criterion observing only a green tree is vacuous by construction.**
- **Risk — R44 masking in the new parallel path.** The current `run_step` is R44-correct via `PIPESTATUS[0]`. Backgrounding is exactly where that correctness is easiest to lose. C2-AC3 exists specifically to pin it.

## User operation scenarios

1. Developer runs `npm run pre-pr` on a Web-touching branch with all checks green → sees the same step list in the same order, static phase completing in seconds rather than ~3 minutes.
2. Developer runs it with one static check failing → the failing step appears in `═══ Results ═══` and its context block renders as today; exit code 1.
3. CI `static-checks` job runs `PRE_PR_STATIC_ONLY=1` on a 2-core runner → identical step set, bounded concurrency, no oversubscription.
4. Developer on an iOS-only branch → `RUN_WEB=0` path still skips Web steps; the iOS static guards still run.
5. Developer debugging a flaky-looking parallel interaction sets `PRE_PR_JOBS=1` → fully serial, today's exact behavior.
