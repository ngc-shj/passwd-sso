# Durable dead letters — plan

Closes the KNOWN GAP at `src/lib/audit/audit.ts:271`, whose own comment fixes the
direction: *"the fix is to persist the dead letter durably rather than to widen
the log — alerting should not depend on log retention."*

## Project context

- **Type**: service / web app (Next.js 16 + Prisma 7 + PostgreSQL 16), with
  separate long-running worker processes.
- **Test infrastructure**: unit (vitest) + real-DB integration
  (`npm run test:integration`) + E2E (Playwright) + CI/CD, plus 76 `scripts/checks`
  static gates run by `scripts/pre-pr.sh`.
- **Verification environment constraints** — each contract's manual-test path is
  classified against these:
  - **VE1 — no Fluent Bit / SIEM in this environment.** The forwarder's behaviour
    (the `Exclude _logType ^audit-dead-letter$` filter) cannot be exercised here.
    Anything resting on "the record does/does not reach the sink" is
    `blocked-deferred`. This plan is designed so that nothing does: the whole
    point is to stop depending on the log pipeline.
  - **VE2 — the dev database is shared and live.** Destructive operations are
    forbidden. Migrations are applied forward only; no reset.
  - **VE3 — integration tests cannot share a database with the compose workers.**
    `docker compose stop audit-outbox-worker retention-gc-worker` first; the
    claims are `FOR UPDATE SKIP LOCKED` over whole tables, not tenant-scoped.
    This change adds a retention-GC registry entry, which makes the retention
    worker a *direct* competitor for the rows under test rather than an
    incidental one.
  - **VE4 — RDS role bootstrap is not runnable here.**
    `scripts/bootstrap-rds-roles.mjs` and `scripts/audit-db-grants.mjs` need a
    superuser URL against a target database. Locally they can run against the dev
    Postgres; against RDS they cannot. Grant contracts are therefore verified
    `verifiable-local` on dev Postgres and `blocked-deferred` for RDS, and the
    deferral is discharged by the prescriptive denylist (C2), which is a file the
    CI gate reads rather than a live-database assertion.

## Objective

Make the record of a lost audit event survive independently of log retention, for
the dead-letter emissions that today have no durable counterpart.

## Requirements

**Functional**

1. Every dead-letter emission with no durable counterpart also writes a row to a
   durable store.
2. The write must not change `logAuditAsync` / `logAuditBulkAsync`'s documented
   contract ("Awaitable, never throws").
3. The existing structured log line is retained, and is emitted **first**, so a
   database outage — the likeliest cause of the dead letter — cannot lose both
   records.
4. The store must not require a tenant, because the defining case is that the
   tenant did not resolve.

**Non-functional**

5. The row is bounded by the schema, not by caller convention.
6. The table is subject to the same immutability policy as the other audit
   tables, and that policy survives `bootstrap-rds-roles.mjs`'s convergent
   blanket grant.
7. The table does not grow without bound.

## The gap, as measured on `f5dacefb3`

`logAuditAsync` and `logAuditBulkAsync` resolve a tenant before enqueuing. When
resolution returns null they emit one `deadLetterLogger.warn` line and **return
without enqueuing** (`audit.ts:283`, `:368`). There is no `audit_outbox` row and
no `audit_logs` row.

Three facts, each verified in the tree rather than assumed:

1. **The shipped forwarder drops it.** `infra/fluent-bit/fluent-bit.conf:51`
   carries `Exclude _logType ^audit-dead-letter$`, deliberately.
   Reproduce: `grep -n 'audit-dead-letter' infra/fluent-bit/fluent-bit.conf`
2. **The host copy is capped.** `docker-compose.yml`'s `x-logging` anchor sets
   `max-size: "20m"` × `max-file: "5"`.
   Reproduce: `grep -n -A4 'x-logging' docker-compose.yml`
3. **The early return is structural.** `AuditOutbox.tenantId` is
   `String @db.Uuid` with `tenant Tenant @relation(..., onDelete: Restrict)`
   (`prisma/schema.prisma:1177`, `:1188`). A dead letter whose tenant did not
   resolve **cannot** be written to `audit_outbox`; the FK rejects it. The fix
   therefore needs a store that does not require a tenant, not a redirect into
   the existing one.

## Member-set derivation (R42)

The class is **not** "every `deadLetterLogger.warn` call". The defining property
is *a dead-letter emission with no durable counterpart at that point*.

Defining-primitive sweep:

```bash
grep -rn "deadLetterLogger\." src scripts --include="*.ts" \
  | grep -v "\.test\." | grep -v "__tests__"
```

→ 7 emission sites. Classified by whether a durable row exists:

| Site | Durable counterpart | In class |
|---|---|---|
| `src/lib/audit/audit.ts:283` — `tenant_not_found` (`logAuditAsync`) | none — returns before `enqueueAudit` | **yes** |
| `src/lib/audit/audit.ts:368` — `tenant_not_found` (`logAuditBulkAsync`) | none — returns before `enqueueAuditBulk` | **yes** |
| `src/lib/audit/audit.ts:292` — `logAuditAsync_failed` | none — the enqueue is what failed | **yes** |
| `src/lib/audit/audit.ts:379` — `logAuditBulkAsync_failed` | none — same | **yes** |
| `src/workers/audit-outbox-worker.ts:1400` — reaped row | the `audit_outbox` row persists at `status = FAILED` | no |
| `src/workers/audit-outbox-worker.ts:1946` — invalid userId | `recordError(workerPrisma, row, …)` persists to the row | no |
| `src/workers/audit-outbox-worker.ts:2009` — max attempts | `recordError` + row status | no |

The three worker sites are excluded by a stated property, not by omission —
`docs/operations/alerts.md:159` already records it for the sibling alert:
*"Unlike `audit-dead-letter`, the record itself is durable: the transition is
persisted."*

Indirect members checked: no raw-SQL or aliased writer emits a dead letter;
`src/lib/auth/policy/account-lockout.ts:394` is a comment referencing the
behaviour, not a call site.

## What changed since the gap was written

The record is now bounded. `deadLetterEntry` (`audit.ts:221`) emits `scope`,
`action`, `userId`, `tenantId`, `reason`, and — since #804/#805 —
`error: ErrorLogFields`, i.e. `{ name, code }`, both token-shaped. The
justification the Fluent Bit exclusion cites ("the record carries whatever the
failing caller passed, including error text") has therefore partly expired.

That does **not** make "delete the exclusion" the fix: shipping to a log pipeline
still makes alerting depend on retention, which is the property the comment
rejects. It does mean the durable row can carry the same fields with no new
redaction question.

---

## Contracts

### C1 — `audit_dead_letter` table and migration

**Schema** (`prisma/schema.prisma`):

```prisma
model AuditDeadLetter {
  id        String   @id @default(uuid(4)) @db.Uuid
  scope     String   @db.VarChar(32)
  action    String   @db.VarChar(64)
  userId    String   @map("user_id") @db.VarChar(64)
  tenantId  String?  @map("tenant_id") @db.VarChar(64)
  teamId    String?  @map("team_id") @db.VarChar(64)
  reason    String   @db.VarChar(64)
  errorName String?  @map("error_name") @db.VarChar(64)
  errorCode String?  @map("error_code") @db.VarChar(64)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([createdAt])
  @@index([reason, createdAt])
  @@map("audit_dead_letter")
}
```

**Invariants**

| # | Invariant | Enforcement |
|---|---|---|
| C1-I1 | No column exceeds its cap | **schema-enforced** (`VarChar(n)`) |
| C1-I2 | A row can be written with no resolvable tenant | **schema-enforced** (nullable, no FK, `VarChar` not `Uuid`) |
| C1-I3 | Only a bypass-RLS session can read or write | **schema-enforced** (RLS `ENABLE` + `FORCE` + bypass-only policy) |
| C1-I4 | No free-form narrative column exists | **schema-enforced** (no `metadata`/`message`/`text` column) |

Deliberate choices, each naming what the alternative silently satisfied:

- **`tenantId` is `VarChar(64)` with no FK.** A `@db.Uuid` column would reject the
  very input this table exists for (`params.tenantId` reaching here may be absent
  or non-canonical), and an FK reintroduces `audit_outbox`'s constraint — the
  thing that made the early return structural. Cost: the column no longer
  type-guarantees a UUID, so a reader must not join on it.
- **`scope` / `action` are text, not the Prisma enums.** This is the failure path.
  A row rejected for an enum mismatch is lost for the same reason the current code
  loses it. Cost: an unknown action can be stored; read-side display must tolerate
  it.
- **No `metadata` column.** `deadLetterEntry`'s docblock states the payload never
  includes raw metadata, and `check-audit-metadata-narrative.mjs` (landed on this
  branch) makes a `metadata` column here the obvious place to reintroduce
  narrative.

**RLS** — follow the only tenant-less precedent in the tree,
`system_settings` (`prisma/migrations/20260502000000_audit_anchor_publisher_phase2/migration.sql:17-21`);
it is the sole `*_bypass ON` policy today
(`grep -rn '_bypass ON' prisma/migrations/*/migration.sql`):

```sql
ALTER TABLE "audit_dead_letter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_dead_letter" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_dead_letter_bypass ON "audit_dead_letter"
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on')
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on');
```

**Control class (R49)**: `enforceable boundary`. The constrained actor is the
application role, which is `NOSUPERUSER NOBYPASSRLS`; the adjudication authority
is PostgreSQL's row-security evaluator, consulted at statement time. It is not a
gate that can be edited around in application code.

**Migration shape (R24)**: additive only — `CREATE TABLE`, indexes, RLS. No
strict constraint is applied to an existing table, so no split is required.
**R15**: no hardcoded database or role name; the policy references no environment
value, and any role grant uses the `DO $$ … EXECUTE format(…, current_database())`
form already used at `20260502000000:36-38`.

**Forbidden patterns**
- `pattern: audit_dead_letter.*REFERENCES` — reason: an FK to `tenants` reinstates the constraint that made the gap structural.
- `pattern: "metadata"` inside the `AuditDeadLetter` model — reason: C1-I4.
- `pattern: @db.Uuid` on `tenantId`/`userId` in `AuditDeadLetter` — reason: C1-I2; the sentinel actor IDs and unresolved tenants are not UUIDs.

**Acceptance criteria**
- `npm run db:migrate` applies forward on the dev database with no drift.
- Connected as `passwd_app` **without** `app.bypass_rls`, `SELECT` and `INSERT`
  on the table both return zero rows / raise, respectively.
- Connected as `passwd_app` **with** the bypass set, `INSERT` succeeds.

---

### C2 — Privilege policy for the new audit table

`audit_dead_letter` is an audit table, and this repo has a prescriptive contract
for those: `scripts/checks/app-role-denied-privileges.json`. Its `_comment`
records why absence is not enough — `bootstrap-rds-roles.mjs` runs a table-blind
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES … TO passwd_app`, and it is
documented as convergent and re-runnable, so **every convergence run re-grants
what a migration revoked**. The descriptive manifest is regenerated from the live
database, so the loss reports OK.

**Entries to add to `app-role-denied-privileges.json`**

| Role | Privileges denied on `public.audit_dead_letter` | Reason |
|---|---|---|
| `passwd_app` | `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` | The record exists because an audit event was lost; a role that can edit or truncate it can erase the evidence of its own failure. `INSERT` and `SELECT` stay granted — the writer is in-process, and the bypass-RLS policy is the read bound. |
| `passwd_outbox_worker` | all | The outbox worker drains `audit_outbox` into `audit_logs`; it has no writer here. |

**Retention role.** The GC needs `SELECT` + `DELETE`. Two options, and the plan
picks the second:

- (a) grant `passwd_retention_gc_worker` `DELETE` directly;
- (b) route the delete through a `SECURITY DEFINER` routine, mirroring
  `audit_log_purge` for `audit_logs`.

**Chosen: (a).** `audit_logs` uses a definer routine because `passwd_app` — an
internet-facing role — is denied `DELETE` there while two sanctioned mutations
still need it. `passwd_retention_gc_worker` is a background role with no request
surface, and the retention registry already drives `EXPIRY` deletes directly for
every other table. Adding a definer routine here would buy no additional bound
over a role that already holds `DELETE` on a dozen tables, and would introduce a
second purge path to keep in step. **This is a cost/complexity judgement, not a
security equivalence claim** — reviewers should challenge it if the asymmetry
with `audit_logs` matters more than the consistency with the registry.

**Control class (R49)**: `fail-closed verification gate`.
`scripts/audit-db-grants.mjs` fails when a denied privilege is held live AND when
the descriptive manifest lists one. Bypassable by editing the denylist — which is
the point of it being a reviewed file.

**Forbidden patterns**
- `pattern: GRANT .*UPDATE.*audit_dead_letter` — reason: C2 denies it.
- `pattern: passwd_retention_gc_worker.*audit_dead_letter` in `app-role-denied-privileges.json` — reason: the GC is the one role that MUST reach this table; a denial entry here would wedge retention. (Inverse-direction guard: contrast `tenant_claim_events`, where the GC is denied precisely because that table outlives retention.)

**Acceptance criteria**
- `node scripts/audit-db-grants.mjs` against dev Postgres exits 0.
- Mutation: granting `UPDATE` to `passwd_app` makes it exit non-zero naming the
  table.
- `bootstrap-rds-roles.mjs` run twice leaves the denied privileges revoked
  (convergence, not first-run).

---

### C3 — `persistDeadLetter` helper

**Signature** (`src/lib/audit/audit.ts`, module-private):

```ts
type DeadLetterRecord = ReturnType<typeof deadLetterEntry>;

async function persistDeadLetter(entry: DeadLetterRecord): Promise<void>;
```

**Invariants**

| # | Invariant | Enforcement |
|---|---|---|
| C3-I1 | Never throws, never rejects | **app-enforced** (whole body in `try`/`catch`) |
| C3-I2 | Called only AFTER the corresponding `deadLetterLogger.warn` | **app-enforced** (call order at each site) |
| C3-I3 | On its own failure, emits one bounded line via `errorLogFields` and returns | **app-enforced**; the `check-caught-error-logging` gate enforces the bounding half |
| C3-I4 | Runs under `withBypassRls` with its own `BYPASS_PURPOSE` | **app-enforced**; `check-bypass-rls` gate enumerates purposes |

C3-I1 is app-enforced with no schema equivalent: "this function does not throw"
is not expressible in the storage layer. It is pinned by a test that makes the
insert reject and asserts the caller still resolves.

C3-I2's ordering is not cosmetic. Reversing it means a database outage — the most
likely cause of the dead letter — loses the row AND the line.

C3-I4 takes a NEW `BYPASS_PURPOSE` constant rather than reusing `AUDIT_WRITE`, so
the bypass-rls gate's accounting stays honest about which call sites exist and
why.

**Control class (R49)**: `detection or audit only`. This contract denies nothing;
it records. Stating it explicitly because a "durable dead letter" is easy to read
as a guarantee that no audit event is lost — it is not. The event is still lost;
what becomes durable is the *record that it was lost*.

**Forbidden patterns**
- `pattern: await persistDeadLetter` NOT preceded by `deadLetterLogger.warn` in the same block — reason: C3-I2.
- `pattern: throw` inside `persistDeadLetter` — reason: C3-I1.

**Acceptance criteria**
- Unit: the insert rejects → the promise resolves, and a second bounded log line
  is emitted.
- Unit: the insert rejects → the *first* (dead-letter) line was already emitted.

---

### C4 — Route the four in-class sites through C3

The four sites from the member-set table. Each keeps its existing
`deadLetterLogger.warn` unchanged and gains an `await persistDeadLetter(...)`
immediately after.

`logAuditBulkAsync`'s two sites emit one row per entry (matching the existing
per-entry log line), written with a single `createMany` rather than a loop.

**ORM type-shape note**: `createMany` takes `Prisma.AuditDeadLetterCreateManyInput[]`,
not the relation-form `AuditDeadLetterCreateInput[]`. The model has no relations,
so the two shapes coincide today; the contract names the `CreateMany` form so a
later relation addition surfaces as a type error rather than a runtime one.

**Acceptance criteria**
- Integration: `logAuditAsync` with an unresolvable user → exactly one
  `audit_dead_letter` row with `reason = 'tenant_not_found'`, zero `audit_outbox`
  rows.
- Integration: `logAuditBulkAsync` with N entries and an unresolvable user → N
  rows.
- The four call sites are the only writers (`grep -rn 'persistDeadLetter' src`).

---

### C5 — Retention

One `EXPIRY` entry in `src/workers/retention-gc-worker/registry.ts`:

```ts
{
  kind: "EXPIRY",
  table: "audit_dead_letter",
  cutoffColumn: "created_at",
  keyColumns: ["id"],
  globalDelete: true,
}
```

`globalDelete: true` is mandatory, not stylistic: `index.ts:76` refuses an
`EXPIRY` entry on an RLS-enabled table without it, and the table is not in
`RLS_FREE_EXPIRY_TABLES`.

**Retention window**: `OUTBOX_FAILED_RETENTION_DAYS` (default 90,
`src/lib/constants/audit/audit.ts:882`). A dead letter is the same class of
record as a `FAILED` outbox row — a failure awaiting operator attention — and
introducing a second number for the same class is a drift surface with no
compensating benefit.

**Control class (R49)**: `detection or audit only` for the registry entry itself;
the deletion it performs is the destructive operation, bounded by the cutoff.

**Acceptance criteria**
- Integration: a row older than the window is deleted; a row inside it is not
  (paired allow side — the boundary case at exactly the cutoff is stated below).
- **Boundary**: `created_at` exactly at the cutoff is RETAINED (`<` not `<=`),
  matching the sibling `EXPIRY` entries. Ties are impossible to distinguish and
  retention is the safe direction for an evidence table.

---

### C6 — Operator contract

Replace the known-gap block at `docs/operations/alerts.md:120-149` with the
durable contract: the query that lists recent dead letters, the reason tokens
(`tenant_not_found`, `logAuditAsync_failed`, `logAuditBulkAsync_failed`), and the
retention window. The current text tells operators to ship raw container stdout
or delete the Fluent Bit exclusion; that advice expires with this change and must
not be left standing.

**R29**: every reason token in the doc must be greppable in `audit.ts`.

---

### C7 — Tests

See Testing strategy.

---

## Consumer-flow walkthrough

`audit_dead_letter` is a persisted-state shape consumed outside its producer.

- **Consumer 1 — retention GC** (`src/workers/retention-gc-worker/sweep.ts`, driven by the C5 registry entry) reads `{ id, created_at }` and uses `created_at` to compare against the cutoff and `id` as the key column for the batched `DELETE`. Both are in the locked shape.
- **Consumer 2 — operator SQL** (`docs/operations/alerts.md`, C6) reads `{ created_at, reason, action, scope, user_id, tenant_id, error_name, error_code }` and uses `reason` to group by failure mode, `error_code` to tell a permission failure from a timeout, and `tenant_id` to see whether the value was absent or merely unresolvable. All present.
- **Consumer 3 — the grant audit** (`scripts/audit-db-grants.mjs`, C2) reads no columns; it consumes the table's *identity* (`public.audit_dead_letter`) from the denylist. Satisfied by the `@@map` name, which the denylist entries must match exactly.

No consumer needs a field absent from the locked shape. Explicitly **not** a
consumer: `/api/tenant/audit-logs`. The row exists because a tenant did not
resolve; a tenant-scoped read has no key to select it by, and exposing it would
publish one tenant's failure to whichever tenant the row was eventually
attributed to.

---

## Testing strategy

The failure mode to avoid is a test that asserts the row is written while the
*gap* — no record survives a lost tenant — goes unpinned.

1. **Integration, not mocked** (`src/__tests__/db-integration/`). A mocked Prisma
   cannot prove the RLS policy admits the insert, and the policy is the part most
   likely to be wrong. (RT1, RT5.)
2. **Connect as the app role, not the superuser.** A `passwd_user` connection
   bypasses RLS and greens a missing grant. (RT5.)
3. **Red-prove each clause separately, by execution** (Remedy Floor 2). One
   mutation per clause:
   - remove the policy's `WITH CHECK` → the insert case reddens;
   - remove the `withBypassRls` wrapper → the insert case reddens;
   - delete the `persistDeadLetter` call at one site → that site's case reddens
     and the other three stay green;
   - make the insert reject → the never-throws case reddens if the `try`/`catch`
     is removed.
4. **Pair the deny side with the allow side** (Remedy Floor 1). The cases that
   must still SUCCEED: a normal `logAuditAsync` with a resolvable tenant writes an
   `audit_outbox` row and **no** dead-letter row; the retention sweep leaves an
   in-window row alone.
5. **Fail loudly when the check cannot run** (Remedy Floor 3). The integration
   setup already refuses when a compose worker is on the same database
   (`src/__tests__/db-integration/setup.ts`); this change makes the retention
   worker a direct competitor, so that refusal is load-bearing here and its
   message must name `retention-gc-worker`.
6. **The log line still happens.** Asserted independently, so a future change
   that trades the line for the row is caught.

## Considerations & constraints

### Scope contract

- **SC1 — Removing `Exclude _logType ^audit-dead-letter$`.** Once the row is
  durable the exclusion costs nothing, and lifting it is an operator decision
  about their own sink's retention. Owner: operator runbook, not this PR.
- **SC2 — A metrics endpoint / alert query over the new table.** `alerts.md`
  gains the contract (C6); wiring `/api/maintenance/*` to report a count is a
  follow-up. `TODO(audit-dead-letter-durability): expose dead-letter count on the
  maintenance metrics endpoint.`
- **SC3 — Backfill.** No historical dead letters can be recovered; they were only
  ever log lines, and per VE1 the shipped forwarder dropped them. Nothing to
  measure and nothing to migrate.
- **SC4 — The three worker sites.** Excluded by the derivation above, not
  deferred: they already have a durable counterpart.

### Risks

- **R-1: unbounded growth under a systemic failure.** If tenant resolution breaks
  globally, every audit event becomes a dead-letter row. Bound: the volume equals
  what `audit_logs` would have taken, and C5 expires it. Not mitigated further.
- **R-2: the insert competes for connections during the outage that caused it.**
  `persistDeadLetter` runs one statement with no transaction beyond the RLS
  bypass. It is not retried; a failure degrades to the log line, which is the
  pre-change behaviour.
- **R-3: `bootstrap-rds-roles.mjs` silently re-granting.** This is the documented
  failure the denylist exists for, and C2 is the mitigation. It is called out as
  a risk because the mitigation is a *file entry*, and a file entry is easy to
  omit while the migration alone looks complete.

### No concurrency-control primitive

This design uses no isolation level, lock, advisory lock, or `SELECT … FOR
UPDATE`. `persistDeadLetter` is a single `INSERT` (or one `createMany`) with no
read-then-write. The plan-stage real-DB isolation probe therefore does not apply;
this paragraph records that it was considered and why it is inapplicable, rather
than leaving its absence to be read as an omission.

## User operation scenarios

1. **A user signs in whose `User.tenantId` is null** (mid-provisioning, or a SCIM
   race). `logAuditAsync` cannot resolve a tenant. Today: one log line the
   forwarder drops. After: a row with `reason = 'tenant_not_found'`,
   `tenant_id = NULL`, and the action that was lost.
2. **A bulk import runs while the database is failing over.**
   `logAuditBulkAsync` throws inside `enqueueAuditBulk`; N rows land with
   `reason = 'logAuditBulkAsync_failed'` and `error_code` carrying the SQLSTATE —
   or, if the database is fully down, N log lines and no rows, which is the
   pre-change behaviour and is the reason the log line is emitted first.
3. **An operator investigates a gap in the audit trail.** Queries
   `audit_dead_letter` by `created_at` range, groups by `reason`, and finds
   `error_code = '42501'` — a permission failure, not a timeout — which points at
   the grant rather than at load.
4. **90 days pass.** The retention sweep removes the rows. An operator who has
   not looked in 90 days has lost them, which is the same window the tree already
   applies to `FAILED` outbox rows.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `audit_dead_letter` table, RLS policy, migration | pending |
| C2 | Privilege policy + denylist entries + bootstrap convergence | pending |
| C3 | `persistDeadLetter` helper (never throws, log-line-first) | pending |
| C4 | Route the four in-class sites through C3 | pending |
| C5 | Retention GC registry entry + window | pending |
| C6 | Operator contract in alerts.md | pending |
| C7 | Integration + unit tests with per-clause red-proofs | pending |
