# Coding Deviation Log: team-item-key-id-check

- D1 (C4, backfill cell): the first run's NOTICE counts are asserted literally, and the block
  counts every row in the database (it runs under the bypass, holding ACCESS EXCLUSIVE). The
  counts are exact under two conditions:
  - no other process commits team entries to the database while the cell runs. The integration
    config sets `maxWorkers: 1`, so files run serially;
  - the database holds no rows in a repairable shape. M1 repaired them when it was applied, and
    from then on the CHECKs and the 0.5.0 writers keep it that way.

  One early run went red with `high_water` 10 instead of 7. Two agents were running integration
  files against `passwd_sso_wt_1011` at the same time, and the database was clean again right
  after. Every later serial run was green.
- D2 (C4, table-list cells): beyond the plan, each table-list cell seeds the backfill cell's
  shapes after dropping the constraints. With one clean row, the histories case was refused only
  through step 7. PostgreSQL evaluates leakproof predicates (`IS NOT NULL`) before the RLS policy,
  so steps 4 and 5 never reached the policy. Mutant 13 exposed this.
- D3 (C4, lock cell (b)): the cell manages its own BEGIN/ROLLBACK instead of `inRolledBackTx`.
  This lets it release B and wait for the parked block before rolling back on the same client.
  A failing assertion is then reported as itself, instead of a 30 s timeout and the pool's
  concurrent-query error.
- D4 (C4, red proofs 10 and 17): the plan named VALIDATE as the red assertion. Both go red
  earlier, at the post-state map of the same cell.
- D5 (C4, writers rerun describe): `asApp` now connects through `ctx.su.pool`. It sets up the
  pre-change state, then runs `SET LOCAL ROLE passwd_app`, then the principal check (which now
  also asserts the name `passwd_app`). The red proof re-ran 20261110's block with its bypass
  removed through `RLS_BACKFILL_RERUN_SQL`: 10 cells went red. Control and I1 stayed green, as
  expected: the control runs the original 20261104 block, and I1 compares two runs that both
  change nothing.
- D6 (C6, grants manifest): `node scripts/audit-db-grants.mjs` against `passwd_sso_wt_1011`
  reports only DATABASE-level entries (keyed to the database name `passwd_sso`) and DEFAULTACL
  entries from this worktree's setup. No table, column, function or role entry differs, so
  `scripts/checks/db-grants-manifest.json` is unchanged.
- D7 (verification environment, no code change): the first full `npm run test:integration` on
  `passwd_sso_wt_1011` failed 15 tests in three files (audit-db-grants, retire-dcr-cleanup-worker,
  revoke-public-connect). This worktree's database was created with
  `passwd_dcr_cleanup_worker=c/passwd_user` in its ACL. Migration 20261023010000 revokes that
  grant only on the database it runs in, and the role is cluster-global. After
  `REVOKE ALL ON DATABASE passwd_sso_wt_1011 FROM passwd_dcr_cleanup_worker`, the state that
  migration intends, the three files pass (69/69). The other 170 files passed in the full run.
  audit-db-grants passing also confirms D6: the manifest matches.
