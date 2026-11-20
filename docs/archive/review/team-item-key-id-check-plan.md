# Plan: team-item-key-id-check (#1011)

## Project context

- Type: web app (Next.js + Prisma + PostgreSQL 16); the change is a schema migration, a gate, tests, docs.
- Test infrastructure: unit + integration (real-DB, `npm run test:integration`) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: no RDS here. The RDS migrate role (NOSUPERUSER NOBYPASSRLS, owner of the tables) is
    emulated in a rolled-back transaction by a transaction-local `NOLOGIN NOSUPERUSER NOBYPASSRLS`
    role made a member of the table owner (the `enterBypassRole` pattern, helpers.ts), on this
    worktree's database `passwd_sso_wt_1011` (RLS enforce mode). `verifiable-local`.
  - VE2: no live 0.4.77 instance to replay the 0.4.77 → 0.5.0 rollout window; the rows such an
    instance writes are seeded by raw SQL (shapes from `git show passwd-sso-v0.4.77:<path>`).
    `verifiable-local`.
  - VE3: production data is unreachable. Read-only count on the dev DB `passwd_sso` (superuser,
    count only): `(v1+, id NULL)` 0, `(v0, id)` 0, of 53 entries; `passwd_sso_wt_1011`: 0 entries.
    So the repair is proved on seeded rows only.

## Objective

Add `CHECK ((item_key_version = 0) = (item_key_id IS NULL))` on `team_password_entries`
(`team_password_entries_item_key_id_iff_item_key`, the name #988 planned). #988 held it back (D41
in `docs/archive/review/team-key-rotation-rekey-deviation.md`) because the deploy migrates before
it rolls the services. 0.5.0 (`dfe26139b`) is released and deployed. Before adding the CHECK,
repair the rows the 0.4.77 → 0.5.0 rollout window may have left.

**Premise (enforced by documentation, not by code):** the instances serving while this migration
runs are 0.5.0. A deploy that skips 0.5.0 (0.4.x → this release) runs 20261104, 20261110 and
this migration back to back while 0.4.77 serves. That reintroduces D41: 0.4.77 v1 creates and
upgrades fail with 23514 → 500. deployment.md gains the requirement to upgrade through 0.5.0 (C6).
A code guard was rejected: no reliable signal tells "applied in an earlier deploy" apart from
"applied seconds ago in this one". `_prisma_migrations.finished_at` is the only candidate, and
on a fresh install every migration legitimately runs in one deploy.

## Derivations

### D-a: rollout-window writers (0.4.77, `git show passwd-sso-v0.4.77:<path>`) and their shapes

0.4.77 knows none of `item_key_id`, `item_key_team_key_version` (the marker) or
`item_key_version_high_water`.

| 0.4.77 writer | Resulting entry state |
|---|---|
| create / bulk import of a v1 entry | (v1, NULL), marker 0, high-water 0 |
| full-update PUT v0→v1 upgrade | (v1, NULL), marker kept, high-water kept; history snapshot with NULL id |
| full-update PUT reusing the ItemKey | id kept (correct), history snapshot with NULL id and wrap equal to the entry's |
| history restore of a v0 row | (v0, id kept), marker kept |
| history restore of a v1+ row onto a NULL-id entry | (v1+, NULL), marker kept |
| history restore of a v1+ row onto an id'd entry | (v1+, id kept) — a stale label when the row holds another ItemKey (F5 of #988) |
| rotate-key | re-wrap only; correct |

0.5.0 snapshots then copy whatever pair the entry has into history. A (v0, X) entry therefore
also produces (v0, X) **history** rows (round-1 F1).

### D-b: what the block does to each shape (mirrors the 0.5.0 restore rule)

0.5.0's restore is the only 0.5.0 writer that sets an existing ItemKey's identity
(`history/[historyId]/restore/route.ts`). It writes the row's id, or mints one for an unknown
identity, and writes marker 0 unless the key is the live one. The block applies the same rule.
Every row it changes also gets marker 0, which puts it in the re-key pass. The re-key replaces
the ItemKey, so whatever a repair could not prove is settled there.

Identity evidence uses the 5-column equality of the 20261104/20261110 link step (round-2 S6):
`encrypted_item_key, item_key_iv, item_key_auth_tag, team_key_version, item_key_version`, all
equal, and none of them NULL (plain `=`). Two such wraps are the same ItemKey: AES-GCM
ciphertext and tag under a random 96-bit IV, and the "IK" AAD binds the entry and the team key
version. Unequal wraps prove nothing, because rotation re-wraps. For an entry e, H(e) is the set
of distinct non-NULL `item_key_id` values of e's history rows whose wrap equals e's wrap.

One ItemKey can legitimately carry two labels on clean 0.5.0 data (round-2 F1). The 0.5.0
restore mints a fresh id each time it restores a NULL-id v1+ row (`row.itemKeyId ??
crypto.randomUUID()`), so restoring the same row twice leaves the entry at (W, Z′) with a
history snapshot (W, Z). Attachments uploaded since are bound to Z′. "Equal wrap under another
id" is therefore not proof of a stale label, and the block never relabels an entry that has an
id. It sets an id only where the CHECK requires one.

| Entry shape | Action (all set marker 0) |
|---|---|
| v0, id non-NULL | id := NULL |
| v1+, id NULL, \|H\| = 1 | id := the one id in H (identity proven; attachments bound to it then match the live wrap) |
| v1+, id NULL, \|H\| ≠ 1 | id := gen_random_uuid() |
| v1+, id X, marker > 0, some id in H ≠ X | marker 0 only; the id is kept (round-3 S9) |
| anything else | untouched |

Why the marker-only arm is decidable when the label is not (round-3 S9):
- The 0.5.0 restore that creates a double label writes marker 0, because the key is not the live
  one.
- Restoring the same key keeps that 0.
- The only 0.5.0 writers that set a marker above 0, create and re-key, also write a fresh wrap,
  which leaves H empty.
- The v0→v1 upgrade PUT keeps the marker but writes a fresh wrap (`itemKeyIvReused`) and a fresh
  id.
- Reuse PUT and rotation never write the marker.
- The 20261110 step-1 marker set needs high-water 0, and a restore always raises it.

So "an equal-wrap history id ≠ X with marker > 0" comes only from a 0.4.77 restore of an id'd
row (F5), which keeps the entry's marker. Without this arm, such an entry is not pending: its
ItemKey may predate a rotation, and the re-key POST refuses it with `REKEY_NOT_PENDING`. Moving
no label means attachments bound to X keep matching, and the pass recovers CEKs by trial.

Then, in order:
- **Histories (v0, id non-NULL):** id := NULL. A v0 row holds no ItemKey.
- **History link, for the entries the block set an id on:** NULL-id history rows whose wrap
  equals the entry's get the entry's id. This is not run generically: a generic run would also
  label the source row of an undecidable stale restore.
- **High-water (raise only):** the 20261110 step 2 statement again. 0.4.77 never raised it, so
  a later 0.5.0 upgrade could reuse a version number (round-1 F4).

Every repaired row stays decryptable, because no wrap or blob is touched. Every repaired row
stays pending at least as long as it was before, because marker 0 is below every team version
(team versions below 1 normalise to 1). Stale labels on id'd entries are not repaired (SC1):
the labels cannot tell them from the legitimate double labels above.

### D-c: other tables carrying the pair

The member set comes from `grep -rn "item_key_id" prisma/migrations/*/migration.sql`. Only
20261104000000 adds such columns: the entries one, the histories one, and
`attachments.cek_item_key_id`.

- **`team_password_entry_histories`:** the biconditional is false by design. A v1+ row with a
  NULL id means "identity unknown": `itemKeyIdsMatch` never matches NULL, and the re-key listing
  counts these rows (`IS DISTINCT FROM`). The one-way rule `item_key_version <> 0 OR item_key_id
  IS NULL` is true for every writer once entries satisfy their CHECK:
  - snapshots copy the entry's pair;
  - re-key writes (≥1, id);
  - the link step touches v1+ rows only.

  It is added as `team_password_entry_histories_v0_no_item_key_id`, NOT VALID + VALIDATE. Without
  it, the restore route's `sameItemKey` check, which runs before `row.itemKeyVersion === 0`,
  could copy (v0, X) back onto an entry and hit 23514.
- **`attachments (cek_key_version, cek_item_key_id)`:** a mode-2 row with a NULL id is legitimate.
  The download route falls back to trial wraps when `cek_item_key_id` is NULL. No constraint.

### D-d: locks

The block's first statement is `LOCK TABLE team_password_entries, team_password_entry_histories
IN ACCESS EXCLUSIVE MODE`, in the app's order: entries, then histories. That way neither ADD
CONSTRAINT is a lock upgrade (round-2 F2: the histories UPDATEs would otherwise hold ROW
EXCLUSIVE and then need ACCESS EXCLUSIVE).

- Every writer of these columns needs an entries lock first: entry writes, history writes
  (always under the entry's FOR UPDATE), and rotation's updateMany. So none of them can hold
  something the block waits on.
- The block takes no lock before this one, so it holds nothing anyone else waits on.
- Taking ACCESS EXCLUSIVE up front means `ADD CONSTRAINT` later is not a lock upgrade.
- The `teams … FOR SHARE` of 20261110 is dropped. Under ACCESS EXCLUSIVE it protects nothing, and
  holding every team row while queuing for the table lock closes a cycle with any transaction
  that locks entries and then a team row (round-1 F5).

| Step | Lock |
|---|---|
| LOCK TABLE entries, histories | ACCESS EXCLUSIVE on both. Waits for every in-flight transaction on either table; new readers and writers queue behind it. The stall is the longest in-flight transaction on either table plus the block's scans. |
| UPDATE entries / histories | covered by the held lock |
| SELECT attachments (high-water) | ACCESS SHARE |
| ADD CONSTRAINT … NOT VALID ×2 | ACCESS EXCLUSIVE on both, already held. No scan. |
| M2 VALIDATE ×2 | SHARE UPDATE EXCLUSIVE per table. A full scan while reads and writes continue. |

M2 is a separate migration: VALIDATE inside M1 would scan while M1 holds ACCESS EXCLUSIVE.
Prisma runs each file as-is with no wrapping transaction (check-migration-transaction.mjs
header). If the deadlock detector or the 23514 of VALIDATE aborts a migration, `prisma migrate
deploy` records it as failed (P3009). The operator then resolves it and redeploys.

## Contracts

### C1 — M1 `prisma/migrations/20261120000000_team_item_key_id_check/migration.sql`

- Shape: `BEGIN;` then a DO block between `-- BEGIN BACKFILL team-item-key-id-check` and
  `-- END BACKFILL team-item-key-id-check`, then the two `ADD CONSTRAINT … CHECK (…) NOT VALID`
  statements, then `COMMIT;`.
- **Bypass:** the block sets `app.bypass_rls=on`, `app.bypass_tables=
  team_password_entries,team_password_entry_histories,attachments`,
  `app.bypass_purpose=system_maintenance` and `app.tenant_id=<nil uuid>`, all
  transaction-locally. It restores them at the end, following 20261116200000.
- **Steps:** the D-b steps, in the D-d lock order.
- **NOTICE:** one line, `'team-item-key-id-check backfill: v0_ids_cleared=% ids_adopted=%
  ids_minted=% stale_pending=% history_v0_ids_cleared=% history_ids=% high_water=%'`. `prisma migrate deploy` does not print NOTICEs. They appear in the server log
  (log_min_messages ≤ notice) or when the file is run through psql, and are diagnostic only.
- **Role:** the block behaves the same on every role, with no `rolsuper`/`rolbypassrls` branch.
  Every step is predicate-guarded, so it is idempotent and a no-op on clean data.
- **Invariants (schema-enforced from commit):** entries satisfy the biconditional; histories
  satisfy the one-way rule.
- **Control class:** `enforceable boundary`. The adjudication authority is PostgreSQL's CHECK
  evaluation, and it applies to every writer.

### C2 — M2 `prisma/migrations/20261120000100_team_item_key_id_check_validate/migration.sql`

- Two `ALTER TABLE … VALIDATE CONSTRAINT …` statements in `BEGIN;/COMMIT;` (two DDL statements,
  so the transaction gate requires the wrapper). Each takes SHARE UPDATE EXCLUSIVE on its own
  table.
- **Failure:** fails closed with 23514 if any row violates. After C1 under its lock that cannot
  happen.
- **RLS:** constraint validation is not filtered by RLS. This is proved in C4.
- **Acceptance:** `pg_constraint.convalidated` is true for both constraints.

### C3 — 0.5.0 writer member set (neither CHECK refuses what the release live during M1 writes)

Derivation:

```
grep -rnE "teamPasswordEntry(History)?\.(create|createMany|update|updateMany|upsert)\b|(INSERT INTO|UPDATE) \"?team_password_entr" src scripts | grep -v test
```

plus the callers of each match.

| Writer | Path | Entry (version, id) | History (version, id) |
|---|---|---|---|
| create / bulk import | `createTeamPassword` | `≥1 → uuid`, `0 → NULL` | — |
| full update | `resolveFullUpdateItemKey` | upgrade (≥1, uuid); v0 edit (0, unchanged); reuse (unchanged, id must match the locked non-NULL id); downgrade refused | snapshot = entry pair |
| metadata / archive / trash / restore-from-trash / folder detach | service + bulk routes | untouched | — |
| history restore | `restore/route.ts` | v0 row → NULL; same key → cur id; else row id ?? uuid | snapshot = entry pair |
| rotate-key | `rotate-key/route.ts` | untouched | untouched |
| re-key | `passwords/[id]/rekey/route.ts` | (high-water+1, uuid) | (new version ≥1, uuid) |
| seed SQL | `scripts/rls-cross-tenant-seed.sql` | defaults (0, NULL) | defaults |

Restore: after M1 no history row is (v0, id), and every v1+ history id came from an entry pair
or a re-key. So the pair restore writes satisfies the entry CHECK.

### C4 — tests

**New file:** `src/__tests__/db-integration/team-item-key-id-check.integration.test.ts`. Every
cell runs on one client in one rolled-back transaction, and every query in a cell uses that
client.

1. **CHECK cell, as `passwd_app`** on the migrated DB, with a SAVEPOINT per refused statement:
   - entries: INSERT (v1, NULL) and (v0, id) → 23514 naming the constraint; an UPDATE of an
     allowed row into each shape → 23514. In the same cell, (v0, NULL), (v1, id) and (v2, id)
     succeed.
   - histories: (v0, id) → 23514. (v0, NULL), (v1, NULL) and (v1, id) succeed.
   - both constraints have `convalidated = true`.
2. **Backfill cell, as the owner-shaped role.**
   - Setup on the superuser client: drop both constraints; seed in a tenant ≠ nil uuid. Every
     seeded entry has marker ≥ 1, so a missing marker reset is visible. Every arm that sets an
     id also has a NULL-id history row with an equal wrap, so a missing link is visible. Seeds:
     - repaired: (v0, X); (v1, NULL) with H = {Y}; (v1, NULL) with H = ∅; (v1, NULL) with
       H = {Y, Z} (minted, adopts neither); a history row (v0, X); high-water below the
       history max.
     - marker-only: (v1, X), marker ≥ 1, H = {Y}; and (v1, X), marker ≥ 1, H = {X, Y} (the
       arm reads "some id in H ≠ X"). Each gets marker 0; the id stays X.
     - (v1, X), marker ≥ 1, H = {X}: untouched.
     - high-water: one entry whose attachment `cek_key_version` is above both its own version
       and its history max.
     - untouched controls:
       - (v1, X), **marker 0**, H = {Y}: the restore-twice double label, with an attachment
         bound to X (the marker ≥ 1 rule above does not apply to this control);
       - (v1, X) with a NULL-id equal-wrap history row (not linked);
       - a (v1, NULL) entry whose only id'd history row matches in 3 wrap columns but differs
         in `team_key_version`, and one that differs in `item_key_version`, and one where the
         entry and the history row both hold NULL in `item_key_auth_tag` (round-3 V2). Each
         must be minted, not adopted.
   - The first run's NOTICE counts are asserted literally, per arm.
   - The post-state map compares ids literally (`= Y`, `= X`, `≠ every seeded id`), not as
     `hasId` booleans.
   - Enter the role: `CREATE ROLE <tx-local> NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE <owner>`,
     then `SET LOCAL ROLE`. Assert `rolsuper` and `rolbypassrls` are false and
     `pg_has_role(current_user, <owner>, 'USAGE')`.
   - Hidden control: the role sees 0 seeded rows without a bypass.
   - Run the block with GUC sentinels set before. Afterwards the sentinels are restored, and the
     post-state equals a literal map covering ids, markers, high-water and history ids.
   - ADD NOT VALID and VALIDATE as the role both succeed.
   - Run the block a second time: it changes nothing and the NOTICE counts are all 0.
3. **VALIDATE cell:** same setup minus the block. Hidden control (0 rows visible), then VALIDATE
   as the role fails with 23514. Allow twin: with no violator seeded, VALIDATE succeeds.
4. **Table-list control:** remove each of the three tables from `app.bypass_tables` in turn →
   42501 `RLS_BYPASS_NOT_GRANTED`, via `expectBypassRefusal`.
5. **Lock cells:** no DDL setup and no violating rows.
   - (a) Connection B holds `FOR UPDATE` on a clean entry. The block, with `lock_timeout`, fails
     55P03, and the error's `where` names the `LOCK TABLE` statement (precedent: the writers
     test's 55P03 cell asserts `where`).
   - (b) B holds the same lock, and the block runs on A with no `lock_timeout`. A third
     connection polls `pg_locks` until A's request is waiting. It then asserts A holds no
     granted lock on `team_password_entry_histories` or `attachments`: an UPDATE takes ROW
     EXCLUSIVE even when it matches no row, so a `LOCK TABLE` moved after the UPDATEs shows up
     here (round-3 V1). Then B releases its lock and A rolls back.

**Existing tests whose committed seeds the CHECK refuses** (enumerated in round 1):
- `team-key-rekey-writers.integration.test.ts`, A10 cell (~L380-450): drop the constraints inside
  its transaction. After the original block, re-ADD them as M1 does. The tail assertion becomes
  "the constraint exists and refuses (v1, NULL)".
- Same file, rerun describe `seedFixtures` (~L869-879, about 11 cells): commit the fixtures with
  ids. The helper is split in two (round-2 U4):
  - a setup step on a superuser client inside the cell's transaction: drop the constraints and
    null the ids;
  - an optional `SET LOCAL ROLE passwd_app`. After it, `asApp`'s principal check runs on the
    current user; the check moves after the role switch.

  The C1, I1 and table-list cells use both steps, with `expectBypassRefusal` on the superuser
  pool, which is pool-factory built. The I2 cells use only the setup step, because
  `enterBypassRole` needs a superuser current user. The 55P03 cell needs neither and stays on
  `appPool`.
- `team-rekey-pass.integration.test.ts`, the rollout cells at L1674, L1693 and L1737 are converted,
  not deleted (round-2 U1). Each seeds, as committed rows that satisfy the CHECK, what M1 makes of
  its previous-release input: a minted id, marker 0, high-water raised. The cells keep their
  assertions: the pass re-keys past the entry's own version; the v1 + mode-0 attachment migrate
  arm; edits work afterwards; and a reuse PUT with `itemKeyId: null` on an id'd entry is refused
  ITEM_KEY_CHANGED. L1758 keeps its id and stays. The repaired shape (marker 0; high-water =
  max(version, history max, attachments' `cek_key_version` max); a minted id) is one exported constant. The backfill cell asserts its
  minted entries match it, so the converted seeds cannot drift from what the block produces
  (round-3 V3).
- Verified non-members (round-1 T1): bulk-import-entry-isolation, foothold-write-gate,
  leftover-team-actor-authority, passwords-history-lost-update, share-departure,
  team-key-version-guard, tenant-member-passkey-revoke, team-rotate-key, team-entry-rekey,
  team-attachment-rekey, `e2e/helpers/team-rekey.ts`, `scripts/rls-cross-tenant-seed.sql`.

**Red proofs:** one per clause. Each runs on a scratch copy of M1, read through a new
`redProofOverride("TEAM_ITEM_KEY_ID_CHECK_SQL")` hook in `readBackfillBlock` that is refused under
CI, as the rerun hook already is. Each must redden the named cell:

| Mutant | Cell that must go red |
|---|---|
| v0-id clear removed | backfill map |
| adopt removed (always mint) | backfill map (H = {Y} entry ≠ Y) |
| adopt with \|H\| ≥ 2 (picks one) | backfill map (H = {Y, Z} entry) |
| equality on 3 columns, or `IS NOT DISTINCT FROM` | backfill map (the team_key_version / item_key_version / NULL-column controls) |
| relabel id'd entries with H = {Y} | backfill map (double-label control) |
| marker reset removed | backfill map (markers) |
| marker-only arm removed | backfill map (F5-shape marker) |
| marker-only arm ignores `marker > 0` | NOTICE counts (first run) and the second-run all-zero assertion |
| marker-only arm reads "every id in H ≠ X" | backfill map (H = {X, Y} marker) |
| history v0 clear removed | backfill VALIDATE |
| link generalised to all entries | backfill map (control row linked) |
| link removed | backfill map (each arm's link row) |
| high-water step removed | backfill map |
| GUC restore removed | sentinel assertion |
| LOCK TABLE removed | lock cell (a) (`where`) |
| LOCK TABLE moved after the UPDATEs | lock cell (b) (`pg_locks`) |
| bypass removed | hidden rows unchanged + VALIDATE fails |

The predicates are proved on this worktree's DB inside a rolled-back transaction. Replace the
entries CHECK with each one-sided half in turn, `version = 0 OR id IS NOT NULL` and then
`version <> 0 OR id IS NULL`; each half reddens exactly one refusal of the CHECK cell. Replace
the histories CHECK with `true`; that reddens the history (v0, id) refusal.

### C5 — destructive-migration gate learns `ADD CHECK`

- **New kind:** `ADD CHECK` in `scripts/checks/check-destructive-migration.mjs`. It matches `ADD
  [CONSTRAINT <name>] CHECK` and `ADD COLUMN … [CONSTRAINT <name>] CHECK` inside an `ALTER TABLE`
  statement, including `ONLY`, `IF EXISTS` and multi-subcommand forms.
- **Not matched:**
  - `CREATE TABLE … CHECK`, because a new table has no old writers;
  - `ALTER DOMAIN … ADD CONSTRAINT … CHECK`, because no domain is used (`grep -rn "CREATE DOMAIN"
    prisma/migrations` is empty), which is stated in the self-test;
  - `VALIDATE CONSTRAINT`.
- **Why:** SET NOT NULL is already flagged as narrowing. A hand-written CHECK narrows writes the
  same way, and it caused D41 without the gate noticing. Prisma never generates CHECKs. FK and
  unique additions, which Prisma generates for every relation, stay unflagged.
- **Baseline:** every migration the new kind flags that is not yet baselined gets a
  `predates the rule` entry with a per-migration reason. Round 1 listed 13 such migrations; the
  implementation list is produced by running the gate. Already-baselined directories whose
  reason names only other kinds have the reason extended with "(ADD CHECK)".
- **M1 entry:** M1 gets a reason stating the C3 compatibility argument and the 0.5.0 premise.
  M2 has no destructive kind.
- **Kind scoping:** entries are per directory. The self-test therefore asserts M1's kind set is
  exactly `{ADD CHECK}`, so other destructive DDL added to M1 later reddens it.
- **Self-test cases:**
  - flagged: `ADD CONSTRAINT c CHECK`, `ADD CHECK`, `ALTER TABLE ONLY`, `IF EXISTS`,
    multi-subcommand, `ADD COLUMN c int CHECK (…)`, `NOT VALID`, and a CHECK inside a DO-body
    `EXECUTE` literal (the tokenizer re-scans DO bodies);
  - not flagged: `CREATE TABLE … CHECK`, `VALIDATE CONSTRAINT`, a top-level comment or string.

### C6 — other syncs

- **schema.prisma:** the `itemKeyId` comments on both models state the constraints.
- **deployment.md:**
  - the line saying the constraint "is added in the next release" now describes this release's
    repair and the CHECK;
  - add the requirement "upgrade through 0.5.0 and let it finish rolling before deploying this
    release";
  - the 0.5.0 rollout-requirement paragraph is unchanged: stale labels on id'd entries are still
    not detected (SC1).
- **`isRekeyPending` docstring** (`team-key-resolution.ts`): the rollout NULL-id sentence notes
  the CHECK. The predicate is unchanged (SC2).
- **Gates:**
  - check-migration-transaction: M1 has 3 DDL statements and M2 has 2, both wrapped.
  - check-migration-rls-dml: the DO body references only the three tables it is granted.
  - `scripts/checks/db-grants-manifest.json`: no grant changes. Verified with
    `node scripts/audit-db-grants.mjs` against the worktree DB (no diff).
  - `npm run db:check-drift`: Prisma ignores CHECKs (the existing pin_length CHECKs show this).

### Forbidden patterns

- pattern: `\bteams\b` inside M1's `app.bypass_tables` literal — reason: the teams lock was
  dropped (D-d).
- pattern: `rolsuper|rolbypassrls` in M1 — reason: the block is role-independent.
- pattern: an `UPDATE team_password_entries … SET item_key_id` without
  `item_key_team_key_version = 0` in the same statement — reason: every repaired entry re-enters
  the pass (D-b). Scoped to entries, because histories have no marker column.
- pattern: an `UPDATE team_password_entries` that sets `item_key_id` to a non-NULL value on a row
  whose `item_key_id IS NOT NULL` — reason: id'd entries are never relabelled (round-2 F1). The
  v0 clear sets NULL and is outside the pattern.

## Testing strategy

C4 on `passwd_sso_wt_1011`; the gate self-tests; `npx vitest run`; `npx next build`;
`npm run test:integration`; and the static checks through `pre-pr`.

## Considerations & constraints

- SC1: stale labels on id'd entries left by a 0.4.77 restore that leave no evidence. This means
  a restore from a NULL-id row of a different ItemKey, a restore whose id'd evidence row has
  since been trimmed by the 20-row cap, and a stale label a later 0.5.0 snapshot copied into
  history (round-2 S7). The decidable F5 case (an id'd evidence row still present, marker > 0) is
  put back in the pass by the marker-only arm. The labels are never moved (round-2 F1). They are owned by
  the 0.5.0 deployment.md rollout requirement, whose `ENTRY_HISTORY_RESTORE` audit-row procedure
  names the entries. The re-key pass, if run, tries every held key, so a CEK under a stale label
  is not lost.
- SC2: for entries, the NULL-id branches of `isRekeyPending` / `rekeyPendingWhere` and the
  attachment-migrate NULL arm become unreachable. They stay because the column stays nullable
  (v0) and removing them is a behaviour-neutral refactor. The unit tests stay as they are.
- Stall: see D-d.

## User operation scenarios

1. **Operator deploys over a 0.5.0 database with rollout residue.** Migrations pass as the RDS
   owner role. Repaired entries stay decryptable and show in the team's re-key count until the
   pass runs. 0.5.0 instances still serving keep writing successfully.
2. **A 0.5.0 instance writes while M1 runs.** It queues behind the table lock and then commits a
   row that satisfies the CHECK.
3. **A later migration adds a CHECK.** The gate flags it until the migration is baselined with a
   compatibility reason.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | M1 backfill + two ADD CHECK NOT VALID | locked |
| C2 | M2 VALIDATE ×2 | locked |
| C3 | writer member set | locked |
| C4 | integration tests, seed rework, red proofs | locked |
| C5 | destructive gate `ADD CHECK` kind | locked |
| C6 | schema / deployment.md / gates / manifest / drift | locked |

## Implementation Checklist

- [x] M1 `prisma/migrations/20261120000000_team_item_key_id_check/migration.sql` (C1)
- [x] M2 `prisma/migrations/20261120000100_team_item_key_id_check_validate/migration.sql` (C2)
- [ ] `scripts/checks/check-destructive-migration.mjs` + `check-destructive-migration.test.mjs` + `destructive-migration-baseline.txt` (C5)
- [ ] `src/__tests__/db-integration/helpers.ts`: `TEAM_ITEM_KEY_ID_CHECK_SQL` override in `readBackfillBlock` (reuse `redProofOverride`)
- [ ] `src/__tests__/db-integration/team-item-key-id-check.integration.test.ts` (new, C4 1-5); reuse `readBackfillBlock`, `expectBypassRefusal`, `enterBypassRole` pattern, `gucSentinels`/`runBlock` style from the writers test
- [ ] `src/__tests__/db-integration/team-key-rekey-writers.integration.test.ts`: A10 cell, rerun describe `seedFixtures` + helper split
- [ ] `src/__tests__/db-integration/team-rekey-pass.integration.test.ts`: convert L1674 / L1693 / L1737
- [ ] `prisma/schema.prisma` comments (both `itemKeyId`)
- [ ] `docs/operations/deployment.md` (C6)
- [ ] `src/lib/team/team-key-resolution.ts` `isRekeyPending` docstring
- [ ] Verify: migration-transaction / rls-dml / destructive gates, `node scripts/audit-db-grants.mjs` (no diff), `npm run db:check-drift`, `npx vitest run`, `npx next build`, `npm run test:integration`, pre-pr
