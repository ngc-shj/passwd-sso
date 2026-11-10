# Plan: migration-backfill-rls-bypass

Issue: #1033. Branch: `fix/migration-backfill-rls-bypass`. Review record:
`migration-backfill-rls-bypass-review.md`.

## Project context
- Type: web app (Next.js + Prisma 7 + PostgreSQL 16, FORCE RLS on tenant tables).
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - E1: no RDS or managed Postgres is reachable from this host. The property that matters, a
    NOSUPERUSER NOBYPASSRLS migrate role, is reproduced by running blocks as `passwd_app`, which
    has both attributes. `verifiable-local`.
  - E2: whether any data-bearing NOBYPASSRLS database (the project's AWS dev environment, or a
    self-hoster's managed Postgres) applied `20261101000000` / `20261104000000` cannot be checked
    from here. C1 is correct either way (I1, I2). Observing it on such an instance is
    `blocked-deferred`: it needs that operator's deploy.
  - E3: whether `prisma migrate deploy` surfaces `RAISE NOTICE` is unverified, so no operator
    flow relies on it (C1 audit rows are the durable record).

## Objective
Two backfills shipped this month set no RLS bypass: `20261101000000_team_tenant_departure` and
`20261104000000_team_key_rotation_rekey`. Every table they read or write is FORCE RLS. On a
migrate role without BYPASSRLS — RDS's master, and the managed-Postgres admin that the GCP / AWS
/ Vercel setup docs have operators use — each statement sees no rows and the backfill silently
does nothing. Compose and CI migrate as a superuser, so they are green. Fix forward, and refuse
the class in CI.

Effects where an original ran over existing rows without bypass:
- departure: memberships of members who left the tenant before the change stay active (team
  authorization reads only `team_members`), so they keep team-entry access and admin browsers
  keep distributing rotated team keys to them; invitations to or from them stay PENDING (accept
  refuses them at runtime, so that part is defence in depth); pre-change SCIM deletes have no
  departure record.
- re-key: entries stay pending re-key (fail-safe); v1+ entries have no `item_key_id`, which also
  blocks #1011's CHECK; `item_key_version_high_water` stays 0, so a new ItemKey can take a
  version a history row or attachment CEK above the entry's current version already holds. That
  reuse is harmless to confidentiality and integrity: wraps are found by `item_key_id`, else by
  AES-GCM trial decryption, so a wrap under another key fails its tag (review round 1, S-Q2).
  Collisions minted in the window are not repaired (SC3).

## Member set (R42)
Class: a statement executed at migrate time (top level, or in a `DO` body — not a function body)
that reads or writes a table under FORCE RLS at that point in the migration sequence, with no
bypass covering it. Derivation: C3's list mode (`node scripts/checks/check-migration-rls-dml.mjs
--list`) over today's tree; independently reproduced in review rounds 1 and 2 by a scratch
replay of the 59 `ALTER TABLE … FORCE ROW LEVEL SECURITY` statements (59 distinct tables, none
reverted; four more such lines in `20260227020000` are commented out). Result: 15 migrations.

| Migration | Disposition |
|-----------|-------------|
| `20261101000000_team_tenant_departure`, `20261104000000_team_key_rotation_rekey` | C1 fix-forward |
| `20260321100000`, `20260415130000`, `20260418042050`, `20260418144000`, `20260418160000`, `20260430120002`, `20260502000000`, `20260519100000`, `20260522000100`, `20260524060000`, `20260629000000`, `20260629000100`, `20260725000000` | baseline (C3), each with its own reason: a runtime guard refuses the rows it left, retention GC purges them, a later `SET NOT NULL` fails loudly on them, or it ran before any data could exist on the project's RDS. Each reason is verified per entry in Phase 2, not assumed. |

## Contracts

### C1 — Fix-forward migration
`prisma/migrations/<ts>_rls_backfill_rerun/migration.sql`, one transaction, two marked blocks
(`-- BEGIN BACKFILL team-tenant-departure-rerun`, `-- BEGIN BACKFILL team-key-rotation-rekey-rerun`
with matching ENDs). Each block is a `DO` that:
- saves `app.bypass_rls`, `app.bypass_tables`, `app.bypass_purpose`, `app.tenant_id`, sets them
  transaction-locally to `on`, exactly the tables it references, `system_maintenance`, the nil
  UUID, and restores the saved values on its single exit (pattern of `20261109162613`);
- in the departure block, first takes the app's per-(tenant, user) advisory locks
  (`hashtext('tenant-member:' || tenant || ':' || user)`, sorted `COLLATE "C"`) for the union of
  the step-1 candidates and the 2c subjects — SCIM-deleted users have no tenant row, and the
  advisory lock is what serialises them with invitation accept — then locks the candidates'
  `tenant_members` rows `FOR SHARE OF` that
  table only (ordered by tenant id, then user id; never the joined `team_members` rows, which would precede
  `teams`), so a concurrent `returnToTenant` waits and then restores what C1 marked; then
- takes `teams FOR SHARE` over all teams in one statement, ordered by id, before any member or
  entry write, as `team-key-rotation-lock.ts` requires of writers of those rows (SHARE does not
  conflict with SHARE; rotation takes its lock first and fails with
  `TeamRotationInProgressError` while the migration holds it);
- runs the original block's statements with the changes below; in the departure block, 2c's
  departure-record insert runs right after the tenant-row lock and before `teams FOR SHARE`, then
  the invitation updates (2a, 2b, 2c's), then the membership step (1) — the app's order
  `tenant_members` → `tenant_member_departures` → `teams` → `team_invitations` →
  `team_members` (`deactivateScimUser` writes departures before teams). The reorder keeps every
  writer before its readers (2c insert → 2c update; step 1 → census); no moved statement reads
  another's write, so results are unchanged.

**Re-key block.** Steps 2–4 run unconditionally: each moves only rows in the pre-change state to
the state the app itself gives them (high-water only raised, an id for a v1+ entry the app would
otherwise mint as pending re-key, a history id on an identical wrap); on app-written rows they
are no-ops. Step 1 (marker) does not have that property: history restore deliberately writes
marker 0 when the restored ItemKey is not the live one, which on a never-rotated team looks
exactly like a pre-change row. So step 1 runs only under the departure block's role condition
(on a bypass role the original already marked the pre-change rows; a rollout straggler left at 0
is pending, which fails safe), and only on rows with `item_key_version_high_water = 0` — a
pre-change row still holds the default (step 2 runs after step 1), a restore raises it to at
least the restored version. Residual: an entry restored after the deploy to a v0 history row
(high-water 0) is marked 1 — the state the original gave every pre-change v0 entry.

**Departure block: runs only when the migrate role cannot bypass RLS** (`current_user`, not
`session_user`, has neither `rolsuper` nor `rolbypassrls`; neither attribute is inherited). On a role that bypasses
RLS the original ran with effect and wrote no deactivation records, so the exclusion below has no
evidence there and a re-run would revoke members re-admitted since. Where C1 runs (a role that
cannot bypass), it assumes the original ran on the same kind of role and changed nothing; if
the original ran on a bypass role and C1 runs on a role that cannot bypass (role switch or
cross-host restore), members the original ended and accept later re-admitted have no record and
are revoked (a third fail-closed residual; C6's re-invite step). In the reverse case — the
original on a role that cannot bypass, C1 on one that can — C1 skips and the leaks stay (a
residual keeping access; C6's report lists them). The skip counts the step-1
candidates (active memberships of departed members created before the departure, minus the
exclusion) and raises a `WARNING` naming the count. Whether `prisma migrate deploy` shows it is
measured in Phase 2 (E3); C6 does not depend on it: its candidate report runs on every
deployment.

Changes from the originals (departure block):
- **Step 1** excludes the memberships of a user who has any `TEAM_MEMBER_TENANT_DEACTIVATE`
  record in that tenant (target user; any team, any time), in `audit_logs` or in `audit_outbox`
  (any status). Only `endTeamMemberships` writes that action, in the transaction that ends every
  active membership of the user in the tenant at a departure; every departure after the user's
  first post-change one also runs post-change code and ends all active memberships (SC5 rollout
  departures excepted). So with a record, a membership active now was re-admitted after the
  last departure (invitation accept upserts the row, keeping its old
  `created_at`, while the tenant row stays deactivated). No time conjunct: the record's
  `created_at` and the stamp come from different clocks. Comparisons as text
  (`a.target_id = tm.user_id::text`, `o.payload->>'targetId' = tm.user_id::text`,
  `o.payload->>'action'`); `audit_logs.target_id` holds non-UUID targets and is never cast.
  Re-activation writer set (every writer of `team_members.deactivated_at = NULL`): accept,
  members POST, approve, `returnToTenant`; only accept re-activates without an active tenant
  row. Not used as evidence: ACCEPTED invitations (the accept pre-check marks one ACCEPTED for an
  already-active member; retention deletes invitations ~7 days after issue). Residuals, all
  revoking (fail closed, recoverable by re-inviting, visible as a backfill audit row, C6): the
  user's records were purged by retention; the user had no active membership at the post-change
  departure and was re-admitted later; the role-switch case above. Residuals keeping access, both listed by C6's report: the reverse role switch above, and an SC5 rollout departure of a
  user who already has a record from an earlier post-change departure (listed by C6's report; the tenant admin confirms).
- **Step 1** enqueues one `audit_outbox` row per membership it deactivates, with the payload
  `buildOutboxPayload` produces for `endTeamMemberships`' call except the actor: id
  `gen_random_uuid()` (the column has no database default), `tenant_id` the membership's tenant;
  camelCase keys `scope` `TEAM`,
  `action` `TEAM_MEMBER_TENANT_DEACTIVATE`, `userId` `SYSTEM_ACTOR_ID`, `actorType` `SYSTEM`,
  `serviceAccountId` null, `teamId`, `targetType` `TeamMember`, `targetId` user id, `metadata`
  `{ "source": "TENANT_DEACTIVATION", "backfill": "<migration dir>", "departedAt": <the tenant
  row's stamp> }`, `ip` and `userAgent` null. Metadata holds constants and a database timestamp
  only, so bypassing the app's metadata sanitiser is harmless. `audit_outbox` joins the block's table list. These rows are also evidence for any
  later run (I1).
- **Step 2c** uses `ON CONFLICT (tenant_id, user_id) DO NOTHING`: an existing record was written
  by the app at the delete; overwriting it with the audit time would move a departure later and
  could void invitations issued in between. (In the original the table was new and empty, so its
  `DO UPDATE` arm never fired.)

Invariants (app-enforced):
- I1 idempotent: a second run changes no row and enqueues nothing.
- I2 on a migrate role that bypasses RLS the departure block and re-key step 1 change nothing
  (the departure block warns with the candidate count); re-key steps 2–4 change only rows in the
  pre-change state.
- I3 no setting outlives its block: all four are back to their pre-block values.

Control class: n/a (data repair).

### C2 — Original migrations untouched
Applied migrations are checksummed; the two originals get no edit.

### C3 — Static gate `scripts/checks/check-migration-rls-dml.mjs`
Control class: **best-effort tripwire** over SQL text. Adjudication: `tokenizeSql`
(`scripts/checks/lib/sql-scan.mjs`), no catalog or binding. Known bypasses: a table reached
through a view, function or trigger; DML in a function the migration calls; a `set_config` behind
a helper; a non-`public` `search_path`. Recovery path: C4-style cells running backfills as an
RLS-bound role, and review.

Behaviour:
1. Replays FORCE state per statement in migration name order (`FORCE` adds, `NO FORCE` removes).
2. Units: the top level, and each `DO` body (re-tokenized, line numbers offset to the file). A
   `DO` without a recognisable dollar-quoted body, or any unterminated / unrecognised dollar
   quote (Unicode tags included, as `check-destructive-migration.mjs` handles them), fails closed.
   Function / procedure bodies are not units.
3. References: in a `DO` unit, every table-introducing position anywhere in a statement — after
   `FROM` (each comma-separated item at that depth), `JOIN`, `UPDATE`, `INSERT INTO`, `DELETE
   FROM`, `USING`, `MERGE INTO`, skipping `ONLY`, stripping `public.`, excluding CTE names, and
   excluding a name followed by `(` only after `FROM` / `JOIN`. This covers PL/pgSQL-prefixed
   statements (`BEGIN UPDATE`, `IF … THEN`, `FOR r IN SELECT`, `IF EXISTS (SELECT …)`,
   assignments). At the top level, only data statements (`SELECT`, `INSERT`, `UPDATE`, `DELETE`,
   `MERGE`, `WITH`, `CREATE TABLE … AS`) are read; DDL bodies (policies, views) are not executed
   reads.
4. State, not presence: tracks the current lexical value of `app.bypass_rls` and
   `app.bypass_tables` at each statement (latest `set_config` before it in the unit). A statement
   referencing a FORCE table is refused unless the current `bypass_rls` is `'on'` and the current
   table list (comma-split, exact elements) contains every FORCE table it references. A grant
   is `set_config('app.bypass_rls', 'on', true)` with literals; any other value of
   `app.bypass_rls`, literal or not, is a restore (state not on). A `bypass_tables` value must be
   a literal; `false` (session scope) on either fails closed. A grant inside a nested block,
   branch or loop (`BEGIN … EXCEPTION`, `IF`, `CASE`, `LOOP`, `FOR`, `WHILE`) fails closed: the
   lexical state would assume a grant that may not run or may be rolled back. A unit that granted
   must end with `bypass_rls` restored after its last referencing statement. Referencing
   statements at the top level are always refused. `EXECUTE`, or `FORCE ROW LEVEL SECURITY`, in
   a `DO` body fails closed.
5. Baseline `scripts/checks/migration-rls-dml-baseline.txt`, format and errors as the sibling:
   `<dir>  # reason ≥ 10 chars`; `MIGRATION_RLS_DML: <dir>:<line>: <table>`,
   `ALLOWLIST_ENTRY_WITHOUT_REASON`, `STALE_ALLOWLIST_ENTRY`.
6. `--list` prints every hit `<dir>:<line>:<table>` (baseline included), then a trailer
   `FORCE_STATEMENTS=<n> FORCED_TABLES=<n>` from its replay — `FORCE_STATEMENTS` counts `FORCE`
   statements only, not `NO FORCE`; `FORCED_TABLES` is the distinct
   tables named by any FORCE statement (normalised: unquoted, `public.` and `ONLY` stripped),
   not the final forced set — for C5's hit-set test (which skips the trailer line) and count
   test.
7. Root override `MIGRATION_RLS_DML_CHECK_ROOT` as the siblings; when `CI` is set, an override
   requires an explicit fixture flag, so a leaked override cannot point CI at an empty tree.
8. Wired into `scripts/pre-pr.sh` beside `Static: destructive-migration` (CI static-checks runs
   it via `PRE_PR_STATIC_ONLY=1`).

### C4 — Integration cells
Files: extend `src/__tests__/db-integration/team-tenant-departure.integration.test.ts` and
`team-key-rekey-writers.integration.test.ts` (fixture builders of their existing backfill cells
extracted into helpers, assertions unchanged). Pattern of the `service_account_token_creator`
cell: blocks extracted by markers, run on connections from the integration pool factory
(`createPool` / `createPrismaForRole`, whose notice sink feeds `setup.ts`'s `failOnReports`), so
any `rls_bypass_not_granted` warning fails the cell. Nothing a block changes is ever committed:
every block run is inside a transaction that is rolled back.

- Fixtures: committed through the superuser helper before `BEGIN`, in the cell's own tenant,
  cleaned by `deleteTestData`. Every timestamp of a synthetic fixture is set relative to the
  departure stamp read back from `tenant_members` (stamp − 1 s, = stamp, + 1 s), never from
  wall-clock defaults, and the cell asserts the ordering it relies on before running a block.
  The fixture produced by the real `departFromTenant` + accept route keeps its own clocks (the
  exclusion has no time conjunct). Each C1 statement scans at
  least one row of every table it references, so a short table list raises the warning.
- Settings sentinels before every block: `app.bypass_rls = 'off'`, `app.bypass_tables =
  'sentinel_none'`, `app.bypass_purpose = 'sentinel'`, `app.tenant_id` = a random UUID naming no
  tenant (casts cleanly, admits no row). Asserted before and after every block (I3).
- Departure fixtures (role `passwd_app`): membership created before / after the departure;
  invitations at / before / after the stamp by inviter and invitee; a SCIM-deleted user with and
  without an audit row; an existing departure record earlier than its audit row (kept); a
  membership the app ended (via `departFromTenant`) and then re-admitted through the real accept
  route (stays active; its record is the app's PENDING outbox row — outbox arm); a re-admitted
  membership whose record exists only in `audit_logs` (inserted as superuser; `audit_logs` arm;
  stays active); one whose record is a non-PENDING outbox row (stays active); a re-admitted
  membership in team X whose user's record names another team Y of the tenant (stays active;
  one per arm);
  a leaked membership with an ACCEPTED post-departure invitation and no record (deactivated —
  the invitation is not evidence); a re-admitted membership whose record's `created_at` is
  stamp − 1 s (stays active; one per arm; guards the time conjunct's return); negative records, each
  deactivating: a different action, a different target user, another tenant — one per arm. The
  second tenant is created by the cell and cleaned with its own `deleteTestData`. Expected state
  is a literal map.
- Re-key fixtures (`passwd_app`): marker per team version; an entry restored by the real history
  restore route to a non-live ItemKey on a v1 team (marker 0, high-water ≥ 1) stays pending;
  high-water from a history row and from an attachment CEK version above the entry's; entry ids;
  history id only on an identical wrap. Literal map.
- Negative control, first, own transaction: the ORIGINAL block as `passwd_app` completes, every
  NOTICE count is 0 (census included), fixtures read back under a test-set bypass in pre-state.
  Positive control in the same transaction: the original again under a test bypass covering its
  tables changes them.
- I2, run in both files (each with its own block and fixtures, the role setup duplicated), on
  one client checked out of `ctx.su`'s pool (raw `notice` listener removed in `finally` before
  `release()`), in one rolled-back transaction per role:
  `ctx.su` (both attributes asserted), a role created there `NOLOGIN NOSUPERUSER BYPASSRLS IN
  ROLE passwd_app` and one created `NOLOGIN SUPERUSER NOBYPASSRLS`, each with a random name,
  attributes asserted, entered with `SET LOCAL ROLE`. Per role: the departure block and re-key
  step 1 change no fixture; the skip `WARNING` (raw client `client.on("notice")`, exact text with
  the count captured; the count is advisory — C6 does not depend on it — so only its total
  exclusion and the outbox arm are pinned) is asserted as a delta — run, add one leaked candidate and one re-admitted
  membership with an `audit_outbox` record, run again, count + 1; a marker-0, high-water-0, v1+
  straggler on a version-1 team keeps marker 0; re-key steps 2–4 repair stragglers (v1+ entry
  without id, high-water below a history version, a history row with an identical wrap and no
  id) and leave app-written fixtures unchanged, asserted by fixture read-back (literal map), not
  by NOTICE counts. A fourth transaction on the same client enters `passwd_app` with `SET LOCAL
  ROLE` (`session_user` bypasses, `current_user` does not): the departure block and re-key step
  1 apply (literal map) — pins that the gate reads `current_user`.
- C6 scripts, an exception to the wrapper and sentinel discipline: each runs as extracted, on
  its own `passwd_app` connection from the pool factory (so the bypass-notice sink sees it) and
  its own transaction, against committed fixtures; after a raise the connection is rolled back
  or destroyed before release. Each C6 cell owns its tenants, built and cleaned with
  `deleteTestData`. Every cell that isolates an arm or a conjunct asserts, as a precondition,
  that no other path reaches its subject (e.g. the team has no section-1 row; the other
  conjuncts hold), and each negative differs from its positive in one field only.
  - Report: rows filtered to the cell's tenants equal a literal map — exactly the memberships C1
    deactivates plus those C1's exclusion keeps (ties the report's predicate to C1's) — with
    adjacent non-candidates absent and the record flag per evidence fixture. Section 2: a
    candidate's team lists only webhooks updated after the departure; a team reached only
    through a C1-dir record (membership contained, so not a candidate) lists all its webhooks,
    including one untouched since before the departure — one such team per store, plus
    negatives differing only in `backfill` value or action, per store; the same team still
    listed after the member returned and departed again, and after the tenant row was deleted
    (committed fixtures, the return through the real `returnToTenant` in a committed Prisma
    transaction); the result has exactly the six named columns.
  - Report body (inner markers) after C1, inside the block transaction as its last step, under a
    test bypass set with `set_config(…, true)` (the report's list, `system_maintenance`, the nil
    tenant id) and asserted: exactly C1's excluded set remains in section 1.
  - Report with the `app.bypass_rls` line removed (matched exactly once; nil tenant id kept):
    raises the control's fixed message.
  - Contain success: leaked OWNER and member (tenant stamp fixed at least an hour in the past,
    asserted at fixture time) end with `deactivated_at` = that stamp, the marker and the outbox
    record (`departedAt`, `manual`, `operator`; no `dbUser`); the team moves from absent to present
    in the ownerless list; a separate pair given in upper case, a duplicated triple, and a
    255-character label also succeed. Refusals, nothing written (read back through `ctx.su`,
    before/after for the cell's tenants): one per guard conjunct — the team-tenant and
    membership-tenant matches are one conjunct (the app keeps them equal), the tenant-row-tenant
    match (a user departed in another tenant but active in this one), active, departed; a mixed list; an empty, a 1-D and a
    3-column-less array; an empty, a 256-character and the template label; a malformed id
    (SQLSTATE 22P02).
  - Locks: one cell per lock, connection A holding exactly that one lock on a subject the script
    will reach (a step-1 candidate's tenant row; an input triple's advisory key, built with the
    app's exported key helper; an input team's row), connection B as `passwd_app` running only
    the block that takes it with `SET LOCAL lock_timeout`, expecting 55P03 from that lock
    statement; `finally` rolls back B, then A, then releases both. Lock order is
    review-verified, not mutant-verified.
- I1: second C1 run as `passwd_app` in the same transaction: all counts 0 except
  `ownerless_teams`, which equals the first run's; no outbox row whose
  `payload->'metadata'->>'backfill'` names the C1 dir is added.
- Table-list control (permanent): the C1 block with one table removed from its
  `app.bypass_tables` literal, inside `expectBypassNotices`, raises a notice naming that table and
  the purpose `system_maintenance` (the helper only returns the reports; the cell asserts).
- `ownerless_teams` census: asserted as a delta (remove the fixture team's OWNER inside the transaction, census
  +1), not as an absolute count.
- Outbox: the payload C1 enqueued for a fixture membership `toEqual`s
  `buildOutboxPayload({...})` with the values of C1 (incl. `metadata.departedAt` equal to the
  tenant stamp); a copy committed as a PENDING row in the
  cell's tenant, run through the exported `deliverRow`, yields the `audit_logs` row with the
  expected action, actor type, user id, team id, target type and target id
  (`audit-outbox-worker-fanout.integration.test.ts` precedent).

### C5 — Gate self-tests `scripts/__tests__/check-migration-rls-dml.test.mjs`
Parameterised fixture trees, refused unless noted: one per reference form (`SELECT … FROM`,
`PERFORM`, `INSERT INTO t (cols)`, `UPDATE [ONLY]`, `DELETE FROM`, `MERGE INTO`, `JOIN`, `USING`,
comma join, `public.t`, quoted identifier, `WITH`-prefixed DML, CTE named differently from the
table); PL/pgSQL forms (`BEGIN UPDATE`, `IF … THEN UPDATE`, `FOR r IN SELECT`, `IF EXISTS
(SELECT`, assignment from a subquery); `DO $tag$` body; grant → DML → restore → DML; grant
missing the table; near-name list (`tenant_members` granted, `team_members` written); grant with
`false`; non-literal `bypass_tables`; grant inside `IF`, `LOOP` or a nested `BEGIN …
EXCEPTION`; restore before the last DML; no restore; top-level DML on a forced table;
`EXECUTE`; `FORCE ROW LEVEL SECURITY` inside a `DO`; unterminated dollar quote. Passing: full
`DO` without a dollar-quoted body; Unicode dollar tag; `false` on `bypass_tables`; one statement
over two forced tables with only one granted; a forced-earlier, written-later table across
migrations; under `CI`, a root override without the fixture flag. Passing: full grant + COALESCE
restore (`20261109162613` copied as a fixture); DML before the table's FORCE in the same
migration; `NO FORCE` then DML; function body; `UPDATE` in a comment or string. Baseline: short reason, stale
entry. Messages name dir, line and table. Real tree: passes; `--list` hits for the two originals
equal a hand-written literal (`<dir>:<line>:<table>`, read off the SQL; stable because C2) — no
snapshot or generated fixture; the baselined hits' directory set equals the baseline file's and
their per-directory counts equal a literal; C1 yields no hit; the gate's replayed FORCE
statement count and distinct forced-table count equal counts the test computes itself by a
separate regex pass over the tree with `--` and `/* */` comments removed and `NO FORCE`
excluded, table names normalised as the gate does (a fixture with a commented-out FORCE line
pins the stripping; one with `FORCE` then `NO FORCE` pins the `FORCED_TABLES` definition) (independent of the gate, and not a literal that a future
FORCE migration breaks). Under `CI`, the test sets the
fixture flag the root override requires.

### C6 — Operator follow-up docs and scripts
`docs/operations/` (the existing upgrade / migration page; located in Phase 2). Two SQL scripts
are shipped in the doc between markers (one marker pair each; extraction fails unless exactly
one pair is found), and C4 runs the extracted text, so the documented text is the tested text.
Both grant themselves the bypass transaction-locally — `app.bypass_rls` `on`, the exact table
list, a purpose, `app.tenant_id` the nil UUID — because RLS is granted by these settings, not by
a role attribute; they therefore work as RDS's or Cloud SQL's admin (the schema owner).

- **Report** (read-only): `BEGIN READ ONLY`; grant; a positive control that raises a fixed
  message when it can see no `tenant_members` rows (instead of returning an empty report);
  section 1, the raw step-1 candidates — active memberships of departed members created before
  the departure, no exclusion — with tenant, team, user, role, and whether the user has a
  deactivation record; section 2, the `team_webhooks` of the teams of those candidates and of
  every membership with a `TEAM_MEMBER_TENANT_DEACTIVATE` record whose `metadata.backfill` is the
  C1 dir (ended by C1 or contain) — read from both stores, as C1's exclusion is (`audit_logs`
  `metadata->>'backfill'` and `team_id`; `audit_outbox` `payload->'metadata'->>'backfill'` and
  `payload->>'teamId'`, any status; text comparisons). For a candidate's team, the webhooks
  created or updated after the candidate's departure; for a team found through a record, all of
  the team's webhooks, with no time filter (the member may have returned, departed again, or had
  the tenant row deleted since; over-inclusion fails closed). `audit_outbox` is in the report's
  table list. Columns
  `id, tenant_id, team_id, is_active, created_at, updated_at` only, never `url`, `secret_*` or
  `last_error` (the table has no creator column, so this over-includes, which fails closed);
  `ROLLBACK`. The query body between the grant and
  `ROLLBACK` is itself marked, so C4 can run it inside a transaction.
- **Contain** (writes): one `DO` block (psql variables do not expand in dollar quotes, and the
  count check needs `RAISE`). Its input is two marked placeholder lines inside the block, the
  only lines an operator edits (C4 substitutes exactly those, each asserted to appear once): the
  triples as a typed `uuid` array literal, so a malformed id raises at the cast before any lock;
  the operator label as a dollar-quoted literal with a tag distinct from the block's. The label
  is refused when empty, longer than 255 characters, or still the template token; it is
  visible to tenant admins and webhook receivers, so the doc says it must hold no personal data.
  The array is refused unless it has two dimensions, three columns and at least one row;
  duplicate triples are collapsed; the input count is the number of distinct triples. The
  script's shape is `BEGIN; DO $…$ … $…$; COMMIT;` with the grant transaction-local inside the
  block. Grant; locks as the app
  does before touching teams — `pg_advisory_xact_lock(hashtext('tenant-member:' || t::text ||
  ':' || u::text))` per (tenant, user), the ids normalised through the uuid cast, sorted
  `COLLATE "C"` (the expression and order of `lockTenantRows`; `src/lib/team/tenant-row-lock.ts`
  exports its key builder so the C4 lock cell holds the app's own key, which pins the script's
  copy to it), then those `tenant_members` rows `FOR UPDATE` ordered by
  tenant id, then user id (this row lock is what carries correctness: every app writer of the
  row takes it), then `teams FOR SHARE` on the input teams; then one
  `UPDATE … FROM tenant_members … RETURNING` that deactivates exactly the memberships whose
  team, membership and tenant row all belong to the given tenant, are active, and whose tenant
  row is departed (`deactivated_at` = the tenant row's stamp, `deactivated_by_tenant` true, so a
  return restores them); raises (nothing written, the transaction aborted) when the returned
  count `IS DISTINCT FROM` the input count; enqueues one outbox record per returned row, as C1 does, with
  metadata `{source, backfill: <C1 dir>, departedAt, manual: true, operator: <label>}` built
  with `jsonb_build_object` (the label the only free text, bounded); `session_user` goes only to
  a `RAISE NOTICE` in the operator's own session, not to tenant-visible records. An OWNER membership is contained the same way; the team then has no
  active OWNER and the tenant admin's owner-assign flow applies.

Steps, for every deployment that applied `20261101000000` before C1, whatever its migrate role
or host history:
- **Before deploying C1:** run the report; disable the webhooks in section 2 (C1 ends
  memberships, not webhook-based access, and C1's audit rows fan out to webhooks).
- **After deploying C1:** run the report again and keep its output: the records it relies on
  are purged by audit retention (the shortest tenant retention bounds how long the report can
  rebuild the list). On a migrate role without BYPASSRLS, C1 ended
  every candidate without a deactivation record; those still listed were kept by a record —
  normally a re-admission, or an SC5 departure. On a role that bypasses RLS, C1 skipped them all.
  Each tenant admin gets only their tenant's rows and confirms each; no audit evidence
  distinguishes a re-admission from a leak (invitation accept writes no audit row; an ACCEPTED
  invitation is not evidence). Confirmed leaks are ended with the contain script.
- **For memberships C1 or the contain script ended** — identified by
  `TEAM_MEMBER_TENANT_DEACTIVATE` records with `metadata.backfill` (section 2's evidence, both
  stores) — in this order:
  1. disable the webhooks the report's section 2 lists;
  2. if no active OWNER or ADMIN of the team holds the team key (`key_distributed`): when the
     team has no active OWNER, the tenant admin assigns one, choosing a member whose tenant row
     is active and who holds the key (the operator checks `key_distributed`; the route does
     not); when an active OWNER without the key exists, that OWNER promotes a key holder to
     ADMIN; if neither is possible the team cannot be rotated — tell the tenant admin why, and
     only steps 4–6 apply;
  3. rotate the team key and run the re-key pass;
  4. rotate, at their services, the secrets in those teams' entries;
  5. review the member's team-scope audit rows in the leak window — from the record's
     `metadata.departedAt` to the record — and revert what they did (exported
     before retention purges them);
  6. tell each affected tenant's admin.
  Team-entry share links they created stop being served on their own (`share_creator_admitted`).
  A legitimately re-admitted member C1 ended (residuals in C1) is re-invited.

Setup docs that tell managed-Postgres operators to migrate as "superuser" (GCP / AWS / Vercel)
say to check `rolsuper` / `rolbypassrls` of the migrate role (RDS's and Cloud SQL's admins have
neither).

Forbidden patterns:
- pattern: `prisma/migrations/2026110[14]000000_` among modified files — reason: C2.
- pattern: `ON CONFLICT \(tenant_id, user_id\)\s+DO UPDATE` in the C1 migration — reason: C1
  (verified to match the original's text).

## Testing strategy
Red-proofs on a scratch worktree, never the real source. Obligation: every control named in C1,
C3 and C6 — each bypass-table entry, each gate half, each guard conjunct and arm, each lock,
each refusal, each recorded field — has a mutant that removes or loosens it, and Phase 2 runs
every one and records the cell that turns red. A mutant that no cell kills is a finding in the
deviation log (fix the cell, or state why the control is review-verified); it is never kept as
if verified. Phase 2 hand-writes a `## Mutation results` table in the deviation log, one row
per mutant — control (contract and subject), mutation, killing cell, red output excerpt;
"review-verified" only with a reason — and Phase 3 checks that every control named here and
every `set_config`, guard conjunct and lock in the diff has a row. The list is derived in Phase 2 from the implemented controls, starting from the
ones named here: the 12 bypass-table entries; grants; the departure role gate and each half;
`current_user`; re-key step 1's role condition and high-water restriction; the role condition
applied to steps 2–4; the exclusion, each arm and conjunct, PENDING-only; `DO NOTHING`; the
outbox enqueue; the restore; the report's positive control, section 1's record flag, section 1 applying no exclusion
(mutant: add C1's exclusion), section 2 arms
and record-team branch; each script's table list; contain's guard conjuncts, any-vs-every, the
count check, the array-shape and label checks, `deactivated_at`, marker and record; each lock
(C1 ×4 — advisory, tenant rows, departure teams, re-key teams; contain ×3); the key text matching the app's helper. Gate: disable each reference
keyword and each refusal rule; each must turn a C5 cell red. Full vitest, build, integration
suite with compose workers stopped, `scripts/pre-pr.sh`.

## Considerations
- SC1: the 13 baselined migrations get no re-run; their reasons are per entry (member set).
- SC2: DML in function bodies (call-time context) is outside the gate; covered by
  `check-bypass-rls` and the function patterns.
- SC3: ItemKey versions that collided in the window are not repaired; harmless (Objective).
- #1011's CHECK must come after C1 in migration order; noted on #1011.
- SC4 (follow-up issue, filed with the PR): invitation accept refuses an inviter who has
  departed at all, and invitation create requires the inviter's own tenant row to be active —
  closes the invitation channel of the leaked-authority class (R2-S2); the structural item —
  team authorization refuses a membership whose user's tenant row departed after the
  membership's admission (guests without a tenant row stay admitted) — closes the class, and
  needs a re-admission timestamp written by every re-activation writer (accept, members POST,
  approve, `returnToTenant`), since accept keeps `team_members.created_at`; an audit action for
  invitation accept (re-admission is unaudited today); and the accept pre-check stops
  marking an invitation ACCEPTED for an already-active member without admission checks (R2-S5); a team webhook stops delivering once its creator is no longer an active member (R3-S4).
- SC5: a departure processed by a previous-release instance during a rollout of `20261101` leaves
  its memberships active on every deployment; not this defect (role-independent), recorded on
  the follow-up issue.
- If C1 is chosen as a deadlock victim, `migrate deploy` fails and records the migration as
  failed; the operator re-runs after `prisma migrate resolve --rolled-back` (the transaction
  rolled back whole). Team key rotation is unavailable while C1 runs.

## User operation scenarios
- Operator on RDS deploys: C1 deactivates departed members' leftover memberships, expires stale
  invitations, fills re-key bookkeeping; tenant audit logs show each ended membership; C6 tells
  them to rotate the affected teams.
- Compose / CI deploy (migrate role bypasses RLS): the departure block skips (warning with a
  count, normally 0 unless members were re-admitted); the re-key block repairs only rollout
  stragglers (I2).
- Developer adds a backfill without bypass: static-checks fails with
  `MIGRATION_RLS_DML: <dir>:<line>: <table>`.

## Carried-Forward Plan Findings
- R10-T4 [Minor, (b) only reachable by building and executing] A `SET LOCAL lock_timeout` sent
  before the contain script's own `BEGIN` is a no-op, so the contain lock cell would wait until
  the test timeout. Anti-Deferral: the failure is loud (a timeout, not a vacuous pass), so no
  control goes unverified; settling it is choosing where the timeout goes when the cell is
  written — after the script's `BEGIN`, or session-level on a connection then destroyed.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Fix-forward migration: scoped bypass, departure role gate + warning, record exclusion, outbox rows | locked |
| C2 | Original migrations untouched | locked |
| C3 | Static gate over migrations + baseline | locked |
| C4 | Integration cells as NOBYPASSRLS role | locked |
| C5 | Gate self-tests | locked |
| C6 | Operator docs + tested report and contain scripts | locked |
