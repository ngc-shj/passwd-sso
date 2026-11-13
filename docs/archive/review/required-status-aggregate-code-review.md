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
