# CI required checks

Once the ruleset rule below is added, `main` accepts a pull request only when two checks
have passed. Both must come from GitHub Actions (integration id 15368):

| Check | Job | Workflow |
| --- | --- | --- |
| `CI result` | `ci-result` | `.github/workflows/ci.yml` |
| `Integration result` | `integration-result` | `.github/workflows/ci-integration.yml` |

Each is an aggregate job that runs on every pull request into `main`:

- It **fails** when any other job in its workflow failed or was cancelled.
- It **passes** when every job either succeeded or was skipped because its path gate decided
  the change was irrelevant.

The individual jobs are not required one by one. Their names change with a matrix, and a job
that never runs would leave a required check pending forever.

Both workflows trigger on `pull_request` with `branches: [main]` and nothing else. A required
check is matched by name on the head commit, so a run of the same commit in a pull request
into another branch (where the path filter compares against a different base) must not be
able to report the check for a pull request into `main`.

The rule lives in the repository ruleset "Protect main", as a `required_status_checks` rule.
It is added by a repository admin once the aggregate jobs are on `main`. Until then, neither
check blocks a merge.
Read it back with:

```bash
gh api repos/:owner/:repo/rules/branches/main --jq '.[] | select(.type == "required_status_checks") | .parameters'
```

## What keeps the aggregates complete

`scripts/checks/check-required-aggregate.mjs` runs in `pre-pr.sh` and in the `static-checks`
CI job. It fails when an aggregate:

- does not need every other job of its workflow;
- changes its name;
- loses `if: always()`.

The gated jobs use `!cancelled() && (…)` rather than `always() && (…)`. GitHub keeps a running
job whose `if` is still true when its run is cancelled, so `always()` would let a superseded
run keep its jobs running despite `cancel-in-progress`. The aggregates keep `always()`, so a
cancelled run whose jobs were running or queued reports red.

Status functions such as `cancelled()` are valid only in a job's or step's `if`. The gate fails
any workflow that uses one elsewhere, because GitHub would reject the whole file before any job
runs, and no required check would be posted.

It also fails when:

- a workflow has any trigger besides `pull_request`, or that trigger filters paths or types,
  or targets anything but `branches: [main]`;
- a job-level `if` or step-level `if` falls outside the known forms (a skipped job counts as
  a pass, so an unexpected skip condition is treated as a failure);
- `continue-on-error` appears;
- any workflow calls `always()`, `failure()`, `cancelled()` or `success()` outside an `if`;
- the `changes` job loses its large-PR guard, its `|| 'true'` output fallbacks, or gains a
  path-filter input other than `filters`;
- another workflow reuses a required check name.

## What the aggregates do not protect against

The aggregate step, the gate and `pre-pr.sh` all run from the pull request's own head. A
change to any file that CI executes or reads can make them pass:

- workflows and `scripts/**`;
- `package.json`, `package-lock.json`, `patches/`, `.npmrc`, `.nvmrc`;
- test configuration and the tests themselves.

The aggregates stop *accidental* red merges. For a pull request that touches those files, the
control is the maintainer reading the diff. `.github/CODEOWNERS` records owners, but neither
the ruleset nor the classic branch protection requires code-owner review.

## When a required check is missing or red

- **A pull request retargeted to `main`.** Retargeting raises the `edited` event, which neither
  workflow listens to. No run starts until the next push. Push a commit, or close and reopen
  the pull request.
- **Only `changes` failed.** A paths-filter API error, for example, turns the aggregate red even
  when every other job passed. Re-run the failed job.
- **A run cancelled by hand between two jobs.** A gated job that the cancelled run never got to
  evaluate concludes `skipped`, which the aggregate cannot tell apart from a path-filter skip.
  If no job was running or queued at that moment, `CI result` can report success on that
  commit. Cancelling because of a new push is not affected (the new commit has its own checks).
  After a manual cancel, re-run the workflow before merging.
- **3000 or more changed files.** The PR files API lists at most 3000 files, so both `changes`
  jobs skip the filter and run every job.

## Merge queue

Neither workflow listens to `merge_group`. Enabling a merge queue requires adding that
trigger to both workflows first. Otherwise the required checks never report in the queue.
