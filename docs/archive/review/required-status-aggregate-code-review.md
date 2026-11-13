# Code Review: required-status-aggregate

Date: 2026-11-13
Review round: 1

## Changes from Previous Round

Initial code review of branch `ci/required-status-aggregate` (implementation commit
`ba1959047`).

## Functionality Findings

- **FN1 [Major]**: the `always()` prefix in the gated jobs' `if` defeats
  `cancel-in-progress`. GitHub keeps a running job whose `if` is still true when its run is
  cancelled, so a superseded run's gated jobs kept running and `e2e` started on cancelled
  dependencies. Rule 7 pinned that form. Pre-existing in `ci.yml`; plan line "cancel-in-progress
  cancels superseded runs" was false.
- **FN2 [Minor]**: `check-workflow-supply-chain.mjs` still said the cross-file case "is
  backstopped by CODEOWNERS".
- **FN3 [Minor]**: present-tense "the ruleset requires" claims (ops doc lead, CONTRIBUTING,
  both workflow comments, Test 9, gate header) are false until SC2.
- **FN4 [Minor]**: CONTRIBUTING said ci-integration and pre-pr run integration tests when the
  diff matches "the paths above". The CI filter is a 47-entry superset, and pre-pr also needs
  a `refactor/` branch and uses its own regex (the pre-pr half is pre-existing).
- **FN5 [Minor]**: the gate reported `on: pull_request` (string) and `on: [pull_request]` as
  "`on.pull_request` is missing".
- **FN6 [Minor]**: `ci.yml` comments said a failed `changes` job leaves empty outputs; with
  `|| 'true'` only a never-run `changes` does.
- **FN7 [Minor]**: ops doc said "more than 3000" files; the guard trips at 3000.
- **FN8 [Minor]**: the aggregate accepted a concatenated JSON stream (jq `-e` reads the last
  value). Unreachable through `toJSON(needs)`, but a gap against the "non-JSON → 1" contract.
- **FN9 [Minor, adjacent]**: the `main()` guard is a silent exit-0 no-op through a symlink or a
  path needing URL encoding. Same as SF2.

## Security Findings

- **SF1 [Minor]**: same as FN2; add `backstop` to the R4 grep.
- **SF2 [Minor]**: `import.meta.url === \`file://${argv[1]}\`` main guard; use
  `pathToFileURL`. Six sibling gates share the fragile form.
- **SF3 [Major]**: `ci-integration.yml` had no `branches` filter. A required check is matched by
  name on the head SHA, so a run of the same commit in a PR into another branch (filter
  against a different base) could report `Integration result` success for the PR into `main`.
- **SF4 [Minor]**: the filter step's `with` was not pinned; `predicate-quantifier`, `base` or
  `ref` change the answer without touching the filter list.
- **SF5 [Minor]**: ops doc lead and "runs on every pull request" stated in present tense
  before the ruleset change and without the `main` scope. Same class as FN3.

## Testing Findings

- **TF1 [Major]**: missing red cells: `R1-pr-not-mapping`, `R4-uses`, `R4-step-not-mapping`,
  `R3-permissions-read`, `R10-size-duplicated`, `R10-filter-duplicated`, `R10-no-outputs`,
  `FAIL-LOUD-not-mapping`.
- **TF2 [Major]**: no cell proving the aggregate never prints job outputs.
- **TF3 [Major]**: the CLI (`main()`, exit status, stream) was never executed.
- **TF4 [Minor]**: `GATED_SPEC` cells mutated a base that was not clean under that spec, and
  `R9-non-fc-if` set the value it already had.
- **TF5 [Minor]**: several cell regexes matched only the rule number, not the clause.
- **TF6 [Minor]**: guard cells used `toContain`, so an extra output line passed.
- **TF7 [Minor]**: `runStep` passed the full `process.env`.
- **TF8 [Minor]**: picomatch resolves through a hoisted transitive copy; `git ls-files` status
  unchecked.
- **TF9 [Minor]**: missing allow cells for job `permissions: {}` and scalar aggregate `needs`.
- **TF10 [Minor]**: the deviation log had no red-proof table and did not name the guard
  mutation.

## Adjacent Findings

FN9 and SF2 are the same finding; resolved once.

## Quality Warnings

None.

## Seed Finding Disposition

Seed unavailable (Ollama down) — no dispositions to record.

## Recurring Issue Check

### Functionality expert
- R3: FN2. R29: FN3, FN7. R33: FN1 (both workflows and the gate). R34: FN1, FN4 (pre-existing,
  fixed). R49: FN1, FN3. Others: no findings or N/A (see the expert's report).

### Security expert
- R4: SF1. RS-series: SF3, SF4. Others: no findings or N/A.

### Testing expert
- RT7: TF1–TF3, TF10. RT-series: TF4–TF9. Others: no findings or N/A.

## Environment Verification Report

- **VE1 (GitHub run of both workflows)**: verifiable-CI, pending the PR's own run (manual test
  step 1). That run is also the first execution of the quoted `!cancelled()` conditions.
- **VE2 (ruleset change, scratch PRs A/B, cancellation)**: blocked-deferred until merge, per the
  plan and manual test steps 2–8.

## Resolution Status

### FN1 [Major] `always()` defeats cancel-in-progress — Resolved
- Action: every gated `if` in `ci.yml` and `ci-integration.yml` now starts with
  `!cancelled() && ` (single-line forms double-quoted, since a leading `!` is a YAML tag).
  Rule 7 (`GATED_PREFIX`) accepts only that prefix; aggregates keep `always()`. Comments,
  ops doc, plan (marked as corrected) and deviation D4 updated; manual test step 5 observes the
  cancellation.
- Modified files: `.github/workflows/ci.yml`, `.github/workflows/ci-integration.yml`,
  `scripts/checks/check-required-aggregate.mjs`, tests, docs.
- Cells: `R7-fc-always`, `R7-after-always`, `R7-fc-after-always`.

### SF3 [Major] no `branches` pin — Resolved
- Action: `ci-integration.yml` `pull_request: branches: [main]`. Rule 1 requires `on` to be a
  mapping, `on.pull_request` a mapping, `branches` exactly `[main]`, and forbids
  `branches-ignore`. Reason recorded in the workflow header, the ops doc and D5.
- Cells: `R1-branches-absent`, `R1-branches-other`, `R1-branches-ignore`, `R1-pr-null`,
  `R1-pr-not-mapping`, `R1-on-string`, `R1-on-list`.

### FN5 [Minor] string/list `on` misreported — Resolved
- Action: these forms cannot carry `branches`, so they stay rejected, now with "`on` must be a
  mapping with `pull_request.branches: [main]`".

### SF4 [Minor] filter `with` unpinned — Resolved
- Action: rule 10 requires the filter step's `with` keys to be exactly `[filters]`;
  `findAggregateStepDivergence` compares the filter step's `uses`, `if` and `with` keys across
  the workflows (the lists themselves differ by design).
- Cells: `R10-filter-with-extra`, `R10-filter-with-base`, `DIV-filter-uses`,
  `DIV-filter-with-keys`, plus an allow cell for differing lists.

### FN8 [Minor] concatenated JSON stream — Resolved
- Action: the aggregate's first check is `jq -e -s 'length == 1 and (.[0] | type == "object"
  and length > 0)'` in both workflows.
- Cell: AGG case "a failing object followed by a passing one".

### SF2 / FN9 [Minor] main guard — Resolved
- Action: `process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`.
- Cell: CLI through a symlinked path.
- Sibling scripts (same defect class, fixed here): the 11 scripts using the `file://` form and
  the 8 using `pathToFileURL` without `realpathSync` now use the same expression, with
  `node:fs` / `node:url` imports only. A shared helper was not extracted: the Dockerfile
  copies `bootstrap-rds-roles.mjs`, `audit-db-grants.mjs` and `scripts/lib/*.mjs` one by one
  (closure checked by `check-runtime-image-assets.mjs`), so a new import would widen the
  image change. Each changed gate was run and printed its own result line; `tenant-domain.ts`
  under tsx printed its usage.

### FN2 / SF1 [Minor] CODEOWNERS backstop residue — Resolved
- Action: reworded to "the control for it is the maintainer reading the workflow diff". The R4
  sweep (`CODEOWNERS` with backstop/enforce/require/block/gate/guard/protect) now returns only
  ownership statements and the drift check's own (accurate) deletion-detection comment.

### FN3 / SF5 [Minor] present-tense ruleset claims — Resolved
- Action: ops doc leads with "Once the ruleset rule below is added", scopes to "every pull
  request into `main`"; CONTRIBUTING, both workflow comments, Test 9 and the gate header say
  "is to require" and point at the ops doc.

### FN4 [Minor] CONTRIBUTING trigger descriptions — Resolved
- Action: CI: "its `changes` filter (a superset of the paths above)". pre-pr: "on a
  `refactor/` branch whose diff touches the auth/DB modules above (its own regex, narrower
  than this list)".

### FN6 [Minor] stale empty-output comments — Resolved
### FN7 [Minor] 3000 threshold wording — Resolved ("3000 or more")

### TF1–TF10 — Resolved
- TF1: all eight cells added. TF2: outputs-sentinel cell per workflow. TF3: three CLI cells
  (broken tree → 1, symlink → 1, real repo → 0). TF4: `gatedBaseDoc()` for `GATED_SPEC`
  cells; `R9-non-fc-if` adds an AFTER job. TF5: regexes name the clause text. TF6:
  `toBe(\`small=${small}\n\`)`. TF7: `{ PATH, GITHUB_OUTPUT, ...env }`. TF8: hoisting note and a
  `git ls-files` status cell. TF9: both allow cells (the `pull_request: {}` allow cell is gone,
  since SF3 now rejects it). TF10: red-proof table in the deviation log; guard mutation named.
- Red-proof: see the deviation log, "Red-proof (code review round 1)".

---

# Round 2

Date: 2026-11-13. Scope: `ba1959047..db738ca16` (the round-1 fix commit).

## Findings

All Minor; no Critical or Major.

- **R2-1** (functionality F1, security SR2-1): rule 1 accepted triggers besides
  `pull_request` (`push`, `workflow_dispatch`, `merge_group`). Such a run posts the same check
  name on the PR head SHA without testing the merge with `main`; the ops doc said "nothing
  else" but the gate did not enforce it.
- **R2-2** (security SR2-2): after the `!cancelled()` change, gated jobs a cancelled run never
  started conclude `skipped`, which the aggregate read as a path-filter skip, so a cancelled
  run could report green with `e2e` never run. The aggregate step also relied on the default
  `success()`.
- **R2-3** (security SR2-3, testing F3): the main-guard rewrite had no class guard and no test
  ran the security gates' entrypoints; a future false guard would exit 0 silently (in
  `release.yml`, for the provenance verifier). Two rewritten scripts were loaded by nothing.
- **R2-4** (testing F1): the URL-encoding half of the main guard was unpinned
  (`file://${realpathSync(argv[1])}` passed every cell).
- **R2-5** (testing F2): the filter probe's `if` component had no cell.
- **R2-6** (testing F4): "one defect per red cell" overstated; `R10-no-outputs` planted an
  extra R7 violation.
- **R2-7** (functionality F2): CONTRIBUTING called pre-pr's regex "narrower" than the listed
  paths; it matches them exactly.
- **R2-8** (functionality F3): Test 9 still said "starts on every PR".

## Seed Finding Disposition

Seed unavailable (Ollama down).

## Environment Verification Report

Unchanged from round 1: VE1 pending the PR's own CI run, VE2 blocked-deferred until merge.

## Resolution Status

- **R2-1 — Resolved.** Rule 1 reports any `on` key besides `pull_request`. Cells
  `R1-extra-push`, `R1-extra-dispatch`, `R1-extra-merge-group`; the ops doc's gate list says so.
  Deviation D7.
- **R2-2 — Resolved.** The aggregate step has `if: always()` and
  `RUN_CANCELLED: ${{ cancelled() }}`, and exits 1 unless it is `false` (both workflows,
  identical). Rules 3–4 pin both. Cells `R3-step-if`, `R3-step-if-absent`,
  `R4-env-no-cancelled`, and execution cells for `RUN_CANCELLED` `true` and empty. Deviation D6.
- **R2-3 — Resolved.** New `scripts/__tests__/script-main-guard.test.mjs`:
  - an AST cell (ts-morph, no Program) that takes, for each `process.argv[1]`, the outermost
    expression in its statement holding `import.meta.url`, and requires the canonical form;
  - a positive control (≥ 20) and a detector cell over the three old spellings;
  - import smoke for `check-blame-ignore-revs.mjs` and `check-codeowners-drift.mjs`;
  - CLI cells: the provenance verifier exits 1 on empty stdin, and the supply-chain gate exits
    1 on a dependabot auto-merge workflow.
- **R2-4 — Resolved.** A CLI cell copies the gate into a temp directory named
  `required aggregate-…` (with `node_modules` linked) and expects it to run.
- **R2-5 — Resolved.** Cell `DIV-filter-if` (whitespace-only difference, R10-clean); the probe
  label and gate header name `if`.
- **R2-6 — Resolved.** The `app-ci` rewrite is dropped from `R10-no-outputs`; the header now says
  each cell asserts the one target violation its regex names.
- **R2-7, R2-8 — Resolved.** Wording fixed.

Red-proof: deviation log, "Red-proof (code review round 2)".

---

# Round 3

Date: 2026-11-13. Scope: `db738ca16..167b5ab59` (the round-2 fix commit).

## Findings

- **R3-1 [Critical]** (functionality F1): round 2 put `RUN_CANCELLED: ${{ cancelled() }}` in
  the aggregate step's `env`. GitHub's workflow schema allows the status functions only in
  `if` (actions/runner `workflow-v1.0.json`, `step-env` context; actionlint: "only available at
  `if:` section"). Both workflows would have failed validation on every PR and posted no
  aggregate check. Rule 4 pinned the invalid form, so the suite stayed green.
- **R3-2 [Major]** (testing F1, security M1): the main-guard AST check recognised only the
  literal `process.argv[1]`. A split `const`, `import.meta.filename`, `argv.at(1)`,
  destructuring or optional chaining escaped it; the `>= 20` positive control had zero slack and
  stops catching a removed guard once a 21st exists.
- **R3-3 [Minor]** (testing F3): a canonical guard with an empty or inverted body, or a shadowed
  `realpathSync`, passed.
- **R3-4 [Minor]** (testing F2): `R1-pull-request-target` matched the new generic extra-event
  message; disabling the dedicated check left the suite green.
- **R3-5 [Minor]** (testing F4): `.js` / `.cjs` / `.mts` scripts were not scanned.

Security found nothing else: the only-trigger rule plus `branches: [main]` closes the
workflow-level paths, and `[ … != "false" ]` was fail-closed (moot after R3-1).

## Seed Finding Disposition

Seed unavailable (Ollama down).

## Resolution Status

- **R3-1 — Resolved.**
  - The aggregate is now two steps. Step 1, `Fail when the run was cancelled`, runs only
    `if: cancelled()` and exits 1. Step 2 is the needs step with `if: always()` and `env`
    exactly `{ NEEDS }`. Rule 4 pins both, and the divergence probe compares both steps across
    the workflows.
  - New `findStatusFunctionMisuse` runs over every workflow file: a status function inside
    `${{ }}` anywhere except an `if` value is a violation.
  - Cells: `R4-three-steps`, `R4-cancel-step-missing`, `-if`, `-run`, `-extra-key`,
    `R4-env-extra` (re-adding the round-2 env), `STATUS-*`, the `checkRepository` wiring cell,
    and an execution cell for step 1.
  - Not adopted: running actionlint in CI. That would also validate the quoted
    `!cancelled() && …` conditions, but it adds a downloaded tool to the supply chain. It is
    raised with the user instead.
- **R3-2, R3-3, R3-5 — Resolved.** `script-main-guard.test.mjs` now refuses instead of
  recognising (deviation D8):
  - every `process.argv` read must be one of a closed set of shapes, and `[1]` is allowed only
    inside the canonical guard (or in the three CJS `endsWith` scripts);
  - `import.meta` other than `.url`, `argv` destructuring or aliasing, `["argv"]`, and a receiver
    other than `process` are refused;
  - the guard must be the whole condition of an `if` with no `else`, whose body makes a call,
    with real `node:fs` / `node:url` imports and no shadowing;
  - the guarded files are a pinned list;
  - `.mts` / `.js` / `.cjs` are scanned;
  - 19 refusal fixtures and one acceptance fixture are included.
- **R3-4 — Resolved.** Both `pull_request_target` cells name that check's own message, and a new
  cell covers `on: { pull_request_target }` alone.

Red-proof: deviation log, "Red-proof (code review round 3)" and the two-step table after it.

---

# Round 4 and the stopping rule

Date: 2026-11-13. Scope: `167b5ab59..e989b62ac` (the round-3 fix commit).

## Findings

- **R4-1 [Major]** (security R4-M1): a step-level `cancelled()` reports whether *this job* was
  cancelled (actions/runner `CancelledFunction.cs`), not the run. In an `always()` aggregate
  it is never true, so round 3's cancelled-run step never fired in the case it was added for,
  while the gate, an execution cell and the docs presented it as protection.
- **R4-2 [Major]** (testing R4-T1, security R4-m2): the closed grammar in
  `script-main-guard.test.mjs` still admitted `argv[1]`-equivalent guards through allowed shapes:
  `.includes(fileURLToPath(import.meta.url))`, `.slice(1)`, a helper taking `process.argv`.
- **R4-3 [Minor]** (testing R4-T2): six guard-shape checks could be deleted with that suite
  green; the "with else" fixture was red only through its empty body.
- **R4-4 [Minor]** (testing R4-T3): the grammar refused legitimate shapes inconsistently.
- **R4-5 [Minor]** (security R4-m1, testing R4-T4): the status-function rule was case-sensitive
  and exempted any key named `if`; one "allowed" assertion could not fail.
- **R4-6 [Minor]** (security R4-m3): the whitespace-normalised pin of the cancelled step accepted
  a one-line `echo … exit 1`.
- Functionality round 4 reported the same F1 (= R4-1) and F2 (= R4-5).
  - It also checked every expression in the committed workflows against actions/runner
    `workflow-v1.0.json`: step and job `if` with status functions, the quoted
    `"!cancelled() && (…)"` conditions, and `NEEDS: ${{ toJSON(needs) }}` in a step `env` are
    all valid.
  - `findStatusFunctionMisuse` returned no false positives over all 8 workflow files.
  - **F3 [Minor]**: the rule would also flag a status-function name inside an expression string
    literal (`contains(x, 'failure(')`). Accepted: nothing does this today, and the result is a
    loud gate failure, not a silent pass. A comment at the regex records it.

## Stopping rule

Rounds 2, 3 and 4 each found their main defects inside the previous round's own fix: the
cancelled-run handling (D6) and the main-guard test (D8). Following
`feedback_rounds_that_seed_their_own_defects_mean_wrong_scope`, the user chose to converge
instead of running round 5:

- **Withdraw the cancelled-run machinery.** The aggregate is back to round 1's single step,
  which three rounds reviewed. The residual race is documented in the ops doc under "A run
  cancelled by hand between two jobs" (re-run before merging). It needs a manual cancel on the
  head commit while no job is running or queued; a cancel caused by a new push is unaffected.
- **Withdraw the closed-grammar test.** Keep the 19-script guard fix, the two security-gate
  CLI cells and the import smoke. Pin the canonical guard by fixed string in the 20 scripts
  that carry it, and check that no script keeps the old spellings. How a NEW script decides it
  is the entry point is a follow-up.
- **Fix the status-function rule** (R4-5). It guards against round 3's Critical recurring.
  It is now case-insensitive, exempts only `jobs.<id>.if` and `jobs.<id>.steps.<n>.if`, and has
  cells for both.
- **No further full round.** Instead, a targeted check of the reverted and changed parts, then
  pre-pr.

## Resolution Status

- R4-1: Resolved by withdrawal (deviation D6). R4-6: moot (the step is gone).
- R4-2, R4-3, R4-4: Resolved by withdrawal (deviation D8); follow-up below.
- R4-5: Resolved. Cells `STATUS-case`, `STATUS-env-key-if`, `STATUS-with-key-if`.
- Functionality F3: accepted (fails loud); commented at `STATUS_FUNCTION_RE`.

## Follow-ups (not in this PR)

1. A check that every NEW CLI script uses the canonical entry guard. Round 4's probes
   (deviation D8 history, testing R4-T1) are its specification.
2. Run actionlint in CI to validate workflow expressions and contexts (round 3's Critical and
   the quoted `!cancelled()` conditions). This adds a downloaded tool to the supply chain, so
   it is a decision of its own.
3. Optional: a job-level `if: cancelled()` job in each aggregate's `needs`, which the server
   evaluates against the run. It would close the documented manual-cancel race. Its behaviour
   is unverified on GitHub.
