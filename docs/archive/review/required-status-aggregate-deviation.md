# Coding Deviation Log: required-status-aggregate

## D1 — Rule 10 compares the guard across workflows instead of against a copy in the gate

- **Plan (C3 rule 10):** the `size` guard step deep-equals a canonical object held in the
  gate.
- **Implemented:** the gate keeps no copy of the guard's `run` text. It pins the parts that
  are decisions rather than code:
  - `id: size`;
  - `env` exactly `{ CHANGED_FILES: ${{ github.event.pull_request.changed_files }} }`;
  - no step `if`;
  - no `${{` in `run`;
  - the filter step's `if`;
  - every output `|| 'true'`.

  It also requires the `size` step to be deep-equal across `ci.yml` and `ci-integration.yml`
  (`findAggregateStepDivergence`). What the `run` text does, including the 3000 threshold,
  is pinned by executing it from both workflows in the self-test.
- **Why:** a third copy of the script would have to be edited with every change and would add
  nothing the execution cells do not prove. The plan's red cell for "threshold changed to
  30000" is the executed `GUARD-invert` / boundary cells (2999 / 3000 / 3001).

## D2 — The guard accepts at most nine digits

- **Plan:** `small=true` only when `CHANGED_FILES` is a decimal integer below 3000.
- **Implemented:** `^[0-9]{1,9}$` before the arithmetic comparison `(( 10#N < 3000 ))`.
- **Why:** bash arithmetic wraps on very large numbers. Without the bound, a value such as
  `99999999999999999999` could compare as negative and yield `small=true`. The self-test
  includes `9999999999` (ten digits) → `small=false`. `10#` keeps a leading zero from being
  read as octal.

## D3 — The CODEOWNERS header now explains what the file does and does not do

- R4 required rewording each false enforcement claim. `.github/CODEOWNERS:1-2` was replaced
  with a four-line comment stating that the file records ownership and does not block a
  merge, and pointing to `docs/operations/ci-required-checks.md`. `CONTRIBUTING.md` gained one
  sentence to the same effect under the integration-gate paragraph.

## One-time check: filter list equals the old trigger list

`filters.integration`, parsed from the new `changes` step, was compared with
`on.pull_request.paths` from `git show main:.github/workflows/ci-integration.yml`. The result
was 47 entries on each side, deep-equal (same order, same strings).

## Red-proof (Phase 2)

- Every clause id of the gate was mutated on a scratchpad copy, through a scratch vitest
  config aliasing the gate import, and its named cell went red. The unmutated control passed.
- Aggregate-step mutations each turned the named execution cells red, in both workflows:
  - `exit 0`;
  - drop the empty check;
  - drop the unknown-value arm;
  - read a missing or `null` result as skipped;
  - swallow the jq parse error.
- Guard mutation: `(( 10#${CHANGED_FILES} < 3000 ))` changed to `>` turned six boundary cells red.
- One equivalent mutant survives on exit status alone, and is killed only by the stderr
  marker assertion. It drops only the `exit 1` after the second jq call: the third jq call
  then errors on the same inputs and still exits 1.

## D4 — Gated jobs use `!cancelled()`, not `always()` (code review round 1)

- **Plan (C1, C3 rule 7):** gated jobs keep `ci.yml`'s `always() && (…)` form.
- **Implemented:** every FC, AFTER and FC-AFTER `if` in both workflows starts with
  `!cancelled() && `, and rule 7 accepts only that prefix. The aggregates keep `always()`.
- **Why:** GitHub re-evaluates a running job's `if` when its run is cancelled and keeps the job
  when the `if` is still true. With `always()`, a superseded run's gated jobs kept running and
  `e2e` started on cancelled dependencies, which defeated `cancel-in-progress`. `!cancelled()` is
  still true when `changes` failed, so the form stays fail-closed. A single-line `if` starting
  with `!` is a YAML tag, so those lines are double-quoted.

## D5 — Both workflows are pinned to `branches: [main]` (code review round 1)

- **Plan (C3 rule 1):** `branches` allowed, not required.
- **Implemented:** rule 1 requires `on` to be a mapping and `on.pull_request.branches` to be
  exactly `[main]`; `branches-ignore` is forbidden. `ci-integration.yml` gained the filter.
- **Why:** a required check is matched by name on the head SHA. A run of the same commit in a
  PR into another branch, whose filter compares against a different base, could otherwise
  report `Integration result` for the PR into `main`.

## Red-proof (code review round 1)

Gate mutations ran on a scratchpad copy of the gate. A scratch vitest config aliased the
gate import (and `js-yaml`) to that copy, and the real test file ran through it. The unmutated
copy passed (234/234) through the same config first.

| Mutation | Cells that went red |
| --- | --- |
| `branches` check disabled | `R1-branches-absent`, `R1-branches-other` |
| `on`-is-a-mapping check disabled | `R1-on-string`, `R1-on-list` |
| `pull_request: null` accepted again | `R1-pr-null` |
| `branches-ignore` dropped from the forbidden keys | `R1-branches-ignore` |
| `always() && ` accepted as a prefix | `R7-fc-always`, `R7-after-always`, `R7-fc-after-always` |
| filter `with`-key check disabled | `R10-filter-with-extra`, `R10-filter-with-base` |
| filter probe ignores `uses` | `DIV-filter-uses` |
| filter probe ignores `with` keys | `DIV-filter-with-keys` |

Run directly against a scratch copy of the step or guard text:

| Mutation | Result |
| --- | --- |
| aggregate first check without `-s` | concatenated stream `{failure} {success}` exits 0 (new text: 1) |
| aggregate prints `.value` instead of `.value.result` | the outputs sentinel appears (new text: absent) |
| main guard as `file://${argv[1]}` | no output via a symlink or a path with a space (new guard: runs) |

## D6 — WITHDRAWN in round 4: a cancelled-run check on the aggregate (code review rounds 2–3)

- **Withdrawn.** Round 4 found that a step-level `cancelled()` reports whether *this job* was
  cancelled (actions/runner `CancelledFunction.cs`), so it is never true in an `always()`
  aggregate; the step never fired in the case it was added for. With rounds 2–4 each finding
  their main defect inside the previous round's fix, the user chose to withdraw it and document
  the narrow race instead (`docs/operations/ci-required-checks.md`, "A run cancelled by hand
  between two jobs"). The aggregate is back to round 1's single step. The status-function rule
  that round 3 added stays. The text below is the history.

### History

- **Plan (C3 rules 3–4):** no step-level `if` on the aggregate; step `env` exactly `{ NEEDS }`.
- **Implemented (as corrected in round 3):** the aggregate has two steps. The first is
  `if: cancelled()` and exits 1. The second is the needs step, now with `if: always()` and
  `env` exactly `{ NEEDS }`. Rules 3 and 4 pin both steps.
  - Round 2 first put `RUN_CANCELLED: ${{ cancelled() }}` in the step's `env`. GitHub accepts
    status functions only in `if`, so both workflows would have failed validation and posted no
    check at all. The suite stayed green because rule 4 pinned that invalid form. Round 3
    replaced it and added a gate rule rejecting status functions outside `if` in every
    workflow.
- **Why:** after D4, a gated job that a cancelled run never started concludes `skipped`, which
  the aggregate would read as a path-filter skip, so a cancelled run could report green with
  `e2e` never run. The default step condition `success()` could also skip the step in a
  cancelled run.

## D7 — `pull_request` must be the only trigger (code review round 2)

- **Plan (C1):** no rule against other events.
- **Implemented:** rule 1 reports any key of `on` besides `pull_request` (`push`,
  `workflow_dispatch`, `merge_group`, …).
- **Why:** such a run posts the same check name on the PR's head SHA from a run that tested the
  bare head, not the merge with `main`. A merge queue therefore needs a deliberate gate change,
  as the ops doc's merge-queue note already says.

## Red-proof (code review round 2)

| Mutation | Result |
| --- | --- |
| guard `if (false)` in a copy of `verify-npm-provenance-source.mjs` | empty stdin exits 0 (real: 1), which the new CLI cell rejects |
| a script with `pathToFileURL(process.argv[1]).href` in a scratch git repo running `script-main-guard.test.mjs` | the canonical-form cell reports exactly that guard; the positive control fails |
| the three old guard spellings as fixtures | each is detected, and none is canonical (in-suite cell) |

Gate mutations through the scratch alias config (unmutated control: all green):

| Mutation | Cells that went red |
| --- | --- |
| extra-trigger check disabled | `R1-extra-push`, `R1-extra-dispatch`, `R1-extra-merge-group` |
| aggregate step `if` check disabled | `R3-step-if`, `R3-step-if-absent` |
| step `env` compared on `NEEDS` only | `R4-env-no-cancelled` |
| filter probe without `if` | `DIV-filter-if` |

Run directly:

| Mutation | Result |
| --- | --- |
| aggregate step without the `RUN_CANCELLED` check | all-success needs with `RUN_CANCELLED=true` exits 0 (real: 1) |
| main guard `` `file://${realpathSync(argv[1])}` `` in a directory named `dir with space` | silent exit 0 (real guard: runs, exits 1 on the broken tree) |

## D8 — WITHDRAWN in round 4: a closed grammar over how scripts read `process.argv` (code review round 3)

- **Withdrawn.** Round 4 showed allowed shapes (`.includes(fileURLToPath(import.meta.url))`,
  `.slice(1)`, a helper taking `process.argv`) still admitting symlink-blind guards, and six
  guard-shape checks that could be deleted with the suite green. The test now pins the canonical
  guard by fixed string in the 20 scripts that carry it, and checks that no script keeps the old
  spellings. Covering how a NEW script decides it is the entry point is a follow-up. The text
  below is the history.

### History

- **Round 2 version:** an AST cell recognised guards built from the literal `process.argv[1]`
  and required them to be canonical, with a `>= 20` positive control.
- **Problem:** recognition cannot be complete. A split `const`, `import.meta.filename`,
  `argv.at(1)`, destructuring or optional chaining escaped it, and `>= 20` with exactly 20
  present stops catching a removed guard once a 21st is added.
- **Implemented:** a closed grammar over every `process.argv` read in non-test scripts
  (`.slice/.includes/.find/.indexOf/.length`, a non-`1` index, passed as an argument). Index
  `[1]` is allowed only inside the canonical guard, or in the three CJS-bundled `endsWith`
  scripts. `import.meta` other than `.url`, destructuring or aliasing `argv`, `["argv"]`, and a
  receiver other than `process` are refused. The guard must be the whole condition of an `if`
  with no `else`, whose body makes a call, with `realpathSync` / `pathToFileURL` imported from
  `node:fs` / `node:url` and not shadowed. The guarded files are a pinned list.
- **Residual:** a canonical guard whose body calls something other than the entry point
  (`process.exit(0)`) passes. Two gates have CLI cells that would catch it.

## Red-proof (code review round 3)

`script-main-guard.test.mjs` copied into a scratch git repo, one check disabled at a time
(the refusal and acceptance cells; unmutated control green):

| Mutation | Cells that went red |
| --- | --- |
| `import.meta` check disabled | `import.meta.filename alone`, `import.meta.main` |
| `argv` binding check disabled | `object destructuring` |
| guard-shape check returns nothing | `with else`, `with empty body`, `without imports`, `shadowed realpathSync` |
| `.at` added to the allowed methods | `argv.at(1)` |
| receiver check disabled | `globalThis.process with an allowed method` |
| `["argv"]` check disabled | `string-keyed access` |
| any expression holding `import.meta.url` taken as canonical | `canonical guard negated` |

Gate: the dedicated `pull_request_target` check disabled turned `R1-pull-request-target` and
`R1-pull-request-target-only` red (both regexes now name that check's own message).

Two-step aggregate and status-function rule (scratch alias config, control green):

| Mutation | Cells that went red |
| --- | --- |
| first-step check disabled | `R4-cancel-step-missing`, `-if`, `-run`, `-extra-key` |
| first-step check ignores extra keys | `R4-cancel-step-extra-key` |
| step-count check loosened | `R4-three-steps` |
| status-function match disabled | `STATUS-always/cancelled/failure/success/run`, the `checkRepository` cell |
| status-function rule not called from `checkRepository` | the `checkRepository` cell |
| first step's `exit 1` removed (run directly) | exits 0; the execution cell expects 1 |

## Red-proof (code review round 4)

| Mutation | Cells that went red |
| --- | --- |
| status-function regex without `i` | `STATUS-case` |
| exemption by last key `if` instead of the job/step `if` path | `STATUS-env-key-if`, `STATUS-with-key-if` |
| aggregate step count loosened | `R4-two-steps` |
| aggregate step-level `if` allowed | `R3-step-if` |
| `check-compose-log-caps.mjs` guard without realpath (scratch git repo) | its pinned-guard cell, `no script keeps a symlink-blind guard spelling` |
