# Plan: append-only history for tenant-claim routing changes (SC11 / issue #743)

Date: 2026-07-31
Branch: `feat/tenant-claim-event-history`
Revision: 4 (locked; three review rounds — see `sso-tenant-claim-event-history-review.md`)

> Placeholder policy inherited from `sso-tenant-domain-alias-plan.md`: no real
> customer domains or email addresses. Use `primary.example` / `alias.example`.

**Why this document is short, and shorter than revision 3.** Its predecessor reached
1951 lines, and revision 5 of that plan recorded the lesson: at that size the plan is
the defect surface. Revision 3 of *this* plan grew to 1072 lines, and round-3 review
(**H8**) diagnosed the growth precisely — it was not contracts, it was
"what a previous revision said and why it was wrong", threaded through every
contract. That belongs in the review file, which is the artifact of record for
findings and their disposition. Revision 4 keeps the obligation and the criterion,
cites the finding ID that produced each, and drops the litigation. Anything `tsc`,
`vitest`, `next build` or a repo gate decides in seconds is not specified here.

**Status after three rounds**: 3 Criticals and 21 Majors, **none against the
design**. The table shape, the two-layer model, the in-transaction write, the six
writers and the attribution model have drawn no finding since revision 1; every
finding has been against this document's own mechanism specifications. All three
experts independently judged a fourth round unwarranted. The remaining verification
is Phase 2's toolchain and Phase 3's review of real code.

---

## Project context

- **Type**: web app (Next.js 16) + operator CLI + Postgres 16 (Prisma 7)
- **Test infrastructure**: unit (vitest) + real-DB integration + E2E + CI + ~67 repo gates
- **Verification environment constraints**
  - **VE1 — the dev database is shared between working copies.** Everything must be
    idempotent and must not assume a single consumer. Every claim fixture carries a
    per-run token; no criterion asserts a global row count; every throwaway object
    carries a per-run name and is dropped in a `finally`. `verifiable-local`.
  - **VE2 — append-only DDL makes test rows undeletable by default.** With `DELETE`
    blocked, integration rows accumulate on the shared dev DB. C1 owns the deliberate
    escape; without it the suite is un-runnable rather than merely untidy.
    `verifiable-CI`.
  - **VE3 — the harness's "superuser" client is neither guaranteed to be a superuser
    nor the owner.** `createPrismaForRole("superuser")` falls back to `DATABASE_URL`
    when `MIGRATION_DATABASE_URL` is unset, and `.env.example` ships that variable
    commented out, so an unconfigured working copy runs as `passwd_app`. Separately,
    `passwd_user` is SUPERUSER in dev but not on RDS. Consequences both ways: a
    privilege control asserted through a superuser proves nothing (a revoke does not
    bind it), and a control asserted through `passwd_app` is the only one that
    verifies the production shape. `verifiable-CI`.
  - **VE4 — grant ORDER differs between dev and CI.** Dev grants at initdb, before
    the migration, so a migration's REVOKE survives; CI grants `ON ALL TABLES` after
    `prisma migrate deploy` and then re-applies the policy with
    `bootstrap-rds-roles.mjs --denied-only`. A privilege assertion must assert its own
    precondition or it is green for the wrong reason in one of the two.
    `verifiable-CI`.
  - **VE5 — `MIGRATION_DATABASE_URL` names a different role in each environment**
    (`passwd_user` locally, `postgres` in CI). No test may assert a literal `db_user`.
    `verifiable-CI`.
  - **VE6 — the live `audit-outbox-worker` container reddens a different unrelated
    integration file on each local run** (D-24). Not a defect in this diff; check
    whether a failing file is one this branch touches before acting.
  - **VE7 — an IdP actually re-asserting a changed claim is not reproducible
    locally.** `blocked-deferred`. **Anti-Deferral**: nothing here depends on it — the
    sign-in writer is reached with a plain string, and that seam is exercised in CI by
    C4's cases, so the unreproducible link buys no coverage.

---

## Objective

Make the two `tenant_claims` mutations that destroy their own evidence —
`add --from` (overwrites `tenant_id`) and the un-revoke path (nulls `revoked_at`) —
reconstructible from the database, with attribution that is not self-asserted.

Non-objective: replacing `audit_logs`, or auditing reads.

---

## Requirements

### Functional

- **F1** Every write that changes which tenant a claim resolves to, or its revocation
  state, appends one row naming **both** the prior and the resulting state, in the
  **same transaction** as the write.
- **F2** One incident is one row. A reassignment names the losing and the gaining
  tenant together (splitting it reproduces D-33's "one incident, two groups").
- **F3** A history row survives deletion of the claim row and of **either** tenant it
  names — including the case where only one of a reassignment's two tenants is
  deleted. Scoped, deliberately, to `DELETE FROM tenants` and to claim-row deletion:
  the purge routine is a sanctioned deletion path and F3 does not constrain it (C1).
- **F4** Attribution is recorded in two kinds: the self-asserted operator label
  (`--by` on all four CLI verbs, or `signin` for the auto-registration path) and the
  executing Postgres principals, which the writer cannot choose. **Both**
  `current_user` and `session_user`: the first follows `SET ROLE` and a
  `SECURITY DEFINER` context, the second does not, and the pair distinguishes *who
  acted* from *who authenticated*.
- **F5** History is queryable by an operator without hand-written SQL, **including for
  a tenant whose row no longer exists** — which rules out resolving the selector
  through `tenants`.
- **F6** Existing rows cannot be modified or removed by the application role, and
  cannot be modified or removed *accidentally* by any role. Against the owner the
  control is a tripwire, not a boundary — see C1's control class.

### Non-functional

- **NF1** No behaviour change for a deployment that never runs `tenant-domain`: the
  only new work on the hot path is one INSERT on first-ever tenant creation. A sign-in
  that resolves an **existing** claim writes nothing.
- **NF2** No new startup requirement and no new environment variable. Mechanical for
  C3's module via `check-env-docs` check 12 (`src/**` only); **not** mechanical for
  C6's CLI work, because that gate does not scan `scripts/`.
- **NF3** Every new guard must be provably able to fail, demonstrated rather than
  asserted (RT7) — and red-proved on a throwaway object, never by mutating the shared
  dev database or the real roles.

---

## Technical approach

### Why a dedicated table (settled during #740 round 6; not re-opened)

- **Not `audit_logs`** — retention-GC'd, and a routing record must outlive retention.
  Also tenant-scoped one-row-one-tenant, which F2 forbids.
- **No FK to `tenant_claims`** — `ON DELETE CASCADE` would destroy the history. The
  claim is stored as a string.
- **No FK to `tenants`, and no `tenant_id` column** — a row naming two tenants cannot
  be attributed to one. The table is therefore outside the
  `scripts/rls-cross-tenant-tables.manifest` contract *by construction*: that
  contract's discovery predicate is "has a `tenant_id` column" / "has a
  `<table>_tenant_isolation` policy" (`scripts/rls-cross-tenant-verify.sql` check 5),
  and this table has neither. **The migration must say so in words** — unstated, the
  absence reads as an oversight, and the four-way count check
  (`grep -cE '@map\("tenant_id"\)'` = 56) stays 56.

### Two layers, and what each covers

`#745` is the precedent: a `GRANT`-only control was silently undone on every
convergence run of `bootstrap-rds-roles.mjs`, and the descriptive manifest had been
regenerated against the broken state, so the audit reported OK.

1. **Privilege layer** — `REVOKE ALL` then `GRANT INSERT` for `passwd_app`, and the
   table registered in `scripts/checks/app-role-denied-privileges.json` for **all
   three** non-owner roles so a table-blind convergence `GRANT` cannot re-open it (C2).
   This is an `enforceable boundary` and **it is the bound**: `passwd_app` is the role
   an application compromise reaches.
2. **Trigger layer** — `BEFORE INSERT`, `BEFORE UPDATE OR DELETE` and `BEFORE
   TRUNCATE`, all `ENABLE ALWAYS`. It covers the roles the privilege layer does not —
   the owner, and a superuser in dev — but **only against accident and against a
   caller who does not set out to defeat it.** The owner can `DROP TRIGGER`, or set
   the escape GUC by hand and issue a statement. Defeating this table requires **DDL,
   or `DELETE` on the table**; `passwd_app` has neither, and that is the privilege
   layer's doing, not the trigger's.

The `BEFORE INSERT` trigger carries a third obligation: **it assigns the principal
columns, discarding whatever the caller supplied.** F4's "the writer cannot choose it"
is only true if the writer cannot choose it; a column DEFAULT is overridable by any
INSERT that names the column. All trigger functions are `SECURITY INVOKER` (stated
explicitly in the DDL) — written `SECURITY DEFINER`, `current_user` would become the
owner's name and I2 would be silently vacuous.

### The escape hatch (VE2)

A bare custom GUC cannot be the answer: an unregistered two-part GUC is a
`PGC_USERSET` placeholder any role may set (`src/lib/tenant-rls.ts` has NOSUPERUSER
`passwd_app` setting `app.bypass_rls` on every request), so it leaves no trace and
bounds nothing.

The escape is a **bounded, tenant-scoped purge routine**, the only *sanctioned*
producer of the GUC the trigger reads. What that buys: a deletion predicate fixed by
the routine rather than by whoever typed the statement, one greppable call site, and
an escape that is not an ambient condition an unrelated statement can find itself
inside. What it does **not** buy is a bound — any role holding `DELETE` can set the
GUC by hand — which is why C1 lists it among the owner's bypasses.

The GUC is scoped by a **function-level `SET` clause**, not `set_config(…, true)` in
the body: `SET LOCAL` inside a plpgsql body persists to the end of the *caller's*
transaction, so calling the routine from `deleteTestData` — ~25 statements in one
transaction — would disarm the trigger for everything after it. A function-level `SET`
is saved and restored around the call, including on error.

**`SECURITY INVOKER`, not `DEFINER`.**
`prisma/migrations/20260725140000_revoke_definer_execute_from_public/migration.sql`
already put the unscoped `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM
PUBLIC` in force, and `bootstrap-rds-roles.mjs` issues no function grants at all — so
a new routine is owner-only from birth with no #745-shaped convergence hole, and the
mechanism is self-aligning across environments because the ADP and this migration run
as the same role in one `migrate deploy` stream. Under those conditions `DEFINER`
would *add* risk: a future `GRANT EXECUTE` would hand deletion to a role that
deliberately holds no `DELETE`.

### Where the write lives

One producer module, used by both `src/` and `scripts/` (RT9; the CLI already imports
from `src/`, D-13). It issues a raw parameterised `INSERT`. A Prisma `create()` is
impossible — it emits `INSERT … RETURNING`, and `RETURNING` requires `SELECT` on the
returned columns, which `passwd_app` deliberately lacks, so it would fail at run time
on the sign-in path and pass every mocked test. `createMany()` would be
privilege-compatible; it is excluded by the one-producer rule, not by privilege, and
C3's forbidden pattern covers both.

---

## Contracts

### C1 — `TenantClaimEvent` table, triggers, grants, purge routine

**Obligations**

- New table `tenant_claim_events`, one migration file, inside the repo's standard
  `BEGIN; … COMMIT;` wrapper; no `DROP` of any object type.
- Columns: id; `claim`; `operation`; `old_tenant_id` / `new_tenant_id`;
  `old_revoked_at` / `new_revoked_at`; `actor_label`; `db_user`; `session_db_user`;
  `client_addr` (**nullable** — `inet_client_addr()` is NULL over a Unix-domain
  socket, an ordinary way to run the CLI on the database host, and C4's write is
  fail-closed, so `NOT NULL` would deny first-ever sign-ins on a socket-connected
  deployment that no TCP-based test can reach); `created_at`. Indexed on `claim` and
  `created_at`.
- **Population rule, per operation** — locked because the VE2 cleanup predicate and
  C6's `--tenant` selector both read these columns:

  | operation | `old_tenant_id` | `new_tenant_id` | `old_revoked_at` | `new_revoked_at` |
  |---|---|---|---|---|
  | register | NULL | owner | NULL | NULL |
  | revoke | owner | owner | NULL | the timestamp written |
  | un-revoke | owner | owner | the prior value | NULL |
  | reassign | losing | gaining | the prior value (may be non-NULL) | NULL |

  plus `CHECK (old_tenant_id IS NOT NULL OR new_tenant_id IS NOT NULL)` (**I5**), so a
  row no cleanup predicate and no `history --tenant` query can reach is
  unrepresentable rather than merely undesired.
- `operation` is constrained by a `CHECK` over the four values C3's const-object
  declares. Deliberately **not** a Prisma/Postgres enum: SC8 of the predecessor plan
  already priced that (`ALTER TYPE` + `AUDIT_ACTION_VALUES` + group arrays + two i18n
  files) and none of it buys anything here.
- `claim` carries the same printable-ASCII predicate `tenant_claims` uses, **pinned to
  `storableClaimSchema`'s predicate, never stricter** — a CHECK the sign-in writer's
  value fails would deny the sign-in, so a divergence is an outage, not a rejected row.
  `db_user` / `session_db_user` are bounded at **≥ 63** (`NAMEDATALEN - 1`): a shorter
  bound turns a long role name into a denial of every first-ever sign-in.
  `actor_label` gets a length bound but **no CHECK** — it is adjudicated at the CLI by
  C4's shared validator, and a CHECK duplicating that predicate would be a second
  adjudicator of one question (R48).
- `created_at` uses `clock_timestamp()`, not `now()`: D-14 runs the confirmation
  prompt *inside* the transaction, so transaction-start time records when the operator
  began reading a deliberately long warning.
- `BEFORE INSERT` trigger assigns `db_user`, `session_db_user` and `client_addr`
  unconditionally, discarding supplied values; no DDL `DEFAULT` on those columns.
- `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) triggers raise.
  `TRUNCATE` is a separate trigger event and a row-level `BEFORE DELETE` does not fire
  on it, so without the second trigger the single statement that destroys the entire
  history is the one the control cannot see.
- **All three triggers are `ENABLE ALWAYS`.** A default `tgenabled = 'O'` trigger does
  not fire under `session_replication_role = 'replica'`, which this repo already sets
  in a migration (`20260321100000_unify_all_ids_to_uuid`). On the INSERT trigger the
  consequence is the strongest of the three: with it silent, an INSERT naming
  `db_user` stores the supplied value, so I2 goes **forgeable**, not merely NULL.
- **Purge routine**: tenant-scoped, `SECURITY INVOKER`, carrying a **function-level
  `SET`** of the escape GUC, deleting exactly the rows whose `old_tenant_id` or
  `new_tenant_id` is the argument. **It deletes a `reassign` row from the counterpart
  tenant's history too** — one row names two tenants by F2, so any deletion path
  deletes it for both. The alternative (delete only when both named tenants are in
  scope) leaves such a row unreachable by any single-tenant purge and therefore
  permanently un-cleanable, defeating VE2 with the mechanism built for it. This is why
  F3 is scoped to `DELETE FROM tenants`, and C7's runbook states the blast radius.
- `REVOKE ALL … FROM passwd_app; GRANT INSERT …` — the default ACL
  (`DEFAULTACL:passwd_user public r passwd_app=arwd/passwd_user`) pre-grants `arwd`,
  so the REVOKE is load-bearing. No grants for `passwd_outbox_worker` or
  `passwd_retention_gc_worker`.
- No `ENABLE ROW LEVEL SECURITY`. With no `tenant_id` there is no isolation predicate
  to write, and `FORCE` with no policy denies the INSERT the sign-in path needs.
  Containment is the revoked `SELECT`. **State this in the migration** alongside the
  manifest exemption.

**Control class** — per layer, because they differ:

- privilege layer: `enforceable boundary`. Authority: the table ACL, held by C2's two
  consumers.
- trigger layer: `fail-closed verification gate` against every role that does not own
  the table, degrading to `best-effort tripwire` against the owner, whose known
  bypasses are enumerated: **the purge routine**, **setting the escape GUC by hand and
  issuing a statement**, `DROP TRIGGER`, `ALTER TABLE … DISABLE TRIGGER`, `DROP TABLE`.
  `TRUNCATE` and `session_replication_role` are **closed**, not enumerated bypasses.
  Every entry requires `DELETE` on the table or DDL. The recovery path against a
  hostile owner is the Postgres audit log and the deployment's credential controls.

**Invariants**

- **I1 (schema-enforced)** — a row cannot be modified or deleted while the escape GUC
  is unset. Authority: the two raise-triggers, `ENABLE ALWAYS`.
- **I2 (schema-enforced)** — `db_user` / `session_db_user` are the executing
  principals, not caller input. Authority: the INSERT trigger, `SECURITY INVOKER`,
  `ENABLE ALWAYS`.
- **I3 (schema-enforced)** — `passwd_app` holds `INSERT` and nothing else. Authority:
  the table ACL, held by C2.
- **I4 (schema-enforced)** — history outlives the claim row and both tenants.
  Authority: the *absence* of FKs, which is why the forbidden pattern below exists.
- **I5 (schema-enforced)** — every row names at least one tenant. Authority: the
  `CHECK` above. This is what makes the VE2 cleanup predicate total.

**Forbidden patterns** — runner: C5's gate, reading the migration file (a
forbidden pattern with no runner is the shape D-13 recorded one PR ago).

- `pattern: REFERENCES\s+"?tenant` — reason: any FK re-arms the cascade this table
  exists to escape.
- `pattern: app\.bypass_rls` — reason: the escape must not be the GUC every
  `withBypassRls` call already sets.
- `pattern: SECURITY DEFINER` — reason: on the trigger functions it makes I2 vacuous;
  on the purge routine it opens a grantable deletion capability the privilege layer
  deliberately withholds.

**Acceptance criteria** (real Postgres — `src/__tests__/db-integration/`)

- Refused `UPDATE` and refused `DELETE` as the owner: assert the SQLSTATE **and**
  re-read the row, asserting every column unchanged / still present. "It raised" is a
  verdict; an `UPDATE … WHERE <wrong id>` also raises nothing and changes nothing (RT8).
- `TRUNCATE` as the owner raises.
- **The GUC does not leak into the rest of the caller's transaction** — after the
  routine returns, a bare `DELETE` issued **in the same transaction** still raises and
  its target row is still present. This is what the function-level `SET` exists for,
  and a leaking implementation passes the next-transaction form.
- The purge routine deletes the rows it names and no others. **With a pre-purge lower
  bound** (RT4): the row **is** returned for `--tenant <side A>` and for
  `--tenant <side B>` *before* the purge; then purge one side; then both negatives;
  and an unrelated per-run row survives. Without the pre-purge assertion the negatives
  are satisfied by a routine that deleted nothing and by a selector that matches
  nothing. This case lives with C6's other `history` cases (below), not in C1's file.
- `tgenabled = 'A'` asserted from `pg_trigger` for **all three** triggers — not mere
  existence, which is what a `session_replication_role` regression leaves intact.
- As `passwd_app`: `INSERT` succeeds; `SELECT`, `UPDATE`, `DELETE` are refused with
  SQLSTATE **`42501`**, read positionally through the harness's existing helper — a
  loose throw assertion greens on `42P01` (table absent), the one state in which the
  control genuinely does not exist. The case first asserts its own precondition
  (`has_table_privilege('passwd_app', …, 'SELECT') = false`), or VE4's grant ordering
  makes it green for the wrong reason in one environment.
- I2's mutation proof: an INSERT naming `db_user` explicitly, with a value that is no
  live role name, stores the trigger's value — asserted against `SELECT current_user`
  read on the **same connection**, never a literal (VE5).
- **F3's cases delete the tenant row directly (`DELETE FROM tenants`), never through
  `ctx.deleteTestData`** — cleanup now purges the events first, so routing F3's
  red-proof through the harness helper would assert the negation of F3. Deleting the
  claim row leaves the events; deleting **one** of the two tenants a reassign row
  names leaves the row still naming the other. Ordering within a file matters under
  VE1: `deleteTestData(A)` on a reassign A→B removes a row B's later assertions expect.
- **Red-proof (NF3)** — against a **throwaway table**, never by dropping or disabling
  the trigger on the real table (under VE1 that is a durable disarm invisible to every
  other working copy). Three clauses decide whether it proves anything:
  - the throwaway DDL is **extracted from the migration file** with a declared
    object-name substitution and a guarded extraction (`toBeDefined()` before use).
    Hand-writing the trigger body proves a *test-authored* trigger raises — an RT9 twin;
  - objects carry a per-run name and are dropped in a `finally`, or the transaction is
    explicitly rolled back: a Prisma `$transaction` **commits** on success, so "in the
    test's own transaction" is not by itself a lifetime bound;
  - the throwaway proof is cited **only paired** with the real table's `tgenabled` and
    refusal assertions. Alone it shows the DDL *can* raise and says nothing about the
    shipped table.
- `npm run db:migrate` on the real dev DB (**with explicit user confirmation at the
  time**), then `check-migration-drift.mjs`, `check-destructive-migration.mjs`,
  `check-migration-transaction.mjs` pass.

---

### C2 — Register the table in the denied-privileges policy

**Obligation**: add entries to `scripts/checks/app-role-denied-privileges.json`
denying `SELECT, UPDATE, DELETE, TRUNCATE` on `public.tenant_claim_events` to
`passwd_app`, `passwd_outbox_worker` **and** `passwd_retention_gc_worker` — all three
are in `AUDITED_ROLES`, so all three entries are live. "This table should be
retention-GC'd" is the most predictable future change against a table whose whole
purpose is not being retention-GC'd, and it would arrive as a grant plus a manifest
regeneration, both of which the descriptive manifest alone would launder. Each
`reason` names what re-granting would cost. Regenerate
`scripts/checks/db-grants-manifest.json` and review the diff.

**No CI step is added.** The auditor has two halves with different environment
sensitivity. The **prescriptive** half (`DENIED_PRIVILEGE_HELD`, driven by this
policy file) is environment-independent and **is already enforced in CI** — by
`bootstrap-rds-roles.mjs --denied-only` re-applying the REVOKEs and by the derived
integration test below asserting the result. The **descriptive** manifest diff is
database-specific: the committed manifest hardcodes `passwd_sso` and `passwd_user`,
while `ci-integration.yml` runs `passwd_test` owned by `postgres` and never creates
`passwd_user`, so a CI run of it fails on ten unrelated keys. Making it portable means
normalising the owner- and database-scoped key families in a shared control read by
the Dockerfile and `infra/terraform/ecs.tf` — its own piece of work, not a rider on a
claim-history PR.

**Control class**: `enforceable boundary` (the bootstrap re-applies the REVOKE after
its blanket grant) composed with a `fail-closed verification gate`
(`audit-db-grants.mjs` fails on `DENIED_PRIVILEGE_HELD` /
`DENIED_PRIVILEGE_IN_MANIFEST`). Both consumers are required. **Scope of the claim**:
those two consumers cover `bootstrap-rds-roles.mjs` and the integration job. Two
further post-migration blanket-grant sites in `app-ci` (`scripts/rls-smoke-seed.sql`,
`scripts/rls-cross-tenant-seed.sql`) apply no policy; they are pre-existing, already
re-open `audit_logs`/`audit_chain_anchors` there, and are out of this diff (see the
review's Anti-Deferral entry). This contract does not claim them.

**Acceptance criteria**

- The entries' liveness needs **no new test**:
  `src/__tests__/db-integration/app-role-denied-privileges.integration.test.ts`
  derives its cases from the policy file and asserts `has_table_privilege` false live.
  Assert **containment, not a count**: for each of the three role names and each of
  the four privilege names — both taken from named lists, not literals — the triple
  `(role, "public.tenant_claim_events", priv)` is a member of the derived case set. A
  count reds on a policy *tightening* (adding `REFERENCES`) and greens on a net-zero
  weakening (swapping `SELECT` for `REFERENCES`), while containment does neither and
  still collapses to zero matches on the misspelled-table case.
- Those assertions are non-vacuous *because* `ci-integration.yml` re-grants
  `ON ALL TABLES` after `migrate deploy` and the `--denied-only` step re-applies the
  revoke. Recorded so a future reader does not "simplify" the workflow and silently
  make them tautological.
- `node scripts/audit-db-grants.mjs` reports no drift after regeneration, run locally
  against the dev database — the environment the manifest describes.
- Manifest delta reviewed as a **shape**: the only `TABLE:passwd_app` line for this
  table is `INSERT`, and there are no lines for either worker role.
- **The expected `FUNCTION:` delta is zero.** The three new routines (INSERT-trigger
  function, raise function shared by the two raise-triggers, purge routine) are
  created after `20260725140000`'s default-ACL revoke, so they are owner-only from
  birth and the owner is not in `AUDITED_ROLES`. A `FUNCTION:` line appearing means
  that revoke did not apply to this migration's grantor — a finding to investigate,
  not a line to approve.

---

### C3 — `recordTenantClaimEvent`: one producer

**Obligation**: a new module under `src/lib/tenant/` exporting

- `TENANT_CLAIM_EVENT_OPERATION` — a const-object with the four operations plus its
  derived literal union (a bare TS union of three-plus literals is not acceptable
  here; D-17 recorded this exact miss one PR ago). **The four values are not a
  partition of outcomes**: `add --from` against a revoked row is simultaneously a
  reassignment and an un-revoke, and is recorded as `reassign`. `operation` names the
  primary verb; revocation-state questions are answered from
  `old_revoked_at`/`new_revoked_at`, never by filtering `operation`. C6's output and
  C7's runbook say so.
- one async writer taking the transaction client and the before/after state, issuing
  the raw parameterised `INSERT`, returning nothing.

**On the transaction client**: `Prisma.TransactionClient` is
`Omit<PrismaClient, ITXClientDenyList>`, so a `PrismaClient` satisfies it structurally
and the signature adjudicates nothing. What holds the in-transaction requirement is
that every production caller passes a `tx`, plus C5's gate.

**Control class**: `detection or audit only` — the writer is a plain function. The
enforcement is C1's DDL and C5's gate.

**Forbidden patterns** — runner: C5's gate (predicate 3).

- `pattern: RETURNING` in the producer module — reason: `passwd_app` has no `SELECT`,
  so a returning INSERT fails at run time on the sign-in path only, and passes every
  mocked test.
- `pattern: tenantClaimEvent\.(create|createMany|update|updateMany|upsert|delete|deleteMany)`
  anywhere under `src/` or `scripts/` outside the producer module — reason: one
  producer. **Write verbs only**, aligned with C4's enumeration of the Prisma write
  surface. **Reads are permitted**: C6 requires `history` to read the table from
  `scripts/tenant-domain.ts`, so a verb-blind form would ban the plan's own required
  read path and be repaired by loosening — and the loosening that admits `findMany` is
  the one that can readmit a write.

**Acceptance criteria**

- **The const-object ↔ CHECK drift guard adjudicates the live catalogue**, not the
  migration file (R48): read `pg_get_constraintdef` and assert set equality in **both**
  directions against `Object.values(TENANT_CLAIM_EVENT_OPERATION)`, plus a non-empty
  assertion on the extracted set so a failed parse cannot green. A migration file is
  immutable once applied; the live constraint is what the database enforces. A
  file-text form may stay as a unit-level pre-filter, and if it does it copies D-7's
  shape — `toBeDefined()` on **both** extractions before comparing.
- Red-proved by adding a member to the const-object on a scratch copy.
- A `scripts/checks/raw-sql-usage.txt` entry with a ≥10-character purpose; no
  identifier is interpolated, so `ident-markers=0`.

---

### C4 — Every writer emits an event (R42)

**Defining primitive**, from which the member set is derived — *not* a symbol grep:
**any statement that writes `tenant_claims`.** Three spellings, and the third is the
one a `tenantClaim.create` grep does not return:

1. `tenantClaim.<create|update|updateMany|upsert|delete|deleteMany>`
2. a nested relation write — `claims: { create: … }` inside `tenant.create(…)`
3. raw SQL naming the table

**Member set** (derived 2026-07-31; Phase 2 re-derives rather than inherits it):

| Site | Spelling | Operation | Actor label |
|---|---|---|---|
| `scripts/tenant-domain.ts` `cmdAdd` reassign arm | 1 | reassign | `--by` |
| `scripts/tenant-domain.ts` `cmdAdd` un-revoke arm | 1 | un-revoke | `--by` |
| `scripts/tenant-domain.ts` `cmdAdd` create arm | 1 | register | `--by` |
| `scripts/tenant-domain.ts` `cmdRemove` | 1 | revoke | `--by` (**new, required**) |
| `src/lib/tenant/tenant-management.ts` first create | **2** | register | `signin` |
| `src/lib/tenant/tenant-management.ts` slug-retry create | **2** | register | `signin` |

**Recorded negatives** — writers that deliberately emit nothing:

- the migration backfill `INSERT` and its twin `scripts/lib/tenant-claim-backfill.sql`:
  rows predating the registry, no prior state to record; the migration is the record.
- `scripts/rls-cross-tenant-seed.sql`: CI fixture rows.
- ~36 writers across the test trees.

**CLOSED, not deferred (20260731170000, external review finding 2).** The
`tenants → tenant_claims ON DELETE CASCADE` path was recorded here as a known hole
through revision 4: deleting a tenant changes what its claims resolve to and left no
event, and closing it was believed to need writing from a trigger on `tenant_claims`
that would read the actor label from an ambient GUC — the shape the escape-hatch
decision (see "The escape hatch (VE2)" above) rejected for the purge routine. **That
belief did not survive contact with the actual write**: the trigger does not need an
actor identity at all. `actor_label = 'cascade'` is a fixed string naming the
*mechanism*, exactly as `SIGNIN_ACTOR_LABEL = 'signin'` already names the sign-in
auto-registration path rather than claiming to know who triggered it — no GUC, ambient
or otherwise, is read. A `BEFORE DELETE` trigger on `tenant_claims` now appends one
`deregister` event per cascaded row, `old_tenant_id` = the deleted tenant,
`new_tenant_id` = NULL, carrying the row's own `revoked_at` into `old_revoked_at`. See
the migration for the full population rule and the deviation log for the round this
correction was made in.

**Obligations**

- **`cmdRemove` gains a required `--by`.** Without it the revoke event's label is a
  constant and `db_user` is the shared privileged role, so a revocation names nobody —
  and revoke/un-revoke is the pair this issue exists for. It is a **guard**, not just a
  flag. Complete artifact set:
  - the non-empty + unsafe-character rejection `cmdAdd` applies to `--by` is extracted
    into **one shared validator called by both verbs** (a second copy is RT9 twin
    drift), gaining the **length** check C1 delegates to it. The repo's standard for
    this input is *reject at ingest, never escape on the way in*: what is stored stays
    what was typed. Without it a bidi-override `--by` becomes the permanent
    attribution for a revocation, in a row I1 makes uncorrectable by anything short of
    the purge routine — which would delete the tenant's entire history to fix one label.
  - **the extraction includes the rejection message**, reworded verb-agnostically.
    `cmdAdd`'s current wording ("stored as the registration's attribution and read
    back by `list`") is false for `remove`, where nothing is registered and `list`
    does not display it. Carrying a verb-specific message to a second caller is how
    the third instance of this PR's own "accurate when written, falsified by this PR"
    class ships inside the fix for the second.
  - the validation runs **before the database client is constructed** — `cmdAdd`'s
    existing position. "Before the CAS write" is too weak: a validator anywhere inside
    the `withBypassRls` callback satisfies it while producing exactly the
    mid-transaction, post-prompt refusal C1 rejects when it declines the column CHECK.
  - the CLI dispatcher's `case "remove"` gains the same missing-flag → `printUsage()`
    → exit 1 arm `add` has. `--by` is already in the flag parser's value-flag hints,
    so `parseFlags` and the duplicate-flag guard need no change (verified) — today
    `remove --by X` parses and is silently ignored.
  - the **nine existing `cmdRemove` call sites** in
    `src/__tests__/db-integration/tenant-claim-cli.integration.test.ts` are updated.
  - C6 and C7 own `--help`, the module-header usage block, both READMEs and
    `CLAUDE.md`.
- Each site appends exactly one event, inside the transaction that performs the
  mutation, after the mutation.
- The two `tenant-management.ts` sites: the write goes **after `RELEASE SAVEPOINT`**,
  keyed on the surviving tenant id. Only one `create` ever survives, so this placement
  cannot double-emit and cannot leave an event for a rolled-back tenant.
- **The sign-in path's event failing aborts the sign-in.** Intended (fail-closed,
  in-tx), and an availability cost: a broken `tenant_claim_events` table denies
  first-ever sign-ins rather than silently losing evidence. Tested on both sides.
- `cmdRemove`'s idempotent "already revoked" early return writes **no** event —
  nothing changed. Same for a `count === 0` CAS refusal.

**Control class**: `fail-closed verification gate` at the transaction boundary — the
mutation and its record commit together or not at all.

**Acceptance criteria**

- One integration case per member-set row, asserting the row's contents against C1's
  population table — `old_tenant_id`, `new_tenant_id`, both `revoked_at` values,
  `actor_label`, and `db_user` compared to `SELECT current_user` on the same
  connection (VE5), never a literal.
- Reassign and un-revoke each produce **one** row carrying both sides (F2), and
  `add --from` against a **revoked** row produces one `reassign` row with
  `old_revoked_at` non-NULL and `new_revoked_at` NULL.
- **Atomicity, both directions, with the abort mechanism specified**: the failure is
  injected by a statement that aborts the transaction *after* both writes have been
  issued — not by a JS throw placed earlier, which makes "neither row" trivially true
  and says nothing about whether the event was in the transaction. Paired with a
  happy-path run of the same code asserting **both** rows present.
- **The slug-collision retry needs an RT4 lower bound**: assert the retry arm actually
  ran — the surviving tenant's slug carries the random-hex suffix — *before* asserting
  exactly one event. Otherwise `count === 1` passes on the happy path, which never
  enters the retry.
- **NF1's negative**: a sign-in resolving an already-registered claim leaves the event
  count for that claim unchanged.
- **`remove --by`, both halves of the guard** (RT8/RT10): allow side — `remove --by ops`
  succeeds and the event's `actor_label` is `ops`; deny side — `remove` with `--by`
  absent, and again with an unsafe-character `--by`, is refused **and the claim row is
  unchanged** (`revokedAt` still NULL). The mutation, not the verdict.
- **C4's fail-closed direction** (RT10 deny side), specified precisely because the
  obvious forms are both vacuous:
  - revoking `INSERT` from the *connecting* role proves nothing — that role is
    SUPERUSER in both environments (VE3/VE5) and bypasses ACL checks, so the case
    silently inverts into a green test of the allow path;
  - a **freshly created role holds nothing**, so it fails at the first missing
    privilege — before the events INSERT is ever reached — and "the sign-in fails and
    no tenant row survives" is then satisfied 100% of the time for a reason unrelated
    to this table. `CONNECT` is revoked from `PUBLIC`, `CREATE ON SCHEMA public` is
    revoked in both environments, and the writer path needs `SELECT`/`INSERT` on
    `tenants` and `tenant_claims` before it gets anywhere near the event.

  The case therefore creates a **per-run `NOSUPERUSER NOBYPASSRLS` LOGIN role** with
  its own pool and client (`TestRole` is a closed union, so this legitimately bypasses
  `createPrismaForRole`), granted `passwd_app`'s prerequisite privileges, and runs
  **two arms on the same role**: with `INSERT` on `tenant_claim_events` **granted**,
  the call succeeds and both rows are present; then revoked, the call fails with
  `42501` **naming `tenant_claim_events`** and no tenant row survives. The allow arm
  is what makes the grant set self-proving — it reds if any prerequisite is missing —
  and it is the RT10 allow side the criterion needs anyway. Teardown follows the
  `bootstrap_probe_app` precedent's `dropProbeRoles`: `REVOKE ALL ON DATABASE` →
  `DROP OWNED BY` → `DROP ROLE`, plus `pool.end()`, all in one `finally`; a role
  holding grants cannot be dropped, and a leaked pool keeps the forked integration
  worker alive. Per-run name, not the precedent's fixed one (VE1).
- A CAS refusal and the already-revoked early return produce no event.
- Any test reaching `findOrCreateTenantForClaim` calls `ctx.trackTenant(id)` as soon
  as the id is known: the tenant is created by production code the harness never saw,
  and a leaked tenant now drags an undeletable event row with it.

---

### C5 — Completeness gate

**Obligation**: a gate that fails when a member of C4's defining primitive has no
event write. AST-first — a grep over a line window cannot see spelling 2 at all and
cannot tell a mutation from a read. It runs without a Program
(`scripts/checks/lib/ast-project.mjs`), and its scan roots include **`scripts/`** from
the start (four of the six members live there, and
`check-critical-audit-atomic.mjs`'s `SEARCH_DIRS` would see none of them),
parameterised via an env override as its siblings are.

**Three predicates**

1. **Per-`(function, operation)` set equality** — for each enclosing function, the set
   of operations named by its producer calls equals the set its member-set writers can
   produce, derived from C4's table. Two shapes force this and a weaker form fails one
   of them:
   - `cmdAdd`'s three writers share **one** `withBypassRls` callback, so a
     tree-wide *existence* check ("every operation appears somewhere") is blind: with
     its create arm unemitted, `register` still appears — via `tenant-management.ts` —
     and the gate greens. Set equality is per-function, so it fails.
   - `findOrCreateTenantForClaim` has **two** writer statements (the create and its
     `catch`-clause retry) and C4 mandates **one** producer call, so a *count*
     predicate reds on compliant source. Both writers produce `{register}` and the one
     producer call names `register`, so set equality passes.

   Stated as the requirement rather than the implementation: **mutually exclusive
   alternatives of one logical write must not be counted twice.** An admissible
   implementation is to derive the operation each writer can produce from C4's table;
   another is to exclude writers whose nearest enclosing node is a `CatchClause`
   (`cmdAdd`'s arms are `if/else if/else` siblings, the retry is inside `catch`).
   Phase 2 picks one in minutes; both must satisfy the two shapes above.
2. **Function-scoped presence** — a function containing a member-set writer contains a
   producer call. Subsumed by (1); kept because it produces the useful error message
   and still fires when the operation cannot be determined.
3. **Single-producer** — a `tenantClaimEvent` **write**-verb delegate call outside the
   producer module, or a `RETURNING` inside it, is a failure. C3's forbidden patterns
   are this predicate.

**Fail-closed on an empty input** — the shared walker treats a missing directory as
empty by design ("Missing directories yield an empty list (never throws)"), and all
three predicates are violation-detecting, so zero files scanned means zero violations
means exit 0. `check-critical-audit-atomic.mjs` survives that only incidentally,
because its predicate requires each action to be *seen*. The gate therefore asserts a
non-zero **analysed-file count** and a non-zero **member-set writer count** before
printing OK, exiting non-zero with a distinct code otherwise, and adopts
`check-gate-selftest-coverage.sh`'s `sec-F6` guard against an override leaking into a
real CI run.

**Both derived identifiers are pinned, not spelled** (R47). Without a Program the gate
matches identifiers, not resolved symbols, and there are two:

- the nested-relation field name (`claims:`) — read from `prisma/schema.prisma`, or
  pinned against it by an assertion. A schema rename otherwise retires the gate on
  real source while the fixture, hardcoding the old spelling, stays green.
- **the operation member set**, which predicate (1) consumes — read from C3's
  const-object, or asserted equal to it. `check-critical-audit-atomic.mjs` is the right
  shape for the predicate and the **wrong precedent for this half**: it hardcodes its
  action set, and copying that leaves a fifth operation uncovered while every fixture
  stays green.

**Both derived inputs resolve from the repo root regardless of the scan-root
override**, so the self-test exercises the real derivation against fixture sources
rather than against fake copies shipped in the fixture tree. An absent or unparseable
schema / const-object is a **distinct non-zero exit**, never a fallback to a hardcoded
spelling — that fallback is the regression the pinning exists to prevent, and absence
is the walker's default behaviour in this codebase.

**Control class**: `fail-closed verification gate`. Adjudication authority is the
ts-morph AST plus the Prisma schema and the const-object for the derived identifiers.
**Enumerated non-members**: a writer reached through an aliased delegate
(`const d = tx.tenantClaim`); raw SQL assembled at run time; `.sql` files, which the
gate does not read; the test trees, excluded by `ast-project.mjs`'s `walkSourceFiles`,
which skips `__tests__` directories and `*.test.ts(x)` (**not**
`check-raw-sql-usage.mjs`'s `EXCLUDE_RE`, which is a different set — equivalent here,
but citing the wrong mechanism is how a later contributor "aligns" the two in the
wrong direction); and the cascade path (C4) — CLOSED as of 20260731170000, but by a
database trigger, not by TS this gate's AST predicates walk, so it stays a non-member
of what THIS gate proves even though the system as a whole no longer has the gap.

**Acceptance criteria**

- Self-test at `scripts/__tests__/<gate-base>.test.mjs` — required, not optional:
  `check-gate-selftest-coverage.sh` hard-fails a new `scripts/checks/*.mjs` without a
  sibling there.
- Committed fixtures, each red-proved:
  - spelling 1 with no event → fails.
  - **spelling 2 with no event → fails.** The case the gate exists for, and the one a
    grep implementation passes green.
  - **two mutation arms of different operations, one event, in one function → fails.**
  - **a two-file case: file A emits operation X compliantly, file B writes X with no
    event → fails.** A single-file fixture cannot express this — in an isolated tree
    the unemitted operation appears nowhere else, so even a tree-wide existence
    predicate reds, which is how a blind predicate came to be certified by a green
    self-test. Listed as a shape (two files), not as another example.
  - a producer call whose operation literal is not a const-object member → fails.
  - a direct `tenantClaimEvent` **write**-verb delegate call outside the producer → fails.
  - the scan root pointed at an **empty directory** → fails. The case that red-proves
    the fail-closed guard itself.
  - **allow side (RT10)**: a compliant spelling-2 writer *with* an event → passes; a
    `try`/`catch` retry pair with **one** event → passes (the shape production
    mandates, pinned apart from the deny fixture above); and a `tenantClaimEvent`
    **read** outside the producer module → passes, so C6's `history` needs no
    exemption.
- The gate names the offending file and site.
- Registered in `scripts/pre-pr.sh` alongside its siblings; it then runs in CI via
  `ci.yml`'s `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` step with no workflow edit,
  and `ci.yml`'s `app` paths filter already covers `scripts/**`.

---

### C6 — Operator read path, and the CLI text that is now false

**Obligation**

- `tenant-domain history --domain <claim> | --tenant <uuid>` prints the rows in
  chronological order, through the existing display-escaping used by `list`.
  **`--tenant` takes a bare UUID and matches `old_tenant_id`/`new_tenant_id` directly,
  without resolving through `tenants`**: every arm of `resolveTenantRef` reads a live
  row, and all are dead in the case F3 and scenario 3 exist for — a tenant deleted
  after a claim was moved off it. A non-UUID ref may still fall back to
  `resolveTenantRef`.
- Output states, for a `reassign` row, both tenants and both revocation values, so a
  reader is not left filtering on `operation` for a question it does not answer (C3).
- **The existing post-write output must change.** `cmdAdd` prints `NOT RECOVERABLE
  from the row after this change:` and both READMEs instruct keeping that terminal
  output with the incident record. Once this lands that is false, and a false "keep
  this, it is the only copy" prescribes the wrong remedy at incident time. Reworded at
  the CLI and in both READMEs together, with `cmdRemove`'s `--by` documented with it.
- **Two further in-file sites**: `scripts/tenant-domain.ts`'s module-header usage block
  is a *second* copy of the `remove` signature, distinct from `printUsage()`; and the
  header's `--by` contract paragraph says the flag is "deliberately not written on the
  un-revoke or reassign paths". That stays true of `createdBy` and becomes misleading
  about the flag, which now supplies `actor_label` on all four verbs. Same class as
  the `NOT RECOVERABLE` correction. (`worker-policy-manifest.json`'s subcommand list
  stays true — recorded so it is not re-derived.)

**Control class**: `detection or audit only`.

**Escaping coverage, split by what the gate reaches**:
`check-operator-echo-escaped.mjs` taints `process.argv`, an `argv`-named parameter,
and **every parameter of a `cmd*` function** — so `cmdHistory`'s own selectors *are*
covered and an unescaped interpolation of them fails the gate. What it deliberately
does not taint is a database row, so the **row-derived** fields (`claim`,
`actor_label`, `db_user`) are the uncovered half, held by the `console.log`-spy test
below and by C1's CHECK on `claim`.

**Acceptance criteria**

- The DB-dependent cases live in
  `src/__tests__/db-integration/tenant-claim-cli.integration.test.ts` — a
  `scripts/__tests__/*.test.mjs` placement lands in the **unit** suite, whose `app-ci`
  job has a dummy `DATABASE_URL`, so a `SKIP` guard does not skip and the job reds.
  Only a pure formatter test driven with in-memory rows may be a unit test. C1's
  purge-semantics case (which invokes `history`) lives here too.
- Every claim fixture carries a per-run token (`${runToken()}.${ALIAS_CLAIM}`). This
  table has no `UNIQUE(claim)` to make a collision loud, so under VE1 a concurrent run
  turns "one row" into two and the empty-state case into a populated one. **`runToken`
  moves into `src/__tests__/helpers/tenant-claim-fixtures.ts`** alongside the literals
  it prefixes — it is currently defined locally in two suites, and mandating the shape
  without shipping the helper produces a third copy (RT3).
- `history` for a claim with no events prints an explicit empty-state, not an empty list.
- `history` after a reassignment shows one row naming both tenants; after a direct
  `DELETE FROM tenants` of one of them, still shows it (F3 — not via
  `deleteTestData`, per C1).
- A `console.log` spy asserts no printed line carries a raw unsafe character when the
  stored label contains one — the assertion that catches *one missed site among
  several*, which a per-site test does not.
- `history` refuses cleanly when neither selector is given.

---

### C7 — Documentation

**Obligation**: both READMEs' *IdP domain changed / tenant locked out* runbook gains
the history query, documents `remove --by` as a **breaking** CLI change, and drops the
"printed output is the only record" instruction; `CLAUDE.md`'s admin-scripts block
gains the new subcommand and the changed `remove` signature;
`docs/archive/review/sso-tenant-domain-alias-plan.md`'s SC11 entry is marked delivered
with a pointer here — it is the document that records the deferral, and leaving it
saying "deferred" is how the next reader re-derives the same gap.
`docs/security/audit-log-schema.md` gains a short section: this table is *not*
`audit_logs`, is not retention-GC'd, is not delivered to webhooks, **retains a client
IP and two Postgres principal names indefinitely** (an explicit decision, not a side
effect), states that `operation` is not a partition, and states the purge routine's
blast radius including the counterpart side of a reassignment.

**Control class**: `detection or audit only`.

**Acceptance criteria**: `check-doc-paths.mjs` passes; no real domain or email in any
changed file; the gitleaks/secret gates pass.

---

## Gate survey

Derived from each gate's own scan roots, not from its name (D-16 is the precedent for
what a missing survey costs).

| Gate | Fires on | Delta |
|---|---|---|
| `check-migration-transaction.mjs` | the new migration (ddlCount > 1) | `BEGIN;`/`COMMIT;` wrapper |
| `check-destructive-migration.mjs` | the new migration | no `DROP` of any object type |
| `check-migration-drift.mjs` | schema vs migrations | run `db:migrate` on the real dev DB |
| `check-raw-sql-usage.mjs` (`SCAN_ROOTS = ["src","scripts"]`) | the producer module; `scripts/tenant-domain.ts` is already listed | one new `raw-sql-usage.txt` entry, `ident-markers=0` |
| `check-operator-echo-escaped.mjs` (`SCAN_ROOT = "scripts"`) | `history`'s selectors and `remove --by` | baseline is deliberately empty and fails on any rise; escape at every print site |
| `check-gate-selftest-coverage.sh` | C5's new `scripts/checks/*.mjs` | sibling `scripts/__tests__/<base>.test.mjs` |
| `check-doc-paths.mjs` | C7's runbooks | referenced paths must exist |
| `audit-db-grants.mjs` | the new table and routines | manifest regeneration, reviewed against C2's expected shape. Deploy-time only — see C2 |
| `check-test-hygiene.sh` gate (c) | any changed `.test.ts` | no `process.env.X =`; use `vi.stubEnv` |
| `check-env-docs` check 12 | any new statically-spelled env read under `src/**` — C3's module, not C6's CLI work | none expected (NF2) |

Recorded N/A after checking each one's own predicate: `check-critical-audit-atomic.mjs`
(`SEARCH_DIRS` excludes `scripts/`, action-keyed on a closed set — C5 is the
table-keyed sibling, deliberately not an overload of it),
`check-null-tenant-fail-closed.mjs`, `check-count-then-create-lock.mjs`,
`check-console-sinks.mjs`, `check-bypass-rls.mjs` (scans `src/` only),
`worker-policy-manifest.json` (`scripts/tenant-domain.ts` is already a documented
exclusion; no new worker), the RLS manifest/seed/count contract (no `tenant_id`).

---

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | table, population rule, **three** triggers, grants, purge routine | locked |
| C2 | denied-privileges for three roles + manifest regeneration (deploy-time; **no CI step**) | locked |
| C3 | `recordTenantClaimEvent` single producer + operation const-object | locked |
| C4 | six writers emit in-transaction events; `remove --by` guard | locked |
| C5 | AST completeness gate, three predicates, fail-closed on empty input | locked |
| C6 | `history` + correction of the now-false CLI/README text | locked |
| C7 | documentation | locked |

---

## Testing strategy

| Contract | Level | What proves it can fail |
|---|---|---|
| C1 | integration (real Postgres, incl. a `passwd_app` connection) | throwaway-table red-proof extracted from the migration; `42501` per refused verb with its precondition asserted; forged `db_user` overwritten; `tgenabled='A'` on all three; row-state assertions, not verdicts; the same-transaction GUC-leak case |
| C2 | derived cases in the existing denied-privileges suite | containment of this table's twelve triples; CI's post-migration blanket grant is what makes them non-vacuous |
| C3 | integration (live `pg_get_constraintdef`) + unit pre-filter | set equality both ways vs the const-object; red-proved by adding a member on a scratch copy |
| C4 | integration | per-writer row contents; abort injected after both writes, paired with the happy path; retry proven to have run before counting; NF1's zero-event case; the two-arm granted/revoked run on one throwaway role |
| C5 | gate self-test | spelling-2; two-arms-one-event; **two-file**; non-member operation; second-producer; **empty scan root**; and the allow side incl. the retry pair and a read |
| C6 | integration + one unit formatter test | empty state; both-tenants row surviving a direct tenant delete; pre-purge lower bound on the purge case; unsafe-character sweep over all printed lines |

**Mocking stance**: every assertion whose adjudication authority is Postgres —
privileges, triggers, transactional atomicity, the CHECK — runs against the real
database. A mocked `$executeRaw` proves the call was made, not that the trigger fired.

**Shared fixtures (RT3)**: `src/__tests__/helpers/tenant-claim-fixtures.ts`, always
with a per-run token prefix (VE1).

**Cleanup (VE2)**: `deleteTestData` keys on `tenant_id`, which this table lacks — it
calls C1's purge routine with the tenant id, which I5 makes total. The escape is *not*
self-testing: a zero-row `DELETE` fires no row-level trigger and almost no suite
creates events, so the routine gets its own dedicated case.

**Two preconditions, probed once in `createTestContext`** rather than discovered as a
driver error in every file's `afterEach`, and probed as **capabilities, not titles**:

- `has_function_privilege(current_user, '<purge signature>', 'EXECUTE')` — true for
  the owner **and** for a superuser that is not the owner, false for `passwd_app`. An
  ownership predicate (`relowner = current_user`) would red all ~95 integration files
  on a working configuration where `MIGRATION_DATABASE_URL` points at a superuser that
  does not own the table, and a probe in front of the whole suite is the kind that
  gets deleted rather than corrected. `has_table_privilege(current_user,
  'tenant_claim_events', 'DELETE')` covers the other half of what the routine needs.
- `to_regprocedure('<signature>') IS NULL` distinguishes "not migrated" from "not
  privileged" and must be checked **first**, so the useful message ("run
  `npm run db:migrate`") wins in the case it exists for. R-c defers the migration to
  explicit confirmation, so a checked-out-but-unmigrated window is real, and `42883`
  is not in the harness's retryable set.

Also recorded: a purge failure inside `sweepOutstandingTenants` is swallowed into a
`console.warn`, and unlike every other swept row these leave **undeletable** rows on
the shared database, so that warning is not the same class as the existing ones. The
sweep re-raises for this table, or the warn path is asserted.

---

## Considerations & constraints

### Scope contract

- **SC-A — No retention or GC for this table.** Deferred with an owner.
  **Anti-Deferral**: growth is one row per operator mutation plus one row per
  first-ever tenant creation. The second is **not** an operator action — it is
  reachable by anyone who can complete an IdP authentication, bounded by
  `withCallbackRateLimit` (60/min per client IP, `failClosedOnRedisError`,
  `boundUnknownIp`), the same control D-33 names for its own accepted residual. Each
  such row is accompanied by a `tenants` row and a `tenant_claims` row that are larger
  and equally un-GC'd, so this does not change the existing calculus. A retention
  policy on the table whose purpose is outliving retention needs its own decision.
- **SC-B — No tamper-evident chain.** `audit_logs` has HMAC chaining and anchors; this
  table has append-only DDL and nothing more. **Anti-Deferral**: with the `TRUNCATE`
  trigger and `ENABLE ALWAYS`, the remaining defeat requires **DDL, or `DELETE` on the
  table** — and `passwd_app` has neither, which is the privilege layer's doing. A hash
  chain does not stop a caller holding `DELETE` either: the same credential can
  re-anchor, which is exactly why `audit_chain_anchors` is in the denied-privileges
  policy.
- **SC-C — No dashboard surface.** Deferred; the CLI is the operator tool for a
  registry the dashboard cannot manage either.
- **SC-D — `#744` (SC10, release 2) stays blocked until this merges**, and is not
  started here. It is the issue's stated ordering constraint.
- **SC-E — No event for reads.** The `ON DELETE CASCADE` path this bullet also used to
  name is no longer a deferral — see C4's "Recorded negatives" for the closure
  (20260731170000).

### Risks

- **R-a** — the sign-in path gains a write inside the auth transaction. Bounded: one
  INSERT, only on first-ever tenant creation. C4 states the fail-closed direction and
  tests it on both sides.
- **R-b** — `passwd_app` losing `SELECT` on a table Prisma has a model for is a shape
  a future contributor will "fix" by granting it back. C2's policy entries make that a
  failing gate rather than a silent regression, and their `reason` fields are where
  the explanation has to live.
- **R-c** — VE1: the migration lands on a shared dev database. Applied only with
  explicit user confirmation at the time.
- **R-d** — `remove --by` is a breaking change to a CLI shipped one PR ago. Bounded
  (pre-1.0, operator-only, documented in both READMEs and `CLAUDE.md`), and taken
  deliberately: the alternative leaves half of the operation pair this issue exists for
  with no attribution at all.

### User operation scenarios

1. Operator reassigns a squatted claim with `add --from`, then a month later has to
   say who moved it and from where. → `history --domain`.
2. Operator revokes a claim during an incident; a second operator re-registers it an
   hour later. → two rows, both labels, both principals, both timestamps — which is
   what `remove --by` exists to make true.
3. A tenant is deleted after a claim was moved off it. → `history --tenant <uuid>`
   still returns the row, because the selector does not resolve through `tenants`.
4. An auditor asks whether the application role could have altered the record. → the
   ACL and the three triggers, both asserted in CI, the ACL re-asserted on every
   `bootstrap-rds-roles.mjs` convergence run.
