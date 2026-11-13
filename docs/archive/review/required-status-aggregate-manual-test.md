# Manual Test: required-status-aggregate

Issue `#958`. Plan: `required-status-aggregate-plan.md`.

Tier: **R35 Tier-1 (CI/CD workflows)**. Whether a job is skipped, how a matrix job reports and
how a workflow that never started reports to branch protection can only be observed on GitHub
(plan VE1).

## Pre-conditions

- `gh` is authenticated as a repository admin.
- Read-back helper (newest run per name):

  ```bash
  check() { gh api "repos/:owner/:repo/commits/$1/check-runs?check_name=$(printf %s "$2" | jq -sRr @uri)" \
    --jq '.check_runs | sort_by(.completed_at) | last | [.name, .conclusion, .app.id]'; }
  ```

## Steps and expected results

1. On this PR's head SHA, before merge:
   - `check <sha> "CI result"` → `["CI result","success",15368]`
   - `check <sha> "Integration result"` → `["Integration result","success",15368]`
   - `integration` and both `jackson-probe` entries ran, since this PR touches
     `ci-integration.yml`.
   - Every gated job in both workflows evaluated its `!cancelled() && (…)` condition; the
     run raised no workflow-syntax error (the leading `!` is quoted in YAML).
2. Merge this PR. Merging changes no merge rule. Then branch scratch PRs A and B from the
   new `main`.
3. PR A edits one file under `docs/archive/`. Expected:
   - both `changes` jobs succeed;
   - every filter-gated `ci.yml` job is skipped;
   - `integration` and `jackson-probe` are skipped;
   - `CI result` and `Integration result` both succeed.

   A scratch PR into a branch other than `main` starts neither workflow.
4. PR B makes two deliberate failures:
   - It adds a failing vitest cell.
   - It adds `if [ "$JACKSON_VERSION" = 1.42.0 ]; then exit 1; fi` at the top of the probe
     step's `run`, not as a step-level `if`, which the gate rejects.

   Expected:
   - `integration`: `success`;
   - `jackson-probe (1.42.0)`: `failure`;
   - `jackson-probe (1.52.2)`: `success`;
   - `Integration result`: `failure`, which shows the matrix collapse;
   - the failing `app-test` shard is the only failed `ci.yml` job;
   - `CI result`: `failure`.
5. On PR B, push a second commit while the first run's `app-test` shards are still running.
   Expected, on the superseded run:
   - its running gated jobs conclude `cancelled`, and `e2e` never starts;
   - its `CI result` concludes `failure` (the aggregate keeps `always()`).

   The new run on the new head SHA proceeds as in step 4.
6. Only after steps 1–5 pass, and after the user confirms (plan SC2), add the rule to
   ruleset 13001033 "Protect main". The PUT carries its existing `pull_request` and
   `deletion` rules plus `required_status_checks` with:
   - `CI result` and `Integration result`, each `integration_id: 15368`;
   - `strict` as the user decides.

   Read it back:

   ```bash
   gh api repos/:owner/:repo/rules/branches/main --jq '.[] | select(.type == "required_status_checks")'
   ```
7. `gh pr view <B> --json mergeStateStatus,statusCheckRollup` → `BLOCKED`, with the two
   aggregates failing. The ruleset requires 0 approvals, so the checks are what blocks it.
   PR A reads `CLEAN`, or `BEHIND` when `strict` is on and `main` moved.
8. Close A and B unmerged.

## Adversarial scenarios

- A job added to `ci.yml` without being listed in `ci-result.needs` → `static-checks` fails on
  `check-required-aggregate.mjs`.
- A job given `if: github.actor != 'x'`, or a step given a skip condition → the gate fails.
- `continue-on-error: true` anywhere in either workflow → the gate fails.
- Another workflow defining a job named `CI result` → the gate fails. The ruleset's
  `integration_id` also refuses a status posted by a different app.

## Rollback

- To stop the requirement: remove the `required_status_checks` rule from the ruleset.
- To restore the old trigger: revert this PR's commits. The ruleset rule must be removed
  first, or every PR waits on checks that no longer exist.

<!-- scratch #958 verification A: docs-only change; this PR is closed unmerged -->
