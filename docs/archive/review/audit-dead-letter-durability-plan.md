# Durable dead letters — plan (round 2)

Closes the KNOWN GAP at `src/lib/audit/audit.ts:271`, whose own comment fixes the
direction: *"the fix is to persist the dead letter durably rather than to widen
the log — alerting should not depend on log retention."*

Round-1 findings and their evidence live in
`audit-dead-letter-durability-review.md`. This file carries obligations and
acceptance criteria only, and cites finding IDs rather than restating them.

## Project context

- **Type**: service / web app (Next.js 16 + Prisma 7 + PostgreSQL 16) plus
  separate long-running worker processes.
- **Test infrastructure**: unit (vitest) + real-DB integration + E2E + CI/CD +
  76 `scripts/checks` gates run by `scripts/pre-pr.sh`.
- **Verification environment constraints**:
  - **VE1** — no Fluent Bit / SIEM here; anything resting on "the record reaches
    the sink" is `blocked-deferred`. Nothing in this plan does.
  - **VE2** — the dev database is shared and live; forward-only migrations, no
    reset, no destructive test against it (see C7's isolation rule).
  - **VE3** — integration tests cannot share a database with the compose
    workers. This change adds a retention entry, making
    `retention-gc-worker` a *direct* competitor. `setup.ts:51-55` already
    refuses on `application_name` — a verified precondition, not new work
    (m-4).
  - **VE4** — RDS role bootstrap is not runnable here. Grant contracts are
    `verifiable-local` against dev Postgres and `blocked-deferred` for RDS. The
    deferral is discharged by putting the grants in the **migration** (C-4/M-1),
    not by the denylist file alone, because the denylist's enforcing consumer is
    exactly the script VE4 excludes.
  - **VE5** — the dev database owner `passwd_user` is SUPERUSER, so it escapes
    `FORCE ROW LEVEL SECURITY`. Every RLS acceptance criterion below therefore
    names the role it connects as; one executed as the owner measures nothing
    (M-3).

## Objective

Make the record of a lost audit event survive independently of log retention.

## Requirements

1. Every in-class emission also writes a durable row.
2. `logAuditAsync` / `logAuditBulkAsync` keep their "Awaitable, never throws"
   contract.
3. The existing log line is retained and emitted **first**.
4. The store must not require a tenant.
5. Row fields are bounded before the insert, with the schema as backstop (M-5).
6. The table carries the audit-table immutability policy, and that policy
   survives `bootstrap-rds-roles.mjs`'s convergent blanket grant.
7. The table does not grow without bound.
8. Dead letters are exceptional. A code path that produces one on every request
   is a defect in that path, not a load to be absorbed (C-2).

## Member-set derivation (R42), re-derived from the property

The class is **a code path that drops an audit event and leaves only a log
line** — not "a `deadLetterLogger.warn` call". The spelling-anchored derivation
of round 1 missed a member (M-6).

Sweep 1 — dead-letter emissions:
`grep -rn "deadLetterLogger\." src scripts --include="*.ts" | grep -v "\.test\." | grep -v "__tests__"`
→ 7 sites.

Sweep 2 — audit writes whose failure is swallowed:
`grep -rn "BestEffort\|catch" src/workers/audit-outbox-worker.ts | grep -i audit`
→ `writeDirectAuditLogBestEffort` (`audit-outbox-worker.ts:561-579`).

| Site | Durable counterpart | In class |
|---|---|---|
| `audit.ts:283` `tenant_not_found` (single) | none — returns before `enqueueAudit` | **yes** |
| `audit.ts:368` `tenant_not_found` (bulk) | none | **yes** |
| `audit.ts:292` `logAuditAsync_failed` | none — the enqueue is what failed | **yes** |
| `audit.ts:379` `logAuditBulkAsync_failed` | none | **yes** |
| `audit-outbox-worker.ts:561-579` `writeDirectAuditLogBestEffort` | **none** — opens its own tx and swallows into a `warn`; its own docblock says so | **yes** (M-6) |
| `audit-outbox-worker.ts:1400` reaper | the row persists at `FAILED`, co-committed `AUDIT_OUTBOX_DEAD_LETTER` via `writeDirectAuditLogInTx` (`:1360-1395`) | no |
| `audit-outbox-worker.ts:1946` invalid userId | `recordError` (`:581-646`) persists `last_error` + `attempt_count`; the row goes to `PENDING` with backoff on this pass | no |
| `audit-outbox-worker.ts:2009` max attempts | `recordError`, terminal transition to `FAILED` | no |

The three exclusions rest on `recordError` and the reaper, cited by line — **not**
on `alerts.md:159`, which documents `delivery.dead_lettered`, the alert that
sentence contrasts *against* (M-7).

`account-lockout.ts:394` is a comment, not a call site.

---

## Contracts

### C1 — `audit_dead_letter` table and migration

```prisma
model AuditDeadLetter {
  id                 String   @id @default(uuid(4)) @db.Uuid
  scope              String   @db.VarChar(32)
  action             String   @db.VarChar(64)
  userId             String   @map("user_id") @db.VarChar(64)
  unresolvedTenantId String?  @map("unresolved_tenant_id") @db.VarChar(64)
  unresolvedTeamId   String?  @map("unresolved_team_id") @db.VarChar(64)
  reason             String   @db.VarChar(64)
  errorName          String?  @map("error_name") @db.VarChar(64)
  errorCode          String?  @map("error_code") @db.VarChar(64)
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([createdAt])
  @@index([reason, createdAt])
  @@map("audit_dead_letter")
}
```

**`unresolved_tenant_id`, not `tenant_id` (C-3).**
`scripts/rls-cross-tenant-verify.sql:112-134` asserts
`discovered_count` (tables with a `tenant_isolation`-named policy AND a
`tenant_id` column) `= column_count` (every `tenant_id` column in `public`
except `tenants`). Both are 56. A `tenant_id` column here makes it 57 vs 56 and
the ASSERT fires in CI (`.github/workflows/ci.yml:670`) and `pre-pr.sh:486`. The
tree's own precedent is
`20260731100000_add_tenant_claim_events/migration.sql`, which names its columns
`old_tenant_id` / `new_tenant_id` for this reason. The name also reads correctly:
the column holds the tenant that did *not* resolve. The migration records the
reason inline so the next editor does not "fix" it back.

**Invariants**

| # | Invariant | Enforcement |
|---|---|---|
| C1-I1 | No field exceeds its cap | **app-truncated, schema-backstopped** (M-5) — `varchar(n)` REJECTS with `22001`, it does not truncate, and a rejected row is the loss this plan exists to end |
| C1-I2 | A row can be written with no resolvable tenant | **schema-enforced** (nullable, no FK, `VarChar` not `Uuid`) |
| C1-I3 | Only a bypass-RLS session reads or writes | **schema-enforced** (RLS `ENABLE` + `FORCE` + bypass-only policy) |
| C1-I4 | No unbounded-text field exists | **fail-closed verification gate** (M-4) — a new gate, C9; the absence of a column is not a mechanism, and `check-audit-metadata-narrative.mjs` scans `src,scripts` and never opens `prisma/schema.prisma` |

**RLS** — the `system_settings` precedent
(`20260502000000_audit_anchor_publisher_phase2/migration.sql:17-21`), the only
`*_bypass ON` policy in the tree:

```sql
ALTER TABLE "audit_dead_letter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_dead_letter" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_dead_letter_bypass ON "audit_dead_letter"
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on')
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on');
```

**Migration shape.** Wrapped in `BEGIN; … COMMIT;` (M-10):
`scripts/checks/check-migration-transaction.mjs` binds new migrations, and
unwrapped, a failure at statement three leaves the table with RLS not yet
enabled while the deploy proceeds. `DO $$ BEGIN … END $$` is a PL/pgSQL block
opener, not a transaction opener. No `CREATE INDEX CONCURRENTLY` (it would force
its own migration). Additive only (R24); no environment literal (R15).

**Control class (R49)**: `enforceable boundary` for the RLS policy — the
constrained actor is the `NOSUPERUSER NOBYPASSRLS` application role and the
adjudicator is PostgreSQL's row-security evaluator. It does **not** bound a
superuser or a `rolbypassrls` role, and VE5 says why that matters for testing.

**Forbidden patterns**
- `pattern: audit_dead_letter.*REFERENCES` — reason: an FK reinstates the constraint that made the gap structural.
- `pattern: ^\s*tenant_id\b` in the `audit_dead_letter` DDL — reason: C-3.
- `pattern: @db.Uuid` on `userId`/`unresolvedTenantId` — reason: C1-I2.

**Acceptance criteria** (each names the role it connects as — VE5)
- `node scripts/checks/check-migration-transaction.mjs` exits 0, unpiped.
- `node scripts/checks/check-migration-drift.mjs` exits 0, unpiped — this, not an eyeballed `db:migrate` console (M-12b).
- As `passwd_app` **without** the bypass GUC: `INSERT` raises `42501`/policy violation **and** a subsequent bypass-session `SELECT` shows zero rows for that id — asserting the raise alone cannot tell a rejected insert from one that wrote and then raised (RT8).
- As `passwd_app` **with** the bypass GUC: `INSERT` succeeds.
- `node scripts/rls-cross-tenant-verify.sql`'s parity assertion still reports 56 = 56.

---

### C2 — Privilege policy

All grants live in the **migration** (M-1), not in the denylist file alone. The
default ACL `passwd_app=arwd/passwd_user` pre-grants `arwd` on every new table —
measured and recorded in `20260731100000_add_tenant_claim_events/migration.sql`
— and the denylist's enforcing consumer is `bootstrap-rds-roles.mjs`, which VE4
excludes. Without the migration REVOKE, `passwd_app` holds `UPDATE`/`DELETE` on
the evidence table on every dev and CI database.

```sql
REVOKE ALL ON TABLE "audit_dead_letter" FROM passwd_app;
GRANT INSERT ON TABLE "audit_dead_letter" TO passwd_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "audit_dead_letter" TO passwd_retention_gc_worker;
  ELSE
    RAISE NOTICE 'passwd_retention_gc_worker absent — retention grant skipped';
  END IF;
END $$;
```

**`passwd_app` gets INSERT and NOT SELECT (M-2).** C2's round-1 reasoning —
"the bypass-RLS policy is the read bound" — was wrong: `set_config` needs no
privilege, so anything running as `passwd_app` inside or beside a bypass scope
satisfies the policy. The same file already adjudicates this shape the other way
for `tenant_claim_events`. Nothing in this plan reads the table from the app.

**This forces the write shape.** PostgreSQL requires `SELECT` on returned
columns for `INSERT … RETURNING`, and Prisma's `create()` always emits
`RETURNING` while `createMany` does not. So C3 uses `createMany` for the single
row as well as the bulk one. That is why the `tenant_claim_events` writer issues
a raw INSERT with no RETURNING.

**`SELECT` for the GC is not optional (C-4).** `sweepExpiryEntry` issues a
self-subquery (`sweep.ts:181-187`); with `DELETE` alone it raises `42501`,
`sweepOnce` swallows it per INV-C4b, and retention never runs — silently.

**Denylist entries** (`scripts/checks/app-role-denied-privileges.json`)

| Role | Denied on `public.audit_dead_letter` |
|---|---|
| `passwd_app` | `SELECT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` |
| `passwd_outbox_worker` | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` (the seven, spelled out — the file has no `"all"` shape) |
| `passwd_retention_gc_worker` | `INSERT`, `UPDATE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` (M-13) — the complement of what it needs. `UPDATE` on this table by any role is evidence tampering, and `TRUNCATE` is not implied by `DELETE` |

**Why direct `DELETE` rather than a definer routine.** Not "no additional bound"
— that reasoning was the weaker half (M-13). `audit_log_purge` takes its cutoff
**from the caller**, so copying that shape buys no bound unless the routine
clamps server-side, which it does not. The real asymmetry is narrower: for
`audit_logs` the GC holds only `EXECUTE`. Direct `DELETE` is chosen because the
retention registry drives every other table that way and a second purge path is
a drift surface; the privileges adjacent to `DELETE` are denied explicitly above
instead.

**Control class (R49)**: `fail-closed verification gate`, **run manually**
(M-12). CI runs the enforcement half only —
`bootstrap-rds-roles.mjs --denied-only` (`ci-integration.yml:184`).
`audit-db-grants.mjs` appears in no workflow.

**Forbidden patterns**
- `pattern: GRANT .*(UPDATE|TRUNCATE).*audit_dead_letter` — reason: C2 denies both.
- `pattern: "privileges": \[[^\]]*"SELECT"[^\]]*\]` within a `passwd_retention_gc_worker` × `audit_dead_letter` entry — reason: denying `SELECT` or `DELETE` there wedges retention (the inverse-direction guard; the entry itself is required).

**Acceptance criteria**
- `node scripts/audit-db-grants.mjs --write`, diff reviewed in the PR, and the only new manifest keys are this table's. Then `node scripts/audit-db-grants.mjs` exits 0 unpiped and prints its grant-count line risen by exactly the number added (M-12).
- `node scripts/bootstrap-rds-roles.mjs --denied-only` twice, then the audit exits 0 both times.
- Mutation: `GRANT UPDATE ON audit_dead_letter TO passwd_app` → the audit exits non-zero naming role, table and privilege.

---

### C3 — The write helpers

```ts
type DeadLetterRecord = ReturnType<typeof deadLetterEntry>;

/** Flatten and truncate. The one place caps are applied. */
function toDeadLetterRow(entry: DeadLetterRecord): Prisma.AuditDeadLetterCreateManyInput;

async function persistDeadLetter(entry: DeadLetterRecord): Promise<void>;
async function persistDeadLetters(entries: DeadLetterRecord[]): Promise<void>;
```

Two functions sharing one `withBypassRls` body, because a singular signature
cannot issue one `createMany` for N entries (M-8). `toDeadLetterRow` is the
flattening the round-1 contract omitted: `deadLetterEntry` returns a **nested**
`error: {name, code}` against C1's flat `errorName`/`errorCode`, so
`DeadLetterRecord` is assignable to neither Prisma input without it.

`id` comes from Prisma's client-side `@default(uuid(4))`; there is no DB
`DEFAULT` (verified: `20260412100000_add_audit_outbox/migration.sql:6`). A future
raw-SQL writer must supply it.

**`deadLetterEntry` gains `teamId`** (M-9). `resolveTenantId` tries the team
branch **first** (`audit.ts:172-177`), so a `tenant_not_found` there means a
dangling or cross-tenant team reference — a different and more security-relevant
fault than "this user has no tenant yet". An always-NULL column reads as positive
evidence that no team was involved. It is an id, not narrative, so
`deadLetterEntry`'s bounding docblock is unaffected.

**Invariants**

| # | Invariant | Enforcement |
|---|---|---|
| C3-I1 | Never throws | app-enforced (whole body in `try`/`catch`) |
| C3-I2 | Called AFTER the corresponding `deadLetterLogger.warn` | app-enforced, pinned by `invocationCallOrder` (M-16), not by a grep over source text |
| C3-I3 | On failure, one bounded line via `errorLogFields`, then return | app-enforced; `check-caught-error-logging` covers the bounding half |
| C3-I4 | Runs under `withBypassRls` with its own `BYPASS_PURPOSE` | **detection or audit only** (M-11). `check-bypass-rls` Check 2 is FILE-scoped and only asserts the identifier `BYPASS_PURPOSE` appears (`:1147-1152`), which `audit.ts:191` already satisfies. No gate enumerates purposes. The new member is a documentation and observability choice — it lands in `app.bypass_purpose` — and is preferred over reusing `AUDIT_WRITE` because the two have different blast radii |
| C3-I5 | Must not be reached inside `withTenantRls` | app-enforced precondition (m-1). `withBypassRls` throws `INVALID_RLS_NESTING` there and C3-I1 would swallow it, losing the row silently. Verified today: zero lexical call sites, by two independent AST sweeps |

C3-I2's ordering is not cosmetic: reversing it makes a database outage — the
likeliest cause of the dead letter — lose the row AND the line.

**Control class (R49)**: `detection or audit only`. The event is still lost; what
becomes durable is the record that it was lost.

**Acceptance criteria**
- `createMany` is called once with the **exact** row object, asserted by equality (not `toMatchObject`) per reason token — including `errorName === null && errorCode === null` for `tenant_not_found`, and the `{name, code}` → two-column mapping for the `_failed` reasons (M-9).
- The insert rejects → the promise resolves **and** `createMany` is recorded as called; that is what separates it from round 1's swallowed `TypeError` (M-14).
- A resolvable-tenant `logAuditAsync` calls `enqueueAudit` once and `createMany` **zero** times (allow side).
- `logAuditBulkAsync` with `paramsList.length === 0` writes zero rows and never calls `createMany` with an empty array.
- Truncation: a value of exactly `n` is stored whole; `n+1` produces a **row**, truncated to `n` — today it produces no row at all. Character count, not byte slice.

---

### C4 — Route the in-class sites through C3

The five in-class sites. Each keeps its `deadLetterLogger.warn` unchanged and
gains an `await persistDeadLetter(...)` / `persistDeadLetters(...)` after it.
`writeDirectAuditLogBestEffort` (M-6) gains `reason = 'direct_audit_write_failed'`
in its catch; its best-effort semantics are preserved — the webhook auto-disable
must still commit when the audit write fails.

**Acceptance criteria**
- One mutation **per site** (five), each reddening only that site's case (M-16).
- Integration: `logAuditAsync` with an unresolvable user → exactly one row with `reason = 'tenant_not_found'`, zero `audit_outbox` rows, asserted **by the fixture's discriminator** (C7).
- `logAuditBulkAsync` with N entries → N rows, one log line each.

---

### C5 — Retention

`ExpiryEntry` gains `retentionDays?: number`, and `sweepExpiryEntry` gains the
cutoff branch `sweepAuditProvenanceEntry` already has (`sweep.ts:287-292`), with
the integer bound as `$2` and never interpolated:

```ts
const cutoffSql = entry.retentionDays
  ? `${entry.cutoffColumn} < now() - ($2 || ' days')::interval`
  : `${entry.cutoffColumn} < now()`;
```

**Why (C-1).** `sweepExpiryEntry` renders a fixed `WHERE cutoffColumn < now()`
(`sweep.ts:184`), and every existing `EXPIRY` entry pairs it with a FUTURE
instant (`expires_at`, `dcr_expires_at`). `created_at` is past for every row that
exists, so the round-1 entry would have deleted each dead letter on the first
sweep after writing it — a lifetime **shorter** than the 20m×5 container log it
exists to outlast. `registry.ts:466` already records this shape as a known
tautology. `EXPIRY_AUDIT_PROVENANCE` is not the shortcut it looks like: it emits
a per-row audit event, i.e. an audit write about a lost audit write, and needs a
resolvable tenant — the one thing these rows lack.

Registry entry:

```ts
{
  kind: "EXPIRY",
  table: "audit_dead_letter",
  cutoffColumn: "created_at",
  keyColumns: ["id"],
  retentionDays: AUDIT_OUTBOX.FAILED_RETENTION_DAYS,
  globalDelete: true,
}
```

`globalDelete: true` is mandatory — `index.ts:76` refuses without it on an
RLS-enabled table. Window: `OUTBOX_FAILED_RETENTION_DAYS` (default 90,
`src/lib/constants/audit/audit.ts:882`); a dead letter is the same class of
record as a `FAILED` outbox row, and a second number for one class is a drift
surface. **Shortening it shortens both** — say so where it is documented (m-5).

`registry.test.ts:63`'s `expect(expiry).toHaveLength(6)` becomes 7, with
`audit_dead_letter` named in the test title (M-11). Not
`toBeGreaterThanOrEqual` — widening deletes the signal.

**Control class (R49)**: a **destructive operation** bounded by the cutoff and
the batch (m-5), not `detection or audit only`. R31 category (g).

**Acceptance criteria**
- The eight existing `EXPIRY`/`EXPIRY_GUARDED` entries emit **byte-identical** SQL after the change — asserted, not assumed.
- A row at `now() - 91 days` is deleted **by id**; a row at `now() - 89 days` is present **by id**. Never a table-wide count (M-17).
- **Boundary**: `created_at` exactly at `now() - 90 days` is RETAINED (`<`, not `<=`); rows sharing that instant are all retained, and the batch `LIMIT` never splits the tie because none is selected.
- Mutations: drop `retentionDays` from the entry → the in-window case reddens; drop the `- ($2 || ' days')` branch → the same case reddens; set `retentionDays` on an existing entry → the byte-identity assertion reddens.

---

### C6 — Operator contract

Replaces the known-gap block at `docs/operations/alerts.md:120-149`.

- The query opens a transaction with `SET LOCAL app.bypass_rls = 'on';` and one line saying what an empty result means without it (M-3). `FORCE ROW LEVEL SECURITY` applies to the owner, and no operations doc in the tree mentions the GUC today.
- Field list: `created_at, reason, action, scope, user_id, unresolved_tenant_id, unresolved_team_id, error_name, error_code`.
- Reason tokens: `tenant_not_found`, `logAuditAsync_failed`, `logAuditBulkAsync_failed`, `direct_audit_write_failed` — each greppable in the source (R29).
- The 90-day window, **and** that `scripts/backup-db.sh` keeps `BACKUP_RETAIN` full dumps, so rows outlive it inside backups (m-5).
- `alerts.md:159`'s durability contrast is rewritten to distinguish the two mechanisms (co-committed `audit_logs` row vs. `audit_dead_letter` row) rather than durable vs. not (m-3).
- One sentence stating the Fluent Bit exclusion may stay because the durable row, not the log line, is now the alerting source — SC1 assigns the owner, this gives the rationale a home (m-3).
- `error_code` is stored verbatim, including `"unknown"`; C6 says so, because grouping on it otherwise gives different counts for one incident.
- For `reason = 'tenant_not_found'`, `unresolved_tenant_id` is structurally always NULL — a truthy `params.tenantId` short-circuits `resolveTenantId` at `:169`. Say so; the round-1 walkthrough claimed a distinction that reason code cannot represent (m-7).

---

### C7 — Tests

- **Integration, as the real roles.** `ctx.app` and `ctx.retentionWorker` exist (`helpers.ts:307-312`, `:49-56`) and CI creates both roles. A superuser connection bypasses RLS and greens a missing grant. Assert `SELECT current_user` in each case.
- **Isolation (M-15).** Every fixture row carries a `randomUUID()` discriminator in `user_id`; teardown and every assertion scope by it, and the delete is registered at acquisition (`onTestFinished`) so the abort path still reclaims. `deleteTestData` is tenant-keyed and cannot reach a NULL-tenant row.
- **By primary key, never by count (M-17).** `globalDelete: true` means the sweep is table-wide; on the shared dev database a count assertion is satisfiable by rows the test did not write. Assert fixture rows exist by id *before* the invariant assertion (RT4). Record that a local run deletes real dev dead-letter rows past the cutoff.
- **Both unit mocks completed (M-14).** `src/lib/audit/audit.test.ts` and `src/__tests__/audit.mocked.test.ts` mock the client to two delegates, so `prisma.auditDeadLetter` is `undefined` and `.createMany` raises a `TypeError` that C3-I1 swallows — every criterion passes with no insert attempted, and the "remove the try/catch" mutation reddens for that unrelated reason. Complete both, typed against the real client type, plus the new `BYPASS_PURPOSE` member in `audit.test.ts`'s stub and an explicit `withBypassRls` passthrough in the twin.
- **Mutations, one per clause, executed.** Not "remove `WITH CHECK`" — for a permissive policy with none, PostgreSQL uses the `USING` expression for `INSERT`, and C1's two expressions are identical, so that mutation produces zero delta (M-16). Use "delete the `CREATE POLICY`" or "invert to `<> 'on'`", and record why the `WITH CHECK` deletion was rejected.
- **Two distinguishable retention failures (C-4).** Dropping the `GRANT` reds with `42501`; dropping the sweeper's bypass `set_config` reds with **0 rows deleted and no error**.
- **Refuse, do not fall back.** The C5 case connects as `passwd_retention_gc_worker` and refuses by name when the role is absent, rather than using the superuser URL.

---

### C8 — Pre-auth sentinel-actor audit sites *(new, C-2)*

No `users` row exists for the sentinel actors (no migration or seed inserts one),
so any audit call passing a sentinel `userId` with neither `tenantId` nor
`teamId` is a **guaranteed** `tenant_not_found`. Exactly two exist and both are
pre-auth:

- `src/app/api/extension/token/route.ts:61-67` — `ANONYMOUS_ACTOR_ID`; its own comment says it dead-letters.
- `src/app/api/mcp/register/route.ts:189-197` — `SYSTEM_ACTOR_ID`, on the endpoint the tree labels "pre-auth endpoint" (`:82`).

Left as they are, this plan lets unauthenticated traffic write rows into a
90-day table the application is denied `DELETE` on, at one bypass transaction
each — and buries the operator's signal under two known-benign reasons.

**Fix at the source**: pass `tenantId: SYSTEM_TENANT_ID`
(`src/lib/constants/app.ts:71`) at both sites so they enqueue normally. The
tenants row exists with zero memberships
(`20260428170853_add_dcr_cleanup_worker_role_and_system_tenant/migration.sql:40-48`),
and `AuditLog.userId` has no FK to `users` (`schema.prisma:1134`).

Neither audit emission may be removed, and neither `deadLetterLogger.warn` may be
dropped: the 410 attempt and the DCR registration are the record of pre-auth
activity.

**Acceptance criteria**
- Both sites produce an `audit_outbox` row under `SYSTEM_TENANT_ID` and **zero** dead-letter rows.
- Mutation per site: revert one → its dead-letter row reappears while the other stays clean.
- Point one site at a non-existent tenant id → `enqueueAudit`'s existence check (`audit-outbox.ts:79-83`) throws and a `logAuditAsync_failed` row appears, proving the dead-letter path is still armed rather than merely unreachable.

---

### C9 — Schema-narrative gate *(new, M-4)*

A gate that resolves the `AuditDeadLetter` model in `prisma/schema.prisma` and
fails on any field whose type is `String`/`String?` with no `@db.VarChar(n)`.
Derived from the **type**, not from a name list: `note`, `detail`,
`description`, `last_error` are the same defect with different spellings
(R42/R47). The obvious next PR — mirroring `recordError`'s
`sanitizeErrorForStorage(errorMsg)` into a `last_error` column
(`audit-outbox-worker.ts:586-590`) — reads as consistent with the tree and would
pass every existing gate.

**Control class (R49)**: `fail-closed verification gate` over one model.

**Acceptance criteria**
- The nine C1 fields pass; exit 0.
- `errorDetail String` → reds. `errorDetail String @db.VarChar(64)` → greens, proving it discriminates by bound and not by name.
- Renaming the model → reds with "resolved 0 fields for AuditDeadLetter", not passes.
- Self-test present (`check-gate-selftest-coverage.sh` requires one), separating refusals from violations, with the pre-pr wiring assertion anchored at line start.

---

## Consumer-flow walkthrough

- **Consumer 1 — retention GC** (`sweep.ts`, driven by C5) reads `{ id, created_at }`; `created_at` against the cutoff, `id` as the key column for the batched `DELETE`. Both present.
- **Consumer 2 — operator SQL** (C6) reads `{ created_at, reason, action, scope, user_id, unresolved_tenant_id, unresolved_team_id, error_name, error_code }`; `reason` to group by failure mode, `error_code` to tell a permission failure from a timeout, `unresolved_team_id` to tell the team branch of `resolveTenantId` from the user branch. All present.
- **Consumer 3 — the grant audit** (`audit-db-grants.mjs`) consumes the table's identity `public.audit_dead_letter` from the denylist; satisfied by `@@map`, which the entries must match exactly.
- **Not a consumer**: `/api/tenant/audit-logs`. The row exists because a tenant did not resolve; a tenant-scoped read has no key to select it by.

## Considerations

### Scope contract
- **SC1** — removing `Exclude _logType ^audit-dead-letter$`. Operator decision; C6 now carries the rationale for keeping it.
- **SC2** — a metrics endpoint over the table. `TODO(audit-dead-letter-durability): expose dead-letter count on the maintenance metrics endpoint.` If it paginates, `created_at` alone ties — use `(created_at, id)`.
- **SC3** — backfill. Nothing to migrate; historical dead letters were only log lines and VE1 says the forwarder dropped them.
- **SC4** — the three worker sites, excluded by the property above with `recordError` and the reaper cited by line.

### Risks
- **R-1** (revised, C-2): after C8, dead-letter volume is bounded by *authenticated* audit volume. Before C8 it was bounded by unauthenticated request volume, which is what made the round-1 bound false.
- **R-2**: the insert competes for connections during the outage that caused it. One statement, no retry; failure degrades to the log line, which is the pre-change behaviour.
- **R-3**: `bootstrap-rds-roles.mjs` re-granting. Mitigated by putting the REVOKE in the migration (M-1) *and* the denylist entry, because the denylist alone is enforced only where VE4 says we cannot run it.

### No concurrency-control primitive
No isolation level, lock, or `SELECT … FOR UPDATE`. `persistDeadLetter` is a
single `createMany` with no read-then-write, so the plan-stage isolation probe
does not apply. Recorded so its absence is not read as an omission.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Table, RLS policy, transactional migration, `unresolved_*` naming | pending |
| C2 | Privileges in the migration + denylist entries | pending |
| C3 | `toDeadLetterRow` + `persistDeadLetter(s)`, truncation, `teamId` | pending |
| C4 | Route the five in-class sites through C3 | pending |
| C5 | `ExpiryEntry.retentionDays` + sweep cutoff + registry entry | pending |
| C6 | Operator contract | pending |
| C7 | Tests | pending |
| C8 | Pre-auth sentinel-actor sites | pending |
| C9 | Schema-narrative gate | pending |
