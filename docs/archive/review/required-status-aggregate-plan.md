# Plan: required-status-aggregate

Issue `#958`. Branch `ci/required-status-aggregate`.

## Project context

- Type: `mixed` (web app; this change touches CI configuration, a static gate and docs).
- Test infrastructure: `unit + integration + E2E + CI/CD`.
  - Static gates live in `scripts/checks/*`, each with a self-test in
    `scripts/__tests__/*.test.mjs`. The meta-gate `check-gate-selftest-coverage.sh` requires
    that pairing.
  - Gates run from `scripts/pre-pr.sh`. The `static-checks` CI job runs it with
    `PRE_PR_STATIC_ONLY=1` on every PR.
  - Self-tests run in `app-test`, through vitest's `scripts/__tests__/**/*.test.mjs` include.
- Verification environment constraints:
  - **VE1** — `verifiable-CI`. How a skipped job, a skipped matrix job and an unstarted
    workflow report to branch protection can only be observed on GitHub, on real PRs. This
    PR's own runs and scratch PRs (opened after user confirmation, closed unmerged) cover it.
  - **VE2** — `blocked-deferred` until merge. `main`'s merge rules are a repository-admin
    setting outside the diff.
    - They are changed only after this PR merges, and only after the user confirms (SC2).
    - Live state (read-only `gh api`):
      - classic protection: no required checks; `enforce_admins: true`;
      - active ruleset 13001033 "Protect main": rules `pull_request` and `deletion`, no
        bypass actors.

## Objective

Make every CI result that should block a merge into `main` actually block it.

Today neither protection source requires a status check. The jobs in `ci-integration.yml`
cannot simply be made required: the workflow filters paths in its trigger, so a PR outside
those paths never starts it, and a required check from it would stay pending forever.

**Threat model (S1).** The aggregates stop *accidental* red merges. They are not a control
against a hostile PR author. Every adjudicator (the aggregate step, the C3 gate, `pre-pr.sh`)
runs from the PR's own head. A PR that edits any file CI executes or reads can make them
green: workflows, `scripts/**`, `package.json`, `package-lock.json`, `patches/`, `.npmrc`,
`.nvmrc`, test configs, and the tests themselves. For such PRs the control is the maintainer
reading the diff, and C4 says so. C3's rules therefore target *accidental* weakening.
Hostile-only vectors are listed as known limits, not chased with more rules.

## Requirements

- **R1** — `ci-integration.yml` starts on every pull request.
  - Relevance is decided in a job, not in the trigger.
  - An irrelevant PR finishes green without running Postgres, MinIO or Jackson.
- **R2** — Each of `ci.yml` and `ci-integration.yml` gets one aggregate job.
  - It always runs.
  - Its name is fixed and matrix-free.
  - It fails when any job of its workflow failed or was cancelled.
  - It passes only when every job succeeded or was skipped.
- **R3** — A static gate fails when a change would let a job's failure, or a job's silent
  skip, pass its aggregate. The gate covers:
  - membership of the aggregate's `needs`;
  - the aggregate's own shape and name;
  - the trigger;
  - every job-level `if`;
  - every `continue-on-error`;
  - required-name uniqueness across all workflows.
- **R4** — Correct the false statements:
  - the `ci-integration.yml` header;
  - `CONTRIBUTING.md` ("blocks merge on failure");
  - Test 9 of `sso-claim-connection-binding-manual-test.md`;
  - every claim that CODEOWNERS enforces review. Paths are listed in `.github/CODEOWNERS`,
    but neither protection source requires code-owner review, and with one maintainer it
    cannot: the author cannot approve their own PR. Member set:
    `git grep -n -i -E "codeowners-gated|CODEOWNERS.*(require|review|gate|approv)|(require|review|approv).*CODEOWNERS|PRIMARY control|will not merge|approving review|owner review|require[sd]? (a )?review" -- . ':!docs/archive' ':!**/__tests__/**'`.
    That command finds:
    - `.github/CODEOWNERS:1,2,4,18,48`;
    - `CONTRIBUTING.md:25-27`;
    - `scripts/check-codeowners-drift.mjs:30,38`;
    - `scripts/checks/check-workflow-supply-chain.mjs:18-20,92-93`;
    - `scripts/checks/crypto-auth-deps-manifest.json` `$note`;
    - `scripts/env-allowlist.ts:12`.

    The same command also hits `docs/security/license-policy.md:38`. That line is about
    license metadata, not CODEOWNERS, and is excluded.

    Each is reworded to "owned by" or "listed in CODEOWNERS (not enforced)". Comment and
    prose only.

## Technical approach

- **ci-integration trigger.** `on.pull_request.paths` is deleted.
- **ci-integration `changes` job.**
  - Name: `"Integration: detect relevance"`, distinct from `ci.yml`'s `Detect changed areas`.
  - It does no checkout: for `pull_request`, `dorny/paths-filter` reads the PR files API.
    The repo is public, so top-level `contents: read` suffices, as it does today for
    `ci.yml`'s `changes`.
  - It uses the same SHA pin as `ci.yml` and one filter, `integration`.
  - That filter carries today's list, comments included, moved verbatim and kept
    **single-quoted**. A double-quoted `"\[locale\]"` is an invalid YAML escape.
  - picomatch with `dot:true` matches `src/app/[locale]/auth/signin/page.tsx` against
    `src/app/\[locale\]/auth/signin/**` (checked locally).
- **Large-PR guard (S5)**, applied to the `changes` job of both workflows.
  - Background: GitHub's REST reference for "List pull requests files" says responses
    include at most 3000 files. A filter fed a truncated list can therefore answer `false`
    for a relevant change. The guard is fail-closed whatever paths-filter does near that cap.
  - A first step, `id: size`, has `env: { CHANGED_FILES: ${{ github.event.pull_request.changed_files }} }`.
    It writes `small=true` to `$GITHUB_OUTPUT` only when `CHANGED_FILES` is a decimal integer
    below 3000. In every other case it writes `small=false`, including empty or non-numeric
    input.
  - The filter step has `if: steps.size.outputs.small == 'true'`.
  - Every job output is written as `${{ steps.filter.outputs.<f> || 'true' }}`. A skipped
    or silent filter therefore yields `'true'`, which runs everything, while a filter
    answer of `'false'` is kept.
  - The guard step and the filter step's `if` are identical in both workflows.
- **Gated jobs.** `integration` and `jackson-probe` get `needs: changes` and
  `if: !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.integration == 'true')`.
  This is `ci.yml`'s fail-closed form. (Corrected in code review round 1: the plan had
  `always()`, which keeps a superseded run's jobs alive through `cancel-in-progress`;
  `ci.yml`'s gated jobs moved to `!cancelled()` too.) GitHub collapses a matrix job into a single
  `needs.<id>.result`, which is `success` only when every entry succeeded.
- **Aggregate jobs.**
  - Ids and names: `ci-result` with name `CI result`, and `integration-result` with name
    `Integration result`.
  - Shape:
    - `if: always()`, not `!cancelled()`: a skipped required check counts as passing;
    - `needs:` every other job;
    - `permissions: {}`;
    - no checkout, no `strategy`, no `shell:` key;
    - one step with `env: { NEEDS: ${{ toJSON(needs) }} }` and a `run` that contains no
      `${{`.
  - The step is identical in both workflows. It:
    - starts with `set -euo pipefail`;
    - prints only `id: result` pairs, never `outputs`;
    - exits **exactly 1**, through an explicit `exit 1` around every jq call, when:
      - `needs` is empty or unparsable;
      - any entry's `result` is missing or outside {`success`, `skipped`};
    - exits 0 otherwise.
- **Gate.** `scripts/checks/check-required-aggregate.mjs` (C3) parses YAML with `js-yaml`,
  already a dependency. It is queued in `pre-pr.sh` next to `Static: workflow-supply-chain`.
- **Merge rules (SC2, after merge, after user confirmation).**
  - Add a `required_status_checks` rule to ruleset 13001033. It carries the existing rules
    and lists `CI result` and `Integration result`, each with `integration_id: 15368`
    (GitHub Actions), so another app cannot satisfy the name (S2).
  - Classic protection is left untouched. Its sub-resource PATCH returns 404 while no check
    is enabled, and a full PUT would restate unrelated fields (F1).
  - Read-back: `gh api repos/:owner/:repo/rules/branches/main`, which reports both sources.

## Contracts

### C1 — ci-integration trigger and relevance

- Trigger:
  - `on.pull_request` exists;
  - it has no `paths`, `paths-ignore` or `types` (default types are needed: `opened`,
    `synchronize`, `reopened`).
- `changes` job:
  - the large-PR guard;
  - `outputs.integration` written as `${{ steps.filter.outputs.integration || 'true' }}`;
  - its filter list equals `main`'s trigger list.
- Jobs: every job other than `changes` and the aggregate has `needs` containing `changes`,
  and an `if` in the fail-closed form.
  - Member set: `Object.keys(load(ci-integration.yml).jobs)`. Today that is
    {`integration`, `jackson-probe`} plus the two new jobs.
- Acceptance:
  - A PR touching only `docs/archive/**`: `changes` succeeds with `integration=false`,
    `integration` and `jackson-probe` are skipped, and `Integration result` succeeds.
  - A PR touching `src/lib/auth/**` runs both jobs.

### C2 — aggregate jobs

- Shape and step exactly as in Technical approach.
- `needs` equals the set of all other job ids of the workflow. The gate re-derives that set
  from the parsed file on every run. Job counts, from `node -e` over
  `js-yaml` `Object.keys(jobs)`:
  - `ci.yml`: 22 before the change, 23 after, so its aggregate needs 22 ids;
  - `ci-integration.yml`: 2 before the change, 4 after, so its aggregate needs 3 ids.
- Decision input: the shape GitHub documents for `toJSON(needs)`,
  `{"<id>": {"result": "<r>", "outputs": {...}}}`.
- Control class: **fail-closed verification gate**. Adjudication authority: GitHub's job
  results in `needs`.
- Acceptance. The step:
  - exits 0 for: all success; success + skipped; all skipped;
  - exits 1 for: any failure; any cancelled; an unknown result string; an entry without
    `result`; `result: null`; `{}`; non-JSON input.
- Consumer walkthrough:
  - The ruleset's `required_status_checks` rule reads the check-run conclusion of the
    context `CI result` / `Integration result` from integration 15368.
  - No other consumer.

### C3 — gate `check-required-aggregate.mjs`

- Exports:
  - `findWorkflowViolations(content, name, spec): string[]`, where
    `spec = { aggregateId, aggregateName, everyJobGated: boolean }`;
  - `findAggregateStepDivergence(contentsByName, specs): string[]`;
  - `findRequiredNameCollisions(contentsByName, requiredNames): string[]`;
  - `checkRepository({ workflowsDir, specs, readFile }): string[]`;
  - `main()`, a thin wrapper over `checkRepository` with the real directory and the fixed
    spec map `{ "ci.yml": {ci-result, "CI result", false}, "ci-integration.yml":
    {integration-result, "Integration result", true} }`.
- Rules for each mapped workflow:
  1. The trigger rule of C1, and `on.pull_request.branches` is exactly `[main]` in both
     workflows. (Corrected in code review round 1: the plan only allowed `branches`. A run
     of the same commit in a PR into another branch could otherwise report the required
     name for a PR into `main`.)
  2. The aggregate exists, and its `name` equals the mapped literal (no `${{`).
  3. The aggregate has `if: always()` and `permissions: {}`. It has no `strategy`,
     `defaults`, job-level `env`, or step-level `if` or `shell`. The workflow has no
     `defaults.run.shell` and no top-level `env`.
  4. The aggregate has exactly one step. Its `env` is exactly
     `{ NEEDS: "${{ toJSON(needs) }}" }`, compared after whitespace normalisation, and its
     `run` contains no `${{`.
  5. The aggregate's `needs` set equals all other job ids. Both a missing id and an extra
     id are reported.
  6. No `continue-on-error`, at job or step level, on any job.
  7. Every job-level `if` is absent, or matches exactly, after whitespace normalisation, one
     of three canonical forms:
     (Corrected in code review round 1: the prefix of all three is `!cancelled()`, not
     `always()`.)
     - **FC**: `always() && (needs.changes.result != 'success' || D(|| D)*)`, where
       `D = needs.changes.outputs.<filter> == 'true'`;
     - **AFTER**: `always() && needs.<job>.result == 'success'`. This form is allowed only
       for the enumerated pair (`app-coverage`, `app-test`).
     - **FC-AFTER**: `always() && (FC-body) && needs.<job>.result != 'failure'(&& …)*`. This
       form is allowed only for `e2e`, with exactly its four dependencies (`app-ci`,
       `app-test`, `app-coverage`, `app-build`).

     A new pair for either form is added to the gate's table deliberately.

     Anything else, including any `github.`, `vars.` or `inputs.` context, is a violation.
     A form referencing `needs.X` requires `X` to be in the job's `needs`, and each `<filter>`
     must be a key of the `changes` job's `outputs`.
  8. Top-level `permissions` is exactly `{contents: read}`. Each job-level `permissions` is
     absent, `{}` or `{contents: read}`.
  9. When `everyJobGated` is set, every non-aggregate job other than `changes` has
     `changes` in `needs` and an FC `if`.
  10. The `changes` job checks the following:
      - its guard step deep-equals the canonical guard object held in the gate (id, `env`,
        `run`);
      - its filter step's `if` is exactly `steps.size.outputs.small == 'true'`;
      - every output is `${{ steps.filter.outputs.<k> || 'true' }}`, with `<k>` equal to the
        output's own key.
  11. Every step-level `if` outside the aggregate and the filter step is absent or one of
      {`failure()`, `always()`, `!cancelled()`}. Today the only one is `e2e`'s
      `failure()` upload.
- Step divergence: the aggregate step objects (`run`, `env`, absence of `shell`) are
  deep-equal across the mapped workflows.
- Name collisions: across **every** `.github/workflows/*.yml` and `*.yaml`, enumerated from
  the directory listing, each required name is the effective name (`name`, or the id when
  `name` is absent) of exactly one job. A `name` containing `${{ }}` counts as a collision
  when the pattern built from its literal parts, with each expression replaced by `.*`,
  matches a required name.
- Fail loud: a mapped file, its aggregate job or its `changes` job missing is a violation,
  never a skip.
- Control class: **fail-closed verification gate** over the YAML parse (adjudicator:
  `js-yaml`, the structure GitHub reads).
- Known limits:
  - The gate is bypassable by a PR that edits it (see Threat model).
  - It covers only the mapped workflows (SC1).
  - The `if` grammar is closed: a new legitimate form must be added to rule 7 deliberately.
  - It does not inspect what a step's `run` does. A step that exits 0 without verifying
    anything is out of reach. This is the same limit the existing gates have.

### C4 — documentation

- The `ci-integration.yml` header says:
  - the workflow always starts;
  - relevance is decided in `changes`;
  - the required check is `Integration result`.
- `CONTRIBUTING.md:59` is rewritten to the same effect.
- Test 9 of the manual test is corrected:
  - the required checks are `CI result` and `Integration result`, not the matrix names;
  - the reason is recorded (matrix names change; a path-filtered workflow never reports);
  - the read-back command is `gh api repos/:owner/:repo/rules/branches/main`.
- Every CODEOWNERS-enforcement claim in R4's member set is reworded.
- New section in `docs/operations/ci-required-checks.md`. It records:
  - the two required names and their integration id;
  - the read-back command;
  - the threat model above;
  - two recovery cases:
    - a PR retargeted to `main` raises `edited`, which neither workflow listens to — push
      or reopen;
    - a failed `changes` alone turns its aggregate red — re-run the job;
  - that enabling a merge queue requires adding `merge_group` to both workflows.

### Forbidden patterns

- `pattern: continue-on-error — reason: masks a red job or step as success` (in either mapped workflow)
- `pattern: re-actors/alls-green — reason: third-party action where a few lines of jq suffice`
- `pattern: pull_request_target — reason: runs PR code with a write token`

## Testing strategy

File: `scripts/__tests__/check-required-aggregate.test.mjs`.

- **Gate cells: one red cell per clause, not per rule number.**
  - Every clause in C3 rules 1–11 has its own red cell. So does every divergence,
    collision and fail-loud clause.
  - The test holds the clauses in one table, keyed by a short clause id. The red-proof list
    uses the same ids.
  - The cells that must exist, beyond the obvious one-per-clause, are:
    - rule 7:
      - an FC `if` naming an unknown filter key (`outputs.intgration`), the silent-skip
        typo;
      - FC without the prefix, and each form with `always()` in place of `!cancelled()`;
      - FC with `&& false`;
      - a `github.event` condition;
      - AFTER for an unlisted pair;
      - FC-AFTER with `== 'failure'`;
    - rule 3: each forbidden key (`strategy`, `defaults`, job `env`, step `if`, step
      `shell`, workflow `defaults.run.shell`, workflow `env`);
    - rule 8: top-level `write-all`; job-level `pull-requests: write`;
    - rule 10: a missing guard, a threshold changed to 30000, a filter step without `if`;
    - rule 11: `if: github.actor != 'x'` on a non-aggregate step;
    - collision: a third workflow reusing `CI result`, and a `name: ${{ matrix.n }}` job.
  - Allow cells:
    - `needs: [changes]` in array form;
    - each canonical `if` form;
    - `permissions: {contents: read}` at job level;
    - `branches` on the trigger;
    - `App: Test (${{ matrix.shard }}/3)` as a non-colliding expression name;
    - `CI.result ${{ matrix.n }}`, which must not collide with `CI result` (literal parts are
      regex-escaped);
    - a name with an unbalanced `(` before an expression, which must not throw.
  - The real repository passes.
- **Executed steps.** Both the aggregate step and the guard step are extracted from **both**
  real workflows. Each is written to a temp file (removed in `finally`) and run as GitHub
  runs a step with no `shell` key: `bash -e <file>`.
  - Aggregate step:
    - `NEEDS` comes from fixtures of the documented shape, `outputs` included.
    - Every C2 acceptance row asserts an exit status of exactly 0 or 1, plus a stdout
      marker.
  - Guard step:
    - It runs with `CHANGED_FILES` = 0, 2999, 3000, 3001, empty and `abc`, and
      `GITHUB_OUTPUT` pointing at a temp file.
    - It must exit 0 for every input.
    - It must write `small=true` for 0 and 2999, and `small=false` for the other four.
      `small=false` must be asserted present, not inferred from `small=true` being absent.
  - `jq` absent is a failure, not a skip: a sentinel cell asserts that `jq --version` exits
    0. jq is preinstalled on `ubuntu-latest`.
- **Filter list.**
  - One-time check, recorded in the deviation log: the parsed `filters.integration` list
    equals `on.pull_request.paths` from `git show main:.github/workflows/ci-integration.yml`.
    This is what catches a pattern that was narrowed or dropped in the move.
  - A permanent cell asserts that every filter pattern in both workflows matches at least
    one `git ls-files` path under picomatch `{dot:true}`. It catches a pattern that matches
    nothing.
    - picomatch is transitive here (2.3.2), and paths-filter bundles its own copy. The cell
      is a typo net, not a proof of identical matching.
- **Red-proof.**
  - Gate: one mutation per clause id, run on scratch copies (vitest alias).
  - Aggregate step:
    - `exit 0`;
    - drop the empty check;
    - drop the unknown-value arm;
    - treat a missing or `null` result as skipped;
    - swallow the jq parse error.
  - Guard step: invert the comparison.
  - Each mutation turns its named cell red, and the unmutated control stays green.
- **CI, VE1, in this order:**
  1. This PR, before merge: both workflows run in full and both aggregates conclude
     `success`. Read back per name, newest first:
     `gh api 'repos/:owner/:repo/commits/<sha>/check-runs?check_name=CI%20result' --jq '.check_runs|sort_by(.completed_at)|last|[.name,.conclusion,.app.id]'`
     (and the same for `Integration result`). This also confirms the exact names and app id
     15368.
  2. Merge this PR. Merging changes no merge rule. From the new `main`, open scratch PRs A
     and B.
  3. PR A touches only `docs/archive/**`. Expected:
     - both `changes` jobs succeed;
     - every `ci.yml` job gated on a filter is skipped;
     - `integration` and `jackson-probe` are skipped;
     - both aggregates succeed.
  4. PR B has a deliberately failing vitest cell. It also forces the jackson-probe step to
     fail for the `1.42.0` entry only. The failure goes inside the existing probe step's
     `run`, as `if [ "$JACKSON_VERSION" = 1.42.0 ]; then exit 1; fi`, not as a step-level
     `if`, which rule 11 would reject. Expected:
     - `integration`: `success`;
     - `jackson-probe (1.42.0)`: `failure`;
     - `jackson-probe (1.52.2)`: `success`;
     - `Integration result`: `failure`, which shows the matrix collapse;
     - the failing `app-test` shard is the only failed `ci.yml` job;
     - `CI result`: `failure`.
  5. Only then SC2. Afterwards B's `gh pr view --json mergeStateStatus,statusCheckRollup`
     reads `BLOCKED`, with the two aggregates failing. The ruleset requires 0 approvals, so
     the block comes from the checks. A reads `CLEAN`, or `BEHIND` if `strict` is on and
     `main` moved. Both scratch PRs are then closed unmerged.

## Considerations & constraints

### Scope contract

- **SC1** — `codeql.yml` is the only other `pull_request` workflow. It stays unrequired in
  this PR.
  - The other workflows run only on `schedule`, `workflow_dispatch`, `push` or
    `merge_group`.
  - Requiring CodeQL, through a ruleset `code_scanning` rule or C3's map, is a follow-up
    issue.
- **SC2** — the ruleset change, after merge, after user confirmation. The user also decides
  `strict` (require the branch up to date). The recommendation is `true`, with the cost
  that each PR must be updated before merge.
- **SC3** — repository Actions settings, a follow-up the user decides on:
  - the fork-PR approval policy (`first_time_contributors` → `all_external_contributors`);
  - `sha_pinning_required`;
  - `can_approve_pull_request_reviews: false`.

### Other considerations

- Cost: every PR now starts `ci-integration.yml`. An irrelevant PR pays only for `changes`
  and the aggregate.
- `ci.yml`'s `cancel-in-progress` cancels superseded runs, and their aggregate concludes
  failure. Only the latest run on the head SHA matters, so this is harmless. (Corrected in
  code review round 1: this held only once the gated jobs moved from `always()` to
  `!cancelled()`. GitHub keeps a running job whose `if` is still true at cancellation.)

## User operation scenarios

- A docs-only PR: both aggregates pass, nothing heavy runs, and the PR is mergeable.
- A PR touching `src/lib/auth/session.ts` with a red integration cell: `Integration result`
  fails, and after SC2 the PR cannot merge.
- A contributor adds a job to `ci.yml` and forgets the aggregate, or gives a job
  `if: github.actor != 'x'`: `static-checks` fails on C3 and names the job.
- A PR retargeted to `main`: no run starts until the next push (C4 recovery note).

## Go/No-Go Gate

| ID | Subject                                                  | Status |
|----|----------------------------------------------------------|--------|
| C1 | ci-integration always starts; `changes` gating; size cap | locked |
| C2 | aggregate jobs and their decision                        | locked |
| C3 | gate keeping aggregates and gating complete              | locked |
| C4 | header, CONTRIBUTING, Test 9, supply-chain header, ops   | locked |
