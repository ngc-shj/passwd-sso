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
- Guard mutation: inverting the comparison turned six boundary cells red.
- One equivalent mutant survives on exit status alone, and is killed only by the stderr
  marker assertion. It drops only the `exit 1` after the second jq call: the third jq call
  then errors on the same inputs and still exits 1.
