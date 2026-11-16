# Plan: departed-member-db-invariants (`#1060`)

Split out of `#1045` (`departed-member-followups-plan.md` SC4/SC5). Background:
`departed-member-leaked-authority-*`, `leftover-team-actor-authority-*`,
`session-revocation-failure-surfaces-{plan,deviation}.md` (`#1047`, merged as PR `#1064`).

Revision 6 (rounds 1–6 applied; finding IDs and dispositions in
`departed-member-db-invariants-review.md`).

## Project context

- Type: web app (Next.js App Router, Prisma 7, PostgreSQL 16 with FORCE RLS, bypass in enforce mode).
- Test infrastructure: unit + integration (real DB) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: this worktree has its own database `passwd_sso_wt_1060` (enforce mode, migrated to
    `20261116200000`). No worker runs against it. `verifiable-local`.
  - VE2: on RDS, migrations run as a NOSUPERUSER NOBYPASSRLS table owner. Locally and in CI the
    migrate role is a superuser. The migration is DDL only, so the role difference does not change
    what it does. `verifiable-local` (DDL) / `verifiable-CI` (fresh-database migrate, RLS seed,
    coverage, verify, negative test).
  - VE3: `scripts/pre-pr.sh` runs `rls-cross-tenant-verify.sql` against the dev database
    `passwd_sso`, which lacks this migration, so its 10b check is vacuous there. pre-pr also skips
    the integration suite on a `feat/` branch. Phase 2 runs both by hand, judged by exit code, with
    the database name printed in the output:
    - on a scratch database migrated from this branch, following CI's sequence;
    - on `passwd_sso_wt_1060`.

    `verifiable-local`.
  - VE4: red-proofs that replace the guard function run on scratch databases, through
    `scripts/manual-tests/departed-member-guard-redproof.sh` (Phase 2 artifact; not CI). For each
    mutation the script:
    - asserts that the template has no other connection;
    - runs `CREATE DATABASE <unique> TEMPLATE passwd_sso_wt_1060` as the superuser;
    - exports `DATABASE_URL`, `MIGRATION_DATABASE_URL` and every `*_DATABASE_URL` that `setup.ts`
      checks, all pointed at the scratch database;
    - runs the unmutated file first and requires it green;
    - applies one mutation, runs the file with the JSON reporter, and records the failing cell
      names and the exit code against the expected set;
    - drops the database in a `trap`;
    - in source mode, applies TypeScript mutations to a scratchpad copy of the tree.

    `verifiable-local`.

## Objective

Hold the two departed-member invariants in the database, so a writer the AST gate cannot see
(raw `ON CONFLICT`/`MERGE`, aliases, scripts, operator SQL) cannot break them, except through the
known bypasses and residuals listed in C1's control class:

- **I1 (grants).**
  - No grant reaches a leftover membership: an active `team_members` row whose user departed the
    team's tenant at or after the row's admission.
  - No team membership is activated while its user's tenant row is departed.
- **I2 (departures).** At the commit of a transaction that departs a user from a tenant, the user
  holds no active membership of the tenant's teams while departed. When the user's tenant row is
  active at commit (a return in the same transaction, or a departure record with a re-created
  row), the user holds no leftover membership. A return without a record clears the evidence
  itself: that is the undo class (Q3).

Definitions:

- departure = `GREATEST(tenant_members.deactivated_at, tenant_member_departures.departed_at)` for
  (tenant, user);
- admission = `COALESCE(team_members.admitted_at, team_members.created_at)`;
- leftover = active and `departure >= admission`; equality refuses, and no row and no record means
  never departed;
- departed now = the tenant row exists with `deactivated_at` set, or there is no tenant row and a
  record exists.

These are the SQL form of `actorDepartedSinceAdmission` (`src/lib/team/tenant-departure-read.ts`)
and of `share_creator_admitted` (`20261115000300`).

## Answers to the issue's open questions (evidence)

### Q1 Serialisation

**Grants need no lock.** A grant changes a row that is already active, so I2's commit check sees
that row as active whether or not the grant has committed:

- An application departure ends every active row of the user (`endTeamMemberships`,
  `deactivateScimUser`), under the row lock the grant's UPDATE holds.
- A key insert takes no row lock, but the row is ended anyway. `endTeamMemberships` never deletes
  keys, and `returnToTenant` restores members with their keys intact.
- A departure that leaves the row active is refused at commit, whatever the interleaving.

The routes already read a recipient's tenant row unlocked on this argument (`confirm-key`,
`members/[memberId]` `targetIsLeftover`, `rotate-key`). A tenant-row lock in the trigger would also
invert `tenant-row-lock.ts`'s order, because the trigger runs after the team lock.

**Activation against departure** (an INSERT of an active row, a re-activation, or a re-pointing of
identity) has a write skew without a lock: each side's check misses the other's uncommitted
write. Both sides therefore take `pg_advisory_xact_lock(hashtext('tenant-member:<tenant>:<user>'))`,
the activation in its trigger and the departure check at commit, before reading. This is
`advisoryKey()`'s key, taken by `lockTenantRows` in every mode and by `lockTenantMemberCreation`.

Application writers already hold it, so they never wait anew:

- admissions lock their targets (`grep -rn "lockTenantRows(" src`: members POST, invitation
  accept, `lockGroupWrite`, `scim-admission.ts`, teams POST);
- returns and departures lock through `departFromTenant` / `returnToTenant` / the engine's union
  lock, or through `lockTenantMemberCreation`, or through `deactivateScimUser`.

A raw departure writer inverts the order on its own: it holds the tenant row from its UPDATE and
takes the key only at commit, while an app admitter holds the key and waits for the row. One such
writer is enough for a deadlock. Postgres detects it (40P01), and nothing half-commits. (round 2
N8).

Because I2 refuses any active row of a departed-now user, it does not depend on the order of the
stamps either. A back-dated first stamp still leaves the user departed now, and so does a
departure stamped while an activation waited (round 2 N1).

The lock branches require READ COMMITTED, so that each plpgsql statement reads a fresh snapshot
after the wait. They raise otherwise, as `team_member_key_prune` does (`20261109100000`). The app
never sets an isolation level: `src/lib/prisma.ts` refuses `isolationLevel`.

**Plan-stage real-DB probe** (rev 1 prototype, dropped afterwards). It ran as two `pg` connections
for `passwd_app` under tenant context, `read committed` observed, no pooler (`@prisma/adapter-pg`
holds a `pg.Pool`).

- R1: a re-activation against a raw stamp. The stamp's commit waited, and was refused.
- R2: an INSERT waited on a held key, and was refused after the departure.
- R3: a grant against a raw stamp. Both ran, and the departure was refused.
- Red: without the lock, R1 committed a leftover and R2 did not wait; R3 stayed green.
- Totals: 19 deny/allow cells, 6 race cells and 1 seed cell, all green.

C7 T5 strengthens the witness.

### Q2 Residue wedge

Only a departure **transition** fires I2, and I2 judges only the firing (tenant, user).

What fires:

- a `tenant_members` INSERT with `deactivated_at` set;
- an UPDATE to a non-NULL stamp distinct from the old one;
- a `tenant_member_departures` INSERT or UPDATE.

A return (`→ NULL`), and any write to an already-departed row that leaves its stamp alone, do not
fire.

Every application departure ends all of the user's active rows in the tenant's teams. That
includes residue, re-admitted rows and guest rows (`endTeamMemberships`'s UPDATE has no admission
predicate; `deactivateScimUser` deletes them all). So:

- a batch that transitions a residue user passes;
- an already-departed residue user is not transitioned (`deactivated_at IS NULL` in the UPDATE), so
  nothing fires;
- other users' rows are never read.

Measured (read-only):

| Database | Leftover rows | Active rows while departed |
|---|---|---|
| dev `passwd_sso` | 0 | 0 |
| `passwd_sso_wt_1060` | 8 | 10 |

The worktree rows are earlier test runs' fixtures.

### Q3 Tenant-row DELETE, and undoing a departure

Not covered. A DELETE of a tenant row cannot be told from the bootstrap migration
(`src/auth.ts`: teams kept, the user reads as a guest). The AST pin of tenant-row deletes
(`tenantRowDeletes`, 2 sites) stays the control. `deactivateScimUser` writes its record before
its delete, and the record fires I2.

More generally the database does not judge **undoing a departure**. Two writes do it, and the
database cannot tell either from a legitimate operation:
- a return (`deactivated_at → NULL`), as `returnToTenant` does;
- deleting the tenant row, as the bootstrap migration does.

Each restores the user's authority by design, and each stays app-enforced: rule 2 confines tenant
active-state writes to `team-departure.ts`, and `tenantRowDeletes` pins the deletes.

Revision 3 had a guard on deleting a departed row. It is dropped (round 3):
- return-then-delete defeats it in two allowed statements (N10);
- it refuses the integration teardown, which deletes departed rows (F3-1);
- it guarded one member of a class whose other member, the return, cannot be guarded.

FK cascades and `TRUNCATE` fire none of these triggers.

### Q4 RLS context

The trigger function reads `teams`, `team_members`, `tenant_members` and `tenant_member_departures`
under `share_creator_admitted`'s SECURITY INVOKER pattern: save the three `app.bypass_*` settings,
set exactly those four tables with purpose `departed_member_guard`, and restore them before any
RAISE. Two reasons:

- under enforce mode `rls_bypass_admits` RAISES 42501 for a table outside the caller's list;
- a deferred trigger runs at COMMIT under whatever settings the transaction left.

A trigger function cannot be called directly, so it is no read oracle. Its messages carry only the
written row's own ids and a fixed code, never a value read under the bypass (round 2 N9). EXECUTE is
revoked from PUBLIC, and firing does not check it.

### Q5 Seeds

Refused states are written one statement at a time on the superuser connection, in a transaction
under `SET LOCAL session_replication_role = replica`, which disables triggers (constraint triggers
included) for that transaction only. The setting is superuser-only unless granted, and C4 audits
that (PG15+ `GRANT SET ON PARAMETER`, and role-level defaults).

The adopters are the files the migrated integration suite refuses. That covers states created by a
raw stamp, a record, a re-activation while departed, or an UPDATE of `team_members.created_at`.

`scripts/rls-cross-tenant-seed.sql` is in class:

- it inserts A1/B1's record at `NOW()` and their OWNER rows later, in autocommit statements;
- `TIMESTAMPTZ(3)` can tie them;
- the record moves to `NOW() - interval '1 day'`.

### Q6 Rule 8

Retired. Every grant spelling is judged by the trigger, and a demotion passes, so the member PUT
exemption goes too. The routes keep their recipient checks (404/409, audit, unit tests), and the
trigger turns a missed check into a 500.

Not covered by the database:

- undoing a departure: a return, or a tenant-row DELETE (Q3; rule 2 and the AST pin);
- `TRUNCATE`;
- a change of `teams.tenant_id` (re-homing a team; `trg_enforce_tenant_id_teams` admits it under a
  bypass), which leaves its member rows keyed to the old tenant;
- key rows for an absent membership (SC3);
- writers holding trigger-disabling privilege (C1).

Kept: rules 1–7 and 9–10, `departureWriters` (it also keeps the per-team
`TEAM_MEMBER_TENANT_DEACTIVATE` audit rows) and `tenantRowDeletes`.

## Contracts

### C1 — Guard function, triggers and index (migration)

`prisma/migrations/20261117000000_departed_member_guard/migration.sql`, `BEGIN`/`COMMIT`, DDL only.

- `public.departed_member_guard() RETURNS trigger` is plpgsql, `VOLATILE SECURITY INVOKER SET
  search_path = public, pg_temp`, with `REVOKE EXECUTE … FROM PUBLIC`.
- The mirror comment in `tenant-departure-read.ts` names it beside `share_creator_admitted`.

Triggers:

| Trigger | Table | Timing |
|---|---|---|
| `trg_team_members_departed_member_guard` | `team_members` | BEFORE INSERT OR UPDATE, row |
| `trg_team_member_keys_departed_member_guard` | `team_member_keys` | BEFORE INSERT OR UPDATE, row |
| `trg_tenant_member_departures_stamp_guard` | `tenant_member_departures` | BEFORE UPDATE, row |
| `tenant_members_departure_ends_memberships_ins` | `tenant_members` | AFTER INSERT WHEN `NEW.deactivated_at IS NOT NULL`; constraint, DEFERRABLE INITIALLY DEFERRED |
| `tenant_members_departure_ends_memberships_upd` | `tenant_members` | AFTER UPDATE OF `deactivated_at`, `tenant_id`, `user_id` WHEN the new stamp is non-NULL and the stamp, tenant or user differs from OLD (re-keying a departed row is a departure of the new key, round 4 R4-1); same |
| `tenant_member_departures_ends_memberships` | `tenant_member_departures` | AFTER INSERT OR UPDATE; same |

**`team_members` (judged on NEW).**

- Always: `NEW.tenant_id` = the team's `tenant_id`.
- On UPDATE: `created_at` unchanged. No code writes it; Prisma fills it from the application clock
  at INSERT.
- When NEW is active, one of three arms applies:
  - **Activation** — an INSERT, `OLD.deactivated_at IS NOT NULL`, or a changed `(tenant_id,
    user_id, team_id)`. It takes the key under READ COMMITTED, then refuses in two cases:
    - the user's tenant row exists with `deactivated_at` set (S1). A record without a row does
      not refuse: that user is a guest (SC2);
    - the row is leftover.
  - **Grant** — a role-rank raise (OWNER 3 > ADMIN 2 > MEMBER 1 > VIEWER 0; any other label raises)
    or `key_distributed` false → true. It refuses when the row is leftover, with no lock.
  - Otherwise (demotion, ending, other columns) it passes.

**`team_member_keys`.** Requires `NEW.tenant_id` to equal the team's tenant. Refuses in two cases:
- (tenant, user, team) has an active leftover row;
- the member row exists and is deactivated.

No writer creates or re-wraps a key for an ended member: rotate-key, confirm-key and teams POST
write keys only for active rows. Ended rows keep the keys they already hold, which are not
rewritten (round 4 R4-2).

**Record stamp guard.** Refuses lowering `departed_at`. Its one writer stamps `clock_timestamp()`
(round 1 S3). The tenant-row stamp has no lowering guard: lowering a stamp is itself a departure
transition, and I2 judges it by "departed now" (round 2 F2-2: `departCreatedMembership` re-stamps an
application-clock placeholder with the database clock).

**Departure (I2), deferred.** At commit, under READ COMMITTED, take the key of the firing (tenant,
user). Then refuse in either case:

- the user is departed now and holds any active row in the tenant's teams;
- the user is not departed now and holds a leftover row.

**Trigger order is load-bearing.** Same-event BEFORE triggers fire in name order. The guard runs
after `team_members_set_admitted_at` (so NEW carries the trigger-owned admission) and after
`trg_enforce_tenant_id_*` (so a derived `tenant_id` is filled).

**Index (F-1).** `CREATE INDEX team_members_tenant_id_user_id_idx ON team_members (tenant_id,
user_id)`, mirrored as `@@index([tenantId, userId])`.

**Errors.** `RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:<arm>: …' USING ERRCODE = 'check_violation'`,
with the written row's own ids only. `<arm>` is a fixed token, one per refusal:

| Token | Refusal |
|---|---|
| `tenant_mismatch` | the row's tenant is not the team's |
| `created_at` | `created_at` changed on UPDATE |
| `unknown_role` | the role has no rank |
| `activation_departed` | activation while the tenant row is departed |
| `activation_leftover` | activation of a leftover row |
| `grant_leftover` | grant to a leftover row |
| `key_leftover` | key row for a leftover membership |
| `key_inactive` | key row written for an ended membership |
| `record_lowered` | `departed_at` lowered |
| `isolation` | the transaction is not READ COMMITTED |
| `departure_active` | departed now and still holding an active row |
| `departure_leftover` | not departed now and still holding a leftover row |

**Control class:** enforceable boundary for writes that reach the guarded tables' triggers, by a role
that cannot disable triggers, apart from the bypasses and residuals listed below.

- Known bypasses:
  - a superuser's `session_replication_role = replica`;
  - `ALTER TABLE … DISABLE TRIGGER` by the table owner (the migrate role, `rds_superuser` on RDS);
  - undoing a departure (Q3);
  - `TRUNCATE`;
  - re-homing a team.

  The app roles hold no TRIGGER privilege on the guarded tables (C4 audit), so they cannot create
  a trigger that skips these.
- Residuals:
  - SC3;
  - a grant to an active row of a departed-now user whose admission is after the departure. It
    is judged by the leftover predicate, the same predicate rule 8 required of the routes
    (`actorDepartedSinceAdmission`), so retiring rule 8 drops no check. Such rows come from three
    sources:
    - pre-migration residue;
    - the re-admit script;
    - a SCIM-deleted user admitted as a guest (record and no row, SC2).

    Round 4 R4-3; the Anti-Deferral entry is in the review log.

### C2 — Serialisation (Q1)

- The activation branch and the departure check take the key and require READ COMMITTED. Grants
  take no lock.
- `advisoryKey()` lowercases both ids. Today neither is lowercased inside it: `lockTenantRows`
  lowercases user ids before calling it, and `lockTenantMemberCreation` passes the id raw (round 2
  T-7).
- **Invariant (schema-enforced):** I2 holds under concurrent activations by any writer. App writers
  take no new wait.
- **Control class:** enforceable boundary. Adjudication authority: the Postgres lock manager.
- **Acceptance:** C7 T5.

### C3 — Firing set (Q2)

As in the C1 table. **Acceptance:** C7 T4, plus the full integration suite green after the migration.

### C4 — RLS context, routine allowlist, parameter audit

- Bypass: exactly `teams,team_members,tenant_members,tenant_member_departures`, purpose
  `departed_member_guard`, saved and restored.
- `scripts/rls-cross-tenant-verify.sql` 10b:
  - the allowlist entry, in the NOT IN lists and the header;
  - an exact-list assertion shaped like `share_creator_admitted`'s: two `app.bypass_tables` writes.
- `src/lib/tenant-rls-purpose.ts` records the database-side purpose.
- `scripts/audit-db-grants.mjs` gains a parameter class from `has_parameter_privilege(role,
  'session_replication_role', 'SET')` and `… 'ALTER SYSTEM'`. These cover direct, PUBLIC and
  inherited grants.
  - It also reads `pg_db_role_setting` for a role default that names `session_replication_role`.
  - Keys use the shape `PARAMETER:<role>\t<parameter>\t<privilege>`.
  - No row is expected for the audited roles, so the manifest stays empty of them.
  - A pure key builder is exported and unit-tested.
- **Acceptance:**
  - C7 T6.
  - On the scratch CI-sequence database, seed, coverage, verify and the negative test exit 0. With
    the 10b entry removed, the run reports `E-RLS-BYPASS-ROUTINE`.
  - The audit exits 0 on `passwd_sso_wt_1060`.
  - Its red-proof never touches `passwd_app` and adds no override knob to the audit. It runs a
    scratchpad copy of `audit-db-grants.mjs` with a throwaway role `rp_param_probe` appended to
    `AUDITED_ROLES`, in three runs, each exiting 1 with its expected key:
    - `GRANT SET ON PARAMETER session_replication_role`;
    - `GRANT ALTER SYSTEM ON PARAMETER session_replication_role`;
    - `ALTER ROLE rp_param_probe SET session_replication_role = replica`.
  - Parameter ACLs and roles are cluster-wide, so a `trap` revokes the grants and drops the role,
    and the run asserts `pg_parameter_acl` and `pg_db_role_setting` hold nothing for it (round 2
    T-3, round 3 Q-4).
  - The audit already covers TRIGGER on the tables. The run confirms the manifest grants the app
    roles none on the four guarded tables (round 3 N13).

### C5 — Tenant-row DELETE

No trigger. The gate's `tenantRowDeletes` pin and its two exemptions are unchanged (Q3).

### C6 — Seeds and operator scripts

- `src/__tests__/db-integration/helpers.ts`: `writeRefusedState(su, sql, params)`.
  - It runs ONE statement on the superuser client in its own transaction under `SET LOCAL
    session_replication_role = replica`, and ROLLBACKs on error.
  - A comment says why it exists.
- Adopters: `residueDepart` / `recreatedDepart` (`departed-member-leaked-authority`,
  `leftover-team-actor-authority`), and every file the migrated suite refuses. The teardown
  (`deleteTestData`) needs no change once the DELETE guard is dropped. The suite run confirms it.
- `scripts/rls-cross-tenant-seed.sql`: the record moves to `NOW() - interval '1 day'`.
- Runbook re-admit script (S1). After its advisory, row and team locks, and immediately around the
  two re-activating UPDATEs, it does the following:
  - `SET LOCAL lock_timeout = '5s'`;
  - asserts `tgenabled = 'O'`;
  - `ALTER TABLE team_members DISABLE TRIGGER trg_team_members_departed_member_guard`, the UPDATEs,
    then `ENABLE TRIGGER`, all in its one transaction.

  The runbook states that only the owner can do this, and that `team_members` writers stall until
  commit.
- **Acceptance:**
  - The full suite exits 0 on `passwd_sso_wt_1060` before and after the migration. Compare the JSON
    reports by file and cell; they must be identical except for the new file.
  - `departed-member-operator-scripts` and `operator-scripts-rds-shaped` (owner role) pass the
    re-admit script.

### C7 — Integration tests

New `src/__tests__/db-integration/departed-member-db-invariants.integration.test.ts`.

- Runs as `passwd_app` under tenant context unless a cell says otherwise, with `assertRlsApplies`.
- One tenant per cell; cleanup is registered at creation.
- Each refusal asserts SQLSTATE 23514 plus its `DEPARTED_MEMBER_GUARD:<arm>` token.
- An "at the statement" cell asserts that the failing step is the statement, not COMMIT. A "refused
  at COMMIT" cell asserts that the statement succeeded.
- Raw cells keep departures at least 1 s from admissions.
- Phase 2 runs the file in a loop:
  `for i in $(seq 20); do npx vitest run --config vitest.integration.config.ts <file> || exit 1; done`.
  It then asserts that no fixture rows leaked.

**T1, grants.** Deny the raises VIEWER→MEMBER, MEMBER→ADMIN, ADMIN→OWNER and `key_distributed`
false→true:

- on residue, `containable = false`, and departure equal to admission;
- via a plain UPDATE, `ON CONFLICT DO UPDATE` and `MERGE`.

Also deny a `created_at` UPDATE and a mismatched `tenant_id`. The `created_at` deny's pair is an
UPDATE that sets `created_at` to its own value.

Allow:

- OWNER→VIEWER, and a same-role no-op on residue;
- ending a residue row;
- `key_distributed` true→false;
- a grant to a never-departed member and to a guest;
- a grant after a return, and with admission 1 s after the departure;
- scenario 3 (in one transaction, demote the leftover OWNER and promote a non-leftover);
- every `pg_enum` label of `TeamRole` is ranked. A scratch-only unknown label raises.

**T2, keys.** Deny INSERT, UPDATE and `ON CONFLICT` for a leftover recipient; INSERT and UPDATE for
an ended, non-leftover member, so that `key_inactive` is the only refusal (it is checked before
`key_leftover`); a mismatched `tenant_id`. Allow an active non-leftover member, and the ending of a
member whose key rows stay untouched.

**T3, activation.**

- Deny:
  - an INSERT born leftover, with `tenant_id` given and with it omitted;
  - an INSERT while the tenant row is departed (S1);
  - a re-activation while the tenant row is departed;
  - re-pointing an active row to a departed user;
  - an activation under REPEATABLE READ.
- Allow:
  - an INSERT and a re-activation after a return;
  - an INSERT for a guest, and for a guest who has a record and no tenant row (SC2);
  - an INSERT with `tenant_id` omitted for a non-departed user;
  - re-pointing to a non-departed user;
  - an INSERT whose `created_at` is 1 s in the future, for a user who departed and returned
    (stored as given; no bound);
  - the re-admit script shape (owner), after which `tgenabled = 'O'`.
- Plus a `pg_trigger` name-order supplement.
- Plus an app-driven cell: invitation accept by a user departed before the invite answers
  `INVITATION_EXPIRED`, leaves the invitation `EXPIRED`, and creates no membership (C9). Its pair: an
  active invitee is admitted.

**T4, departure.**

- Deny, refused at COMMIT, not at the statement:
  - a stamp that leaves an active row;
  - a back-dated first stamp that leaves a row admitted after it;
  - a restamp while residue is active;
  - a record INSERT and a record UPDATE, each leaving an active row;
  - a row created deactivated that leaves one;
  - a departure under REPEATABLE READ;
  - a stamp and a return in one transaction, while the user has a departure record later than the
    row's admission, so the row stays leftover through the record (`departure_leftover`);
  - a record with a re-created active tenant row, leaving a row admitted before the record;
  - re-keying a departed tenant row onto a user with an active row, once by `user_id` and once by
    `tenant_id`;
  - with pair cells: the same re-key onto a user with no active row commits, and a stamp and a
    return with no later record commits.
- Deny at the statement:
  - lowering `departed_at`;
  - `SET CONSTRAINTS ALL IMMEDIATE` before the ending (documented).
- Allow:
  - a departure that ends its rows;
  - a return and then a re-admission in one transaction;
  - a raised `departed_at` and an equal one;
  - a non-transition write of a residue user;
  - departing X while Y is leftover;
  - departing from A while the user is active in B;
  - deleting an active row (bootstrap shape), and return-then-delete (recorded as not judged, Q3);
  - an INSERT deactivated with a placeholder 1 s in the future, then a restamp with
    `clock_timestamp()` that is lower than the placeholder (F2-2);
  - the integration teardown over a departed tenant row;
  - the production writers on `passwd_app` under `withTenantRls`: `departFromTenant` over a residue
    user and a normal one, `departCreatedMembership` of a guest member, `deactivateScimUser` of a
    user with residue, and `returnToTenant`.
- A catalog cell: `team_members_tenant_id_user_id_idx` exists on `(tenant_id, user_id)`.

**T5, races** (`createRaceHelpers`; clients with `lock_timeout`, ROLLBACK and end in `finally`).

- Each wait is witnessed three ways: the blocker pid is the other client's, `pg_locks` holds an
  ungranted `advisory` row for the waiter, and the waiting statement is the expected one.
- Pre-state and `SHOW transaction_isolation` are asserted.
- R1 and R2 run in both commit orders. The held side takes the key through `lockTenantRows` /
  `lockTenantMemberCreation` with **upper-case** ids. The TypeScript and SQL keys are
  cross-checked only where the held write is a stamp ("stamp holds", "departure holds"): a held
  activation takes the lowercase key again in its own trigger, so the other two orders wait on it
  whatever `advisoryKey` produced (deviation D5).
- R3 runs as in the probe.
- Scenario 5: rotate-key's transaction against `deactivateScimUser` of a key holder; both commit,
  with no 40P01.

**T6, bypass and seeds.**

- Under a `team_members`-only bypass, a passing guarded write and a refused one each leave the
  three `app.bypass_*` settings at their prior values, and a `tenant_members` read still gets
  42501. The same holds after the deferred check.
- `passwd_app` cannot `SET session_replication_role`.
- After a successful and after a refused `writeRefusedState`, the same superuser client shows
  `session_replication_role = origin`, and a violating write on it is refused.

**Red-proofs** (VE4 runner; one mutation per row; the failing set compared by name, each with
its arm token). The `advisoryKey` and seed-helper rows mutate TypeScript, so the runner's
source mode applies them to a scratchpad copy of the tree, never the worktree.

| Clause | Mutation | Expected red |
|---|---|---|
| `>=` | `>` | T1 equality |
| admission `COALESCE` | `created_at` only | T1 "grant after a return" |
| `GREATEST` inputs | drop the record input / drop the tenant-row input | T1 `containable = false` / T1 residue |
| role rank | swap OWNER and ADMIN; drop a label | T1 ADMIN→OWNER; T1 enum completeness |
| `key_distributed` grant arm | drop it | T1 `key_distributed` cells |
| grant leftover refusal | drop it | T1 residue raise cells (`grant_leftover`) |
| key-row leftover check | drop it | T2 INSERT / UPDATE / `ON CONFLICT` deny (`key_leftover`) |
| key-row ended-member check | drop it | T2 ended-member deny (`key_inactive`) |
| tenant-row re-key firing | `UPDATE OF deactivated_at` only / drop `tenant_id` from the list | T4 re-key by `user_id` / by `tenant_id` |
| activation leftover refusal | drop it | T3 born-leftover deny, both `tenant_id` spellings (`activation_leftover`) |
| unknown-role raise | `ELSE 0` | T1 scratch unknown-label cell (`unknown_role`) |
| S1 departed-now on activation | drop it | T3 INSERT while departed, re-activation while departed |
| re-pointing arm | drop it | T3 re-pointing deny |
| `created_at` UPDATE ban | drop it | T1 `created_at` |
| tenant mismatch | drop it | T1 and T2 mismatch |
| record stamp guard | drop it | T4 lowering |
| I2 departed-now arm | leftover only | T4 back-dated stamp |
| I2 not-departed-now arm | drop it | T4 stamp-and-return, T4 record with re-created row |
| each deferred trigger | drop it (three rows) | its T4 deny cell |
| `WHEN` transition filter | fire on every UPDATE / fire on `→ NULL` | T4 non-transition allow / T4 return of a user a later record keeps leftover |
| activation lock | remove | T5 R1 "stamp holds", R2 "departure holds" (the activation waits) |
| departure-check lock | remove | T5 R1 "re-activation holds", R2 "INSERT holds" (the COMMIT waits) |
| a lock on the grant arm | add | T5 R3 waits, scenario 5 |
| isolation check | remove, per branch | T3 / T4 REPEATABLE READ |
| bypass restore | remove | T6 passing cells (the refused cells' savepoint rollback reverts the settings either way) |
| trigger order | rename to sort first | T3 omitted-`tenant_id` allow (`tenant_mismatch` on a NULL tenant); T1 "grant after a return" |
| index | drop | T4 catalog cell |
| `advisoryKey` lowercase | revert | T5 R1 "stamp holds", R2 "departure holds" |
| seed helper scope | `SET` instead of `SET LOCAL` / no ROLLBACK | T6 `origin` cell |
| parameter class | three throwaway runs (C4) | the audit exits 1 on each, with its key |

Separately, on scratch copies after the migration, remove each route recipient check (confirm-key,
member PUT, rotate-key, owner assign, the C9 accept clause). Each one's existing cell goes red by
status.

### C8 — Rule 8 retirement and documentation (Q6)

- `scripts/checks/check-team-rotation-input-lock.mjs`:
  - remove rule 8's analysis, the `grants` class, `EXPECTED.grants`, the nine `grant::` EXEMPTIONS,
    and its header text and KNOWN LIMITS;
  - the header names the migration as the I1/I2 control;
  - update the `#1060` notes on the kept rules.
- The self-test drops rule 8's cells, `grants`, `EXEMPT_GRANTS` and
  `TEAM_ROTATION_INPUT_LOCK_GRANTS`. It adds one positive cell (an unchecked
  `teamMember.update({ data: { role: "ADMIN" } })` passes with the rule-1 counts set; the same
  fixture fails on the base commit, recorded). The real-tree counts differ by the `grants` class
  only.
- `docs/operations/departed-member-access-backfill.md`, "What prevents a recurrence, and its
  limits". It states:
  - what the database refuses (C1), and its bypasses;
  - that a manual stamp needs the ending in the same transaction;
  - the cascade, `TRUNCATE` and active-row DELETE gaps;
  - the incident procedure: the owner disables the named trigger and re-enables it in one
    transaction with `ON_ERROR_STOP`, and records why;
  - that section 1 of the report is run before deploying;
  - restores: triggers load post-data, and a data-only restore uses `--disable-triggers`.

  The re-admit script changes per C6.
- `docs/operations/sentinel-tenant-membership.md` step 3 (a raw departure stamp): it gains a note that
  if the member holds active team rows in that tenant, the stamp is refused at commit
  (`departure_active`). The fix is to end those rows in the same transaction, as the contain script
  does (round 5 F5-1).
- `src/lib/team/team-departure.ts` header and the `rls-cross-tenant-verify.sql` header: updated.

### C9 — Invitation accept refuses an invitee departed before the invite (round 2 F2-3)

`src/app/api/teams/invitations/accept/route.ts`:

- The existing refusal arm (expire the invitation, then answer `INVITATION_EXPIRED`) gains one
  condition: the invitee's locked tenant row has `deactivatedAt !== null`.
- Without it, S1 would turn that accept into a 500 that leaves the invitation pending.
- Route unit cell: a departed invitee, with the paired active invitee. Integration: C7 T3.

## Files

- New:
  - the migration;
  - `departed-member-db-invariants.integration.test.ts`;
  - `scripts/manual-tests/departed-member-guard-redproof.sh`.
- Changed:
  - `prisma/schema.prisma`;
  - `src/lib/team/tenant-row-lock.ts` (+ test);
  - `src/lib/team/tenant-departure-read.ts`, `src/lib/team/team-departure.ts`;
  - `src/lib/tenant-rls-purpose.ts`;
  - `src/app/api/teams/invitations/accept/route.ts` (+ test);
  - `src/__tests__/db-integration/helpers.ts` and the adopters;
  - `scripts/rls-cross-tenant-seed.sql`, `scripts/rls-cross-tenant-verify.sql`;
  - `scripts/audit-db-grants.mjs` (+ test), `scripts/checks/db-grants-manifest.json` if regenerated;
  - `scripts/checks/check-team-rotation-input-lock.mjs` (+ self-test);
  - `docs/operations/departed-member-access-backfill.md`, `docs/operations/sentinel-tenant-membership.md`.

## Forbidden patterns

- `pattern: SECURITY DEFINER` in the new migration — reason: invoker + saved bypass (C4).
- `pattern: GRANT EXECUTE ON FUNCTION public.departed_member_guard` — reason: no role needs it.
- `pattern: DISABLE TRIGGER` in `src/` — reason: seeds bypass per transaction; only the runbook
  re-admit script and its test fixture disable the trigger.
- `pattern: grant::` in `scripts/checks/check-team-rotation-input-lock.mjs` — reason: rule 8 retired.

## Testing strategy

- Integration:
  - C7 and the C6 adopters;
  - the full suite on `passwd_sso_wt_1060` before and after the migration, with
    `--reporter=json --outputFile`, diffed by file and cell, judged by exit code.
- Unit and gates: `npx vitest run`, the gate self-test, the audit tests, `npx next build`,
  `scripts/pre-pr.sh`.
- DB gates (VE3), on the scratch CI-sequence database: seed, coverage, verify, negative test. Then
  `audit-db-grants.mjs`, `check-migration-transaction`, `check-migration-drift` and
  `check-migration-rls-dml`.

## Considerations & constraints

- A trigger refusal in an application path is an unmapped 500 and never commits. The route checks
  answer first, and C9 closes the one path that did not.
- Admission is judged on the application-clock `created_at`. An admission whose `created_at`
  precedes a departure record committed while it waited is born leftover. The route gates judge
  that row the same way, so refusing it keeps the two adjudicators aligned, and a retry succeeds.
- Cost:
  - one `teams` PK read, plus indexed tenant-row and record reads per guarded write;
  - one `(tenant_id, user_id)` index read per departing user at commit;
  - the index build is one table scan inside the migration's transaction.
- `#1032` touches tenant-level footholds. The shared candidates are the gate and the runbook;
  conflicts are resolved at rebase.
- **Scope contract:**
  - SC1: a DELETE of an active tenant row, and `TRUNCATE`, stay with the AST pin (Q3).
  - SC2: a guest admission by a user who has a record but no tenant row, admitted after that record,
    is not a leftover. It stays app-enforced.
  - SC6: re-homing a team (`teams.tenant_id` change) is not judged. Anti-Deferral entry in the
    review log.
  - SC3: a key row for an **absent** membership (no `team_members` row) is not judged; ended rows
    are judged (C1, `key_inactive`). Anti-Deferral entry in the review log (round 4).
  - SC4: gate rules 2, 9, 10, `departureWriters` and `tenantRowDeletes` are unchanged. They remain
    the controls for undoing a departure (Q3).
  - SC5: tenant-level footholds are `#1032`.

## User operation scenarios

1. A nightly directory sync drops a user with residue memberships. The run ends them all and
   commits. An already-departed residue user in the batch does not fail it.
2. An operator's raw role raise for a leftover member is refused. So are the two-step
   end-then-reactivate, and a back-dated stamp that leaves rows active. Undoing the departure (a
   return, or deleting the tenant row) is not judged by the database: it stays with rule 2 and the
   AST pin. The contain and re-admit scripts still work.
3. A tenant admin assigns a new OWNER where the old OWNER is leftover: the leftover is demoted and
   the new OWNER promoted.
4. A future departure writer that forgets `endTeamMemberships` fails at commit in every test that
   departs a team member.
5. A key rotation runs while SCIM deletes a key holder. Both commit in some order.
6. A user departed from the tenant accepts a team invitation issued afterwards. The answer is
   "invitation expired", not a 500.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Guard function, six triggers, arm tokens, `(tenant_id, user_id)` index | locked |
| C2 | Advisory-key serialisation, READ COMMITTED check, `advisoryKey` lowercases both ids | locked |
| C3 | Firing set: departure transitions, firing (tenant, user) only | locked |
| C4 | Bypass pattern, routine allowlist, purpose, parameter-privilege audit | locked |
| C5 | Tenant-row DELETE and departure undo stay with rule 2 and the AST pin | locked |
| C6 | Replica seed helper, adopters, RLS seed, re-admit script | locked |
| C7 | Integration cells T1–T6 and the red-proof matrix | locked |
| C8 | Rule 8 retired; gate header and runbook | locked |
| C9 | Invitation accept refuses an invitee departed before the invite | locked |

## Implementation Checklist

Phase 2, Step 2-1 (impact analysis recorded).

- **B0 (orchestrator):**
  - the migration and the `schema.prisma` index (done; deployed to `passwd_sso_wt_1060`; drift,
    transaction and RLS-DML gates green);
  - `advisoryKey` lowercasing and its unit test;
  - C9 accept clause and its route unit test;
  - `tenant-rls-purpose.ts`;
  - the comments in `tenant-departure-read.ts` and `team-departure.ts`;
  - `rls-cross-tenant-verify.sql` 10b and its header;
  - `rls-cross-tenant-seed.sql` record date;
  - the runbook: re-admit script and C8 limits;
  - the `sentinel-tenant-membership.md` note.
- **B1 (sub-agent):** C8 gate retirement. Files: `scripts/checks/check-team-rotation-input-lock.mjs`
  and `scripts/__tests__/check-team-rotation-input-lock.test.mjs`. Any `TEAM_ROTATION_INPUT_LOCK_GRANTS`
  reference: `grep -rn TEAM_ROTATION_INPUT_LOCK_GRANTS` finds only those two files.
- **B2 (sub-agent):** the C4 parameter class. Files: `scripts/audit-db-grants.mjs`, its
  `scripts/__tests__/audit-db-grants-*.test.mjs`, and the manifest if regenerated.
- **B3 (sub-agent, after B0):** C6 and C7 —
  - `helpers.ts` `writeRefusedState`, the new integration file, and the adopters found by the full
    run;
  - the baseline run on a scratch copy without the migration;
  - the 20× loop.
- **B4 (sub-agent, after B3):** the VE4 red-proof runner
  `scripts/manual-tests/departed-member-guard-redproof.sh` and the matrix run. Results go to the
  deviation log.
- **Reuse:**
  - `createRaceHelpers` (`race-helpers.ts`);
  - `createTestContext`, `assertRlsApplies`, `sqlStateOf` / `pgErrorCode`;
  - `withTenantRls`, `departFromTenant` / `returnToTenant` / `departCreatedMembership` /
    `deactivateScimUser`;
  - `lockTenantRows` / `lockTenantMemberCreation`;
  - the save/set/restore spelling of `share_creator_admitted`.
- **R19 test trees:**
  - `tenant-row-lock` is tested in `src/lib/team/tenant-row-lock.test.ts` (check for twins with
    `grep -rl advisoryKey src`);
  - the accept route is tested in its colocated `route.test.ts` and in
    `src/__tests__/api/teams/team-invitations.test.ts` (check).
- **CI parity:**
  - the integration job runs the new file;
  - the `rls` job runs seed, coverage, verify and the negative test on a fresh migrate;
  - `check:migration-drift`, `check-migration-transaction` and `check-migration-rls-dml` are in
    pre-pr;
  - the integration suite and the RLS verify on a migrated database are not in pre-pr for this
    branch (VE3), so they are run by hand.
