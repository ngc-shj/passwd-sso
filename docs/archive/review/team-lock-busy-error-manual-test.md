# Manual Test: team-lock-busy-error

Issue `#1021`. Plan: `team-lock-busy-error-plan.md`. A team writer whose bounded wait for
the team row lock times out (3 s) now answers `409 TEAM_BUSY` with `Retry-After: 3`
instead of `TEAM_KEY_VERSION_MISMATCH`, and the web client explains or retries it.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied, dev server running.
- A team "core" with an OWNER (vault unlocked, holds the team key), an ADMIN and a MEMBER.
- A `psql` session as the migration role (`MIGRATION_DATABASE_URL`) to hold the team row
  lock. In every step below, "hold the lock" means:

  ```sql
  BEGIN;
  SELECT id FROM teams WHERE id = '<teamId>' FOR NO KEY UPDATE;
  -- perform the browser action, then:
  ROLLBACK;
  ```

## Steps and expected results

1. Hold the lock; as the OWNER, save an edit to a team entry.
   - Expected: after ~3 s the form shows the "another change is in progress" message;
     the entry is unchanged. Release the lock and save again → success.
2. Hold the lock; as the OWNER, change the MEMBER's role in the admin member list
   (`/admin/teams/<teamId>/members/list`).
   - Expected: toast "Another change to a team is in progress. Please try again in a
     moment." — not a generic failure toast. The role is unchanged.
3. Same as step 2 with Remove member.
   - Expected: the same toast; the member stays listed.
4. Hold the lock; transfer ownership to the ADMIN
   (`/admin/teams/<teamId>/members/transfer-ownership`).
   - Expected: the same toast; ownership unchanged. Without the lock → success.
5. With a SCIM-pending member (see `scim-team-admission-approval-manual-test.md`), hold
   the lock and click Approve, then Reject.
   - Expected: "Another change to this team is in progress. Try again in a moment.";
     the row stays pending.
6. Hold the lock for ~10 s while importing a small CSV into the team.
   - Expected: the import waits and completes after the lock is released; no entry is
     duplicated or missing.
7. Start a team key rotation's re-key pass, hold the lock for ~10 s mid-pass.
   - Expected: the pass pauses and resumes after release; it does not stop with a
     key-version error.

## Adversarial scenarios

- A genuine key-version mismatch (submit an entry with a stale `teamKeyVersion` after a
  rotation, no lock held) → still `409 TEAM_KEY_VERSION_MISMATCH`, not `TEAM_BUSY`.
- Hold the lock for the whole re-key pass (> 10 waits) → the pass stops with the
  retry-budget message instead of waiting forever.
- Admin vault reset and SCIM writes under the held lock keep answering `CONFLICT`.

## Rollback

Revert the branch's commits and redeploy. No schema or data change; clients treat an
unknown 409 code as a generic failure.
