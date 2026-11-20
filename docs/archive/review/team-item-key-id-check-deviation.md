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
  after. Every later serial run was green. The Phase 2 self-check (RT11) asked for the second
  condition not to be assumed. The cell now runs the block once in its own transaction before
  seeding, which repairs any committed residue (from a crashed run elsewhere, say), so the literal
  counts depend only on the cell's rows. The first condition still holds.
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
- D8 (C4, red-proof record): after the self-check changes, every block mutant was run against
  the final test file through `TEAM_ITEM_KEY_ID_CHECK_SQL` (a mutated copy outside the source
  tree), and each failed. The cells that failed:
  - the backfill cell (its post-state map, counts or settings check), for 1 (v0 clear removed),
    2 (adopt removed), 3 (adopt picks one of several), 4a (wrap equality on three columns),
    4b (`IS NOT DISTINCT FROM`), 5 (id'd entries relabelled), 6 (marker reset removed),
    7 (marker-only arm removed), 8 (marker-only ignores the marker), 9 (marker-only on every
    id), 10 (history v0 clear removed), 11 (link generalised), 12 (link removed) and
    14 (settings restore removed);
  - for 13 (high-water removed), the backfill cell and the attachments table-list control;
  - for 15 (lock removed), lock cells (a) and (b);
  - for 16 (lock after the updates), lock cell (b);
  - for 17 (bypass removed), the backfill cell and all three table-list controls.

  In the writers file, the A10 tail now runs M1's own `ADD CONSTRAINT` statements
  (`teamItemKeyIdCheckAlters` in helpers.ts) instead of a hand copy. A scratch tree that links
  every path except a copy of M1 with the entries CHECK replaced by `CHECK (true)` turned A10 red
  ("expected null to match object { code: '23514' }"). The same tree with an unchanged copy
  passed.
- D9 (code review round 1, step 4 widened): step 4 now also resets the marker in two cases:
  - (a) the marker is above `GREATEST(team_key_version, 1)`;
  - (c) the entry's id is carried at another version by a history row or an attachment CEK.

  The backfill cell seeds a case each arm moves and an allow twin for each, plus the testing
  review's wrap-equality controls for steps 4(b) and 6 and two attachments on a minted entry. Its
  counts are now `stale_pending` 6 and `high_water` 9; the rest are unchanged. Only one existing seed changed
  state: `ctlTeamKeyVersion`'s high-water, raised by the two attachments added to it. D10 moves
  those attachments to a seed of their own.

  All mutants were regenerated from the widened file (`mutants-r3`): the 17 old ones (07–09
  re-targeted, keeping their meaning) and 15 new ones:
  - (a) removed, `>=`, and bare `team_key_version`;
  - (c1) and (c2), each removed or with `<>` dropped;
  - 4(b) and step 6 reduced to 3 columns, to each single missing column, and to
    `IS NOT DISTINCT FROM`.

  Every mutant turned the cell named in D8 red; every new one failed the backfill cell on the seed
  meant to catch it.

  helpers.ts mutants were run from a scratch symlink tree:
  - dropping the attachment term of `REPAIRED_ROLLOUT_ENTRY.highWater` turned the guard red;
  - so did `?? 0` → `?? 4`;
  - `?? 0` → `?? 1` survives. It is an equivalent mutant: the helper only computes v1+ entries,
    whose max is already at least 1.

  `npm run test:integration` passes in full: 173 files, 2396 tests.
- D10 (code review round 2, testing T4–T6): the backfill cell gains three seeds.
  - `aFloorStale` (marker 2, `team_key_version` 0) is the deny case at arm (a)'s `GREATEST` floor.
    `aZeroTkv` is its allow twin.
  - `c1Below` and `c2Below` carry the entry's id at a lower version. `c1Below`'s carrier is a v0
    history row with the entry's id, which also pins step 4 running before step 5.
  - The attachments that covered the `highWater` term moved from `ctlTeamKeyVersion` to a minted
    seed of their own, `mintAttachments`.

  The counts are now `ids_minted` 6, `stale_pending` 9, `history_v0_ids_cleared` 2,
  `history_ids` 4 and `high_water` 10.

  Every mutant was re-run against the final file (`mutants-r4`, 37 SQL mutants), and each failed in
  the cell named in D8/D9. The new ones failed only on their target seed:
  - `GREATEST(…, 2)`;
  - `<>` → `>` in (c1);
  - `<>` → `>` in (c2);
  - step 5 moved before step 4.

  The `highWater` attachment-term mutants fail on `mintAttachments`. `?? 1` stays the equivalent
  survivor (D9).
