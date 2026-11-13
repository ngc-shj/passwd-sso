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
