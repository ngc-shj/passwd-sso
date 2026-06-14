# Plan: pre-pr multi-package build + lint-ignore + refactor-gate fixes (PR #651)

## Project context

- **Type**: `CLI tool` / dev-tooling (shell script `scripts/pre-pr.sh` + flat ESLint config `eslint.config.mjs` + Node orchestrator `scripts/refactor-phase-verify.mjs`). No runtime/app behavior changes.
- **Test infrastructure**: `unit + integration + E2E + CI/CD`. The artifacts under change are themselves the CI-parity local gate; there is no unit-test harness for `pre-pr.sh` itself (it is exercised by running it).
- **Verification environment constraints**: all three fixes are fully `verifiable-local` — the repo, the `cli/` and `extension/` packages (both have `node_modules`), and a `.claude/worktrees/` tree are all present locally. No paid-tier / external-service / hardware-attestation paths. CI equivalence is verifiable by reading `.github/workflows/ci.yml` + `refactor-phase-verify.yml`.
- **Scope**: dev-tooling only. Per Phase-1 project-context rule, reviewers MUST NOT raise Major/Critical findings recommending new automated-test frameworks for the shell script.

## Objective

Make `scripts/pre-pr.sh` a faithful local mirror of the CI gates so that "what passes pre-pr passes CI", closing three gaps surfaced while shipping PR #651:

1. **(most important) Multi-package build/test gap** — pre-pr verifies only the App (root `eslint .` / `vitest run` / `next build`). It never builds or tests `cli/` or `extension/`. A CLI ESM `.js`-extension omission (`tsc` TS2835, which `vitest`/esbuild tolerates) slipped past pre-pr and first failed in CI's "CLI: Build" job. The "don't push what doesn't build" contract was not enforceable at the pre-pr layer.
2. **ESLint false-fail** — `npx eslint .` exits 1 locally with 6831 "errors", blocking the Lint step. Root cause (verified): **100% of those errors originate from `.claude/worktrees/**`** — throwaway full-repo worktree copies that are git-ignored but NOT eslint-ignored. Excluding `.claude`, the project has **0 errors / 49 warnings**. CI passes `npm run lint` precisely because a fresh checkout has no `.claude/worktrees`.
3. **refactor-phase-verify false-fail (local-only)** — On a `refactor/*` branch, pre-pr runs `scripts/refactor-phase-verify.mjs`, whose stale-branch guard compares a fetched `origin/main` SHA against `.refactor-phase-verify-baseline` — a **git-ignored local file** that persists a stale SHA from a prior refactor session, yielding a false "Branch is stale" exit 1. CI passes because its fresh checkout has no baseline file (first-run records & passes). The guard is in fact **vacuous in CI** (always first-run) and only produces local false-positives.

## Requirements

### Functional
- FR1: After the change, `npx eslint .` from the repo root exits 0 even when `.claude/worktrees/` is present, matching CI.
- FR2: `scripts/pre-pr.sh` builds AND tests `cli/` and `extension/` (under the non-static guard), in the same per-package order CI uses: **CLI = Build → Test**, **Extension = Test → Build**.
- FR3: A genuine build/test break in `cli/` or `extension/` causes `pre-pr.sh` to exit 1 with captured failure context (same `run_step` machinery as existing steps).
- FR4: On a **content-only** refactor branch (no `src` renames), `pre-pr.sh` does NOT run the move-only refactor orchestrator and does NOT false-fail on the stale baseline.
- FR5: On a **move** refactor branch (≥1 `src` rename), `pre-pr.sh` runs the refactor orchestrator's verification scripts WITHOUT the merge-queue-only guards (stale-baseline + parallel-branch) that cause local false-positives.

### Non-functional
- NFR1: iOS is intentionally excluded from pre-pr (CI-only `xcodebuild`); state this in a code comment.
- NFR2: No `npm ci` inside pre-pr for `cli/`/`extension/` — assume installed deps (CI does `npm ci` in clean runners; locally that would be slow/destructive). If a package's `node_modules` is absent, the step must fail with a clear, actionable message rather than a cryptic one.
- NFR3: All new package steps respect `PRE_PR_STATIC_ONLY=1` (skip — they are environment-dependent, like Lint/Test/Build).
- NFR4: CI behavior is unchanged — `refactor-phase-verify.yml` keeps invoking `--force` with full guards.

## Technical approach

- **C1 (ESLint):** one-line addition to the existing `globalIgnores([...])` array in `eslint.config.mjs`: `".claude/**"`. Consistent with the existing `"extension/**"`, `"load-test/**"`, `"coverage/**"` entries. Nothing tracked under `.claude/` is project source the root config should lint (3 tracked files: a `.sh` hook, `settings.json`, a `SKILL.md` — none are `.ts/.tsx`).
- **C2/C3 (multi-package):** add `run_step` invocations using `bash -c 'cd <pkg> && <npm script>'`. `cd` is required (not `npm --prefix`) because `tsc`/`vitest` resolve their config from CWD, not from the `package.json` location. Guard the block with `if [ "$STATIC_ONLY" != "1" ]`. Precede each package with a `node_modules` existence check that fails with a `cd <pkg> && npm ci` hint (NFR2).
- **C4 (pre-pr refactor gate):** replace the bare `^refactor/` branch test with a compound condition that ALSO requires ≥1 renamed `src` path (`git diff --name-status -M main -- src | grep -E '^[RC]'`). When the branch is `refactor/*` but has no `src` renames, print an explanatory skip line (content-only refactor → CI's Refactor Phase Verify workflow remains authoritative). When it runs, pass `--skip-merge-queue-guards`.
- **C5 (orchestrator flag):** add a `--skip-merge-queue-guards` flag to `scripts/refactor-phase-verify.mjs`. When set, skip BOTH the stale-branch baseline check and the parallel-refactor-branch (`gh pr list`) check; still run every verification script. CI continues without the flag.

## Contracts

### C1 — eslint ignores `.claude/**`
- **File**: `eslint.config.mjs`
- **Change**: add `".claude/**"` to the `globalIgnores([...])` array, with a trailing comment noting it excludes throwaway git-ignored worktree copies (parity with the existing `coverage/**`/`extension/**` entries), so it is not misread as a security-scope carve-out (S1). The `no-restricted-syntax` fetch()/e2e rules are root-anchored (`src/components/**`, `e2e/**`) and never matched worktree copies at `.claude/worktrees/<id>/...`, so coverage of real `src/`/`e2e/` is unchanged (S1 verified).
- **Invariant** (app-enforced via tool exit code): running `npx eslint .` from repo root with a populated `.claude/worktrees/` present produces 0 errors → exit 0.
- **Forbidden patterns**:
  - `pattern: --max-warnings` in `eslint.config.mjs` or `scripts/pre-pr.sh` Lint step — reason: must NOT relax the gate; fix is ignore-path, not threshold.
  - `pattern: eslint-disable` introduced in this diff — reason: R36, no suppression.
- **Acceptance**: `npx eslint . ; echo $?` → `0`. `git grep -n '".claude/\*\*"' eslint.config.mjs` → 1 hit inside globalIgnores.

### C2 — pre-pr builds + tests `cli/` (Build → Test)
- **File**: `scripts/pre-pr.sh`
- **Placement** (F6): a single dedicated `if [ "$STATIC_ONLY" != "1" ]; then ... fi` block placed immediately **after the App `Build` step (current line ~460) and before the `═══ Results ═══` summary (line 462)**. Holds C2 + C3 together (cheap tsc/vitest cluster after the expensive `next build`).
- **Change**: `run_step "CLI: Build" bash -c 'cd cli && npm run build'` then `run_step "CLI: Test" bash -c 'cd cli && npm test'`, preceded by a `cli/node_modules` presence guard.
- **node_modules guard** (F2 / Adjacent): implement as a bare `if [ ! -d cli/node_modules ]; then printf ERROR+hint; failed=$((failed+1)); failures+=("CLI: deps missing|"); else <run the two steps>; fi` — mirroring the Manual-test-artifact gate at `scripts/pre-pr.sh:422-431` (append to `failed`/`failures`, do NOT `exit 1` — `set -euo pipefail` would otherwise kill the run before the Results summary). The hint message: `run 'cd cli && npm ci' (deps not installed; pre-pr does not auto-install)`.
- **Invariant**: order is Build-before-Test (matches CI "CLI: Build → Test", `ci.yml:393-394`; tsc must run before vitest so a `.js`-extension omission is caught by the build first). `cli/tsconfig.json` is `module/moduleResolution: NodeNext` (verified) so TS2835 fires on extensionless relative imports (F7).
- **Acceptance**:
  - **Order (T1)**: `grep -n 'CLI: Build' scripts/pre-pr.sh` line < `grep -n 'CLI: Test'` line.
  - **Negative (T6)**: introduce a temporary extensionless relative import in `cli/src` → the "CLI: Build" step fails AND the captured failure context contains `error TS2835` (the exact #651 regression class; `show_failure_context` already greps `error TS[0-9]+` at `pre-pr.sh:40`); revert → passes.
  - **Deps guard (Adjacent)**: temporarily rename `cli/node_modules` → run pre-pr → the actionable hint appears and the run still reaches the Results summary (exit 1, not a mid-run abort); restore.

### C3 — pre-pr tests + builds `extension/` (Test → Build)
- **File**: `scripts/pre-pr.sh` — same block as C2.
- **Change**: `run_step "Extension: Test" bash -c 'cd extension && npm test'` then `run_step "Extension: Build" bash -c 'cd extension && npm run build'`, preceded by an `extension/node_modules` presence guard (same bare-`if` pattern as C2).
- **Invariant**: order is Test-before-Build (matches CI "Extension: Test → Build", `ci.yml:286-287`).
- **Acceptance**:
  - **Order (T1)**: `grep -n 'Extension: Test'` line < `grep -n 'Extension: Build'` line.
  - **Positive**: both steps run and pass on current tree (verified: ext test 769 pass, ext build OK).

### C4 — pre-pr refactor gate requires `src` renames; passes skip flag
- **File**: `scripts/pre-pr.sh`
- **Change** (T3): **REPLACE the existing unconditional block at `scripts/pre-pr.sh:416-418`** (`if branch ~ ^refactor/; then run_step "Refactor phase verify" node scripts/refactor-phase-verify.mjs; fi`) — do NOT add a second block alongside it, or the old stale-baseline false-fail still fires. New condition: `STATIC_ONLY != 1` (T4 — keep the heavy orchestrator out of CI's `static-checks` job; aligns with NFR3) AND `branch ~ ^refactor/` AND `git diff --name-status -M main -- src` contains ≥1 `^[RC]` line. When it fires, invoke `node scripts/refactor-phase-verify.mjs --skip-merge-queue-guards`. When the branch is `refactor/*` but has 0 `src` renames, print an explanatory skip line (content-only refactor → CI's Refactor Phase Verify workflow is authoritative).
- **Code comment** (F1): annotate the rename detector `# two-dot -M main (working tree) mirrors verify-move-only-diff.mjs:194; do NOT change to main...HEAD` — keeps the gate's detector aligned with the verifier it gates.
- **Invariant**: a content-only `refactor/*` branch (0 `src` renames) never invokes the orchestrator from pre-pr; the four security checks (team-auth-rls/bypass-rls/crypto-domains/migration-drift) still run via their own top-level steps at `pre-pr.sh:140-143` (S2 — skipping the orchestrator does NOT skip security verification).
- **Forbidden patterns**:
  - `pattern: rm .*refactor-phase-verify-baseline` in `scripts/pre-pr.sh` — reason: do not silently delete a (git-ignored) state file as a workaround; fix is the skip flag.
- **Acceptance**:
  - **Skip arm**: on `refactor/hardcoded-values-to-constants` (0 src renames), the refactor step prints the skip line and pre-pr does not exit 1 on a stale baseline.
  - **Fire arm (T2)**: unit-test the rename predicate in isolation — stage a synthetic `src` rename (`git mv` a throwaway `src` file in a scratch index, or feed a known `R100\told\tnew` line) and assert the condition evaluates true and would invoke the orchestrator `--skip-merge-queue-guards`. The predicate must not be left exercised only on its 0-rename arm.

### C5 — `--skip-merge-queue-guards` flag on the orchestrator
- **File**: `scripts/refactor-phase-verify.mjs`
- **Signature**: new boolean CLI flag `--skip-merge-queue-guards` parsed from `process.argv`. When present, skip (a) the stale-branch baseline block (`fetchOriginMainSha` compare + `.refactor-phase-verify-baseline` read/write) and (b) `checkParallelRefactorBranches()`. All verification scripts in the `scripts[]` array still execute.
- **fetch independence** (F4): `fetchOriginMainSha()`'s result (`originSha`) is consumed ONLY by the stale-branch comparison (`refactor-phase-verify.mjs:80-90`); every downstream `scripts[]` entry compares against the LOCAL `main` ref (`git diff -M main`, `git show main:`), not `origin/main`. Skipping the fetch with the flag therefore deprives no verification script of data.
- **Invariant**: without the flag (CI's `--force` path in `refactor-phase-verify.yml`), behavior is byte-for-byte unchanged.
- **Forbidden patterns**:
  - `pattern: process.exit(0)` added inside the new skip branch that would bypass the verification-scripts loop — reason: skipping merge-queue guards MUST NOT skip the actual checks.
- **Acceptance** (T5): with a deliberately-stale `.refactor-phase-verify-baseline` (SHA confirmed ≠ current `origin/main` at test time): `node scripts/refactor-phase-verify.mjs --skip-merge-queue-guards --force` runs the scripts loop (no exit). Running WITHOUT the flag exits 1 with the **specific** `Branch is stale` message on stderr (grep that string — not merely exit code 1, since `checkParallelRefactorBranches` could also exit 1 for an unrelated reason and falsely "confirm" the test).

### Consumer-flow walkthrough
None of C1–C5 define an API/persisted/event shape consumed by other code. The only "consumers" are CI workflows reading these scripts:
- Consumer `ci.yml` "App: Lint → Test → Build" (reads `eslint.config.mjs` via `npm run lint`) uses the new ignore transparently — fresh checkout has no `.claude`, so behavior is unchanged in CI; the ignore only affects local runs. ✓
- Consumer `refactor-phase-verify.yml` (invokes `scripts/refactor-phase-verify.mjs --force`) does NOT pass `--skip-merge-queue-guards`, so C5 leaves its path unchanged. ✓
- Consumer `ci.yml` "static-checks" job (`PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`) must still skip the new C2/C3 package steps and the C4 refactor step's heavy work — C2/C3 sit under the `STATIC_ONLY!=1` guard; C4's run path is gated on rename presence and is not part of the static set. ✓

## Testing strategy

- **C1**: `npx eslint .` exit-code assertion (0) with `.claude/worktrees` present; grep the config line.
- **C2**: negative test — inject an extensionless import in `cli/src`, run the CLI Build step, confirm failure, revert.
- **C3**: positive test — run the extension steps on the current tree (already verified green).
- **C4**: run full `pre-pr.sh` on the current content-only refactor branch; assert the refactor step prints the skip line and the run reaches the Results summary without a refactor-gate failure.
- **C5**: deliberately set `.refactor-phase-verify-baseline` to a stale SHA; run the orchestrator with and without the flag; assert flag→runs-scripts, no-flag→exits on stale.
- **End-to-end**: run `bash scripts/pre-pr.sh` to completion on this branch and confirm all steps (including the new CLI/Extension ones) pass and Lint is green. This is the regression assertion that the line-416 block was REPLACED, not duplicated (T3).
- **Static-only path** (T4): `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` output must NOT contain the labels `CLI: Build` / `CLI: Test` / `Extension: Test` / `Extension: Build` (positively assert ABSENCE — a green run alone would mask a step accidentally placed outside the guard) and must not invoke the refactor orchestrator (C4 condition now includes `STATIC_ONLY != 1`).

## Considerations & constraints

- **SC1 (out of scope)**: the 49 pre-existing `no-unused-vars` *warnings* (`tx` unused, etc.). They are warnings (eslint exits 0), config-intended (`no-unused-vars: "warn"`), and unrelated to PR #651. Owner: future cleanup; not tracked by a blocking issue.
- **SC2 (out of scope)**: redesigning the stale-branch guard's fundamentally-vacuous-in-CI semantics or making the baseline per-branch. C5 neutralizes its local harm via an opt-in skip; a deeper redesign of `refactor-phase-verify.mjs`'s guard model is a separate tooling PR.
- **SC3 (out of scope)**: adding `npm ci` / dependency-bootstrap automation for `cli/`/`extension/` inside pre-pr. NFR2 only requires a clear failure message when deps are missing.
- **Risk**: `cd` inside `bash -c` within `run_step` — verified the existing script already uses `bash -c '...'` heredoc-style steps; the `tee`/`PIPESTATUS` capture in `run_step` works with `bash -c`. Pipe-fail semantics preserved.
- **Risk**: adding CLI tsc + CLI vitest + ext vitest + ext tsc/vite adds wall-clock to pre-pr, but each is far cheaper than the existing `next build`; acceptable.
- **Memory correction**: `project_pre_pr_refactor_verify_scope` previously recorded problem 2 as "6831 pre-existing errors needing gate relaxation" and problem 1 as "verify-move-only-diff structurally fails content refactors" — both were misdiagnoses corrected by this session's on-machine investigation (errors are 100% `.claude/worktrees`; verify-move-only-diff self-skips at 0 renames; the real local fail is the stale baseline). Update the memory after merge.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | eslint.config.mjs ignores `.claude/**`                        | locked |
| C2  | pre-pr builds+tests `cli/` (Build→Test)                       | locked |
| C3  | pre-pr tests+builds `extension/` (Test→Build)                 | locked |
| C4  | pre-pr refactor gate requires `src` renames + passes skip flag| locked |
| C5  | `--skip-merge-queue-guards` flag on refactor-phase-verify.mjs | locked |
