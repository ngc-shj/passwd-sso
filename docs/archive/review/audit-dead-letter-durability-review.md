# Plan Review: audit-dead-letter-durability
Date: 2026-08-31
Review round: 1

## Changes from Previous Round
Initial review.

## Merge method

Mechanical merge over the three experts' fenced json indices, joined on (file,
line ±5, root cause). Findings are consolidated by root cause and carry every
expert that raised them; the per-expert `Recurring Issue Check` blocks are
consolidated below to the lines that produced a finding plus the lines whose
`Checked` status is itself load-bearing evidence — a deviation from the verbatim
requirement, recorded here rather than done silently. The three raw outputs were
not persisted to disk; their substance is reproduced per finding.

Expert IDs are namespaced (`FN-` functionality, `SE-` security, `TE-` testing)
because all three used `F-01…` independently.

## Convergence (severity floor per "Perspective Convergence as a Severity Signal")

| Root cause | Raised by | Floor |
|---|---|---|
| `EXPIRY` cannot express a retention window | FN-01 (Critical), TE-02 (Critical) | **Critical** |
| GC role's grant missing / incomplete | FN-05a, SE-2, TE-04 | **Critical** |
| `db-grants-manifest.json` regeneration unstated | FN-05d, TE-07 | Major |
| `team_id` has no producer | FN-04, SE-9, TE-10 | Major |
| `ALLOWED_USAGE` + C3-I4 overstated | FN-08, SE-8, TE-08 | Major |
| `VarChar` rejects rather than truncates | FN-11 (Minor), SE-6 (Major) | Major |
| `INVALID_RLS_NESTING` latent | FN-10, SE-11 | Minor (question) |
| `setup.ts` obligation already satisfied | FN-14, TE-09 | Minor |

Three experts converging is a severity signal, not a correctness proof — each
claim below was re-derived by the orchestrator against the tree before being
recorded.

---

## Critical

### C-1 — `EXPIRY` has no retention window; the entry deletes every row on the first sweep
*FN-01, TE-02.* `ExpiryEntry` (`src/workers/retention-gc-worker/registry.ts:30-59`)
declares no `retentionDays`; only `AuditProvenanceEntry` has one (`:126-134`).
`sweepExpiryEntry` renders a fixed `WHERE ${cutoffColumn} < now()`
(`src/workers/retention-gc-worker/sweep.ts:184`), and every existing `EXPIRY`
entry pairs it with a FUTURE instant (`expires_at`, `dcr_expires_at`).
`created_at` is a past instant for every row that exists, so the plan's C5 makes
the record's lifetime SHORTER than the 20m×5 container log it was meant to
outlast. `registry.ts:466` already records this shape as a known tautology.

**Action**: add `retentionDays?: number` to `ExpiryEntry` and give
`sweepExpiryEntry` the bound-parameter cutoff `sweepAuditProvenanceEntry` already
uses (`sweep.ts:287-292`). Do **not** switch to `EXPIRY_AUDIT_PROVENANCE` to get
the field for free — it emits a per-row audit event, i.e. an audit write about a
lost audit write, and it needs a resolvable tenant, which is the one thing these
rows lack. Assert the eight existing entries' emitted SQL is byte-identical
afterwards. C5's boundary paragraph must be restated against `now() - 90 days`;
as written it describes a tie at `now()`, which is vacuous (FN-12).

### C-2 — Two pre-auth routes make dead letters the normal case, not the exception
*SE-1 (filed Major; raised to Critical here — it converts an unauthenticated
request into a durable row the application cannot delete).* No `users` row exists
for the sentinel actors, so any call passing a sentinel `userId` with neither
`tenantId` nor `teamId` is a **guaranteed** `tenant_not_found`. Exactly two such
sites exist and both are pre-auth:
`src/app/api/extension/token/route.ts:61-67` (`ANONYMOUS_ACTOR_ID`; its own
comment at `:59-60` says it dead-letters) and
`src/app/api/mcp/register/route.ts:189-197` (`SYSTEM_ACTOR_ID`, on the endpoint
the tree labels "pre-auth endpoint" at `:82`). The plan's risk R-1 bounds volume
by "what `audit_logs` would have taken" — which is **zero** for these two,
because the function returns before enqueuing.

**Action**: fix at the source, not the sink — pass `tenantId: SYSTEM_TENANT_ID`
at both sites so they enqueue normally. The tenants row exists
(`20260428170853_add_dcr_cleanup_worker_role_and_system_tenant/migration.sql:40-48`,
zero memberships) and `AuditLog.userId` has no FK to `users`
(`prisma/schema.prisma:1134`). Add an AST gate: a `logAuditAsync`-family call
whose `userId` is a `SENTINEL_ACTOR_IDS` member and which passes neither
`tenantId` nor `teamId` is a violation — matching exactly 2 today and 0 after,
and exiting non-zero if it resolves no call sites at all. Neither audit emission
may be removed.

### C-3 — A `tenant_id` column breaks the `[E-RLS-COLPARITY]` assertion
*FN-02 (escalated).* `scripts/rls-cross-tenant-verify.sql:112-134` asserts
`discovered_count` (tables with a `tenant_isolation`-named policy **and** a
`tenant_id` column) `=` `column_count` (every `tenant_id` column in `public`,
excluding `tenants`). Both are 56 today. C1 makes it 57 vs 56 and the ASSERT
fires. The gate runs in CI (`.github/workflows/ci.yml:670`) and in
`scripts/pre-pr.sh:486`. The cheapest-looking repair — add a `tenant_isolation`
policy — would deny the write in exactly the case the table exists for.

**Action**: rename the column outside the predicate, following the tree's own
precedent: `20260731100000_add_tenant_claim_events/migration.sql` uses
`old_tenant_id` / `new_tenant_id` and records the reason inline.
`unresolved_tenant_id` reads correctly for what it holds. Propagate the rename
into C6's SQL and the consumer walkthrough.

### C-4 — The GC role receives nothing on a new table, and no test can see it
*FN-05a, SE-2, TE-04.* Three compounding facts: (i) `sweepExpiryEntry` issues a
self-subquery (`sweep.ts:181-187`), so `DELETE` alone raises `42501` — C2's prose
says "SELECT + DELETE" and its chosen option says "DELETE"; (ii)
`bootstrap-rds-roles.mjs:369-398` deliberately issues no table grants to worker
roles, so the grant must live in the migration (precedent:
`20260618230000_retention_gc_log_grants/migration.sql`); (iii) `sweepOnce`
swallows a per-entry failure by design (INV-C4b), so retention never runs,
silently, forever. And `ci-integration.yml:160-170` creates only `passwd_app`
while the harness connects via the superuser `MIGRATION_DATABASE_URL`, so the
acceptance criterion passes with no grant present at all.

**Action**: put the grant in the C1 migration under an
`IF EXISTS (SELECT 1 FROM pg_roles …)` guard. The C5 integration case must
connect as `passwd_retention_gc_worker` and **refuse by name** when the role is
absent rather than falling back to the superuser URL. Two distinguishable
red-proofs are required: dropping the `GRANT` reds with `42501`; dropping the
sweeper's bypass `set_config` reds with **0 rows deleted and no error**.

---

## Major

### M-1 — `passwd_app` is pre-granted `arwd` on every new table
*FN-05c.* `20260731100000_add_tenant_claim_events/migration.sql` records the
measured fact: the default ACL `passwd_app=arwd/passwd_user` pre-grants `arwd`,
"so the REVOKE is load-bearing rather than decorative". The plan puts the denial
only in `app-role-denied-privileges.json`, whose enforcing consumer is
`bootstrap-rds-roles.mjs` — which VE4 records as not runnable here. On every dev
and CI database, `passwd_app` therefore holds `UPDATE`/`DELETE` on the evidence
table from the moment the migration commits. **Action**: `REVOKE ALL` + explicit
`GRANT` in the migration itself.

### M-2 — Deny `SELECT` to `passwd_app`, which forces `createMany` everywhere
*SE-4.* C2 reasons "the bypass-RLS policy is the read bound". It is not: any code
running as `passwd_app` inside or alongside a bypass scope satisfies the policy,
and `set_config` needs no privilege. The same file already adjudicates this shape
the other way for `tenant_claim_events`: *"Granting SELECT back would hand an
application compromise the read side of every tenant's claim-routing history."*
Nothing in the plan reads the table from the app. **Action**: deny `SELECT` too.
This forces one implementation choice the plan must state — PostgreSQL requires
`SELECT` on returned columns for `INSERT … RETURNING`, and Prisma's `create()`
always emits `RETURNING` while `createMany` does not, so **both** the single and
bulk paths must use `createMany`. That is why the `tenant_claim_events` writer
issues a raw INSERT with no RETURNING.

### M-3 — `FORCE ROW LEVEL SECURITY` applies to the owner; every dev criterion is vacuous
*SE-5.* Only `rolsuper` or `rolbypassrls` escapes `FORCE`. The dev owner
`passwd_user` is SUPERUSER, so every C1 acceptance criterion and every C6
scenario passes locally regardless of the deployed configuration.
`bootstrap-rds-roles.mjs:79-80` converges managed roles to
`NOSUPERUSER NOBYPASSRLS`. No operations doc mentions the GUC
(`rg -rn "app.bypass_rls" docs/operations/` → empty). **Action**: C6's query opens
a transaction with `SET LOCAL app.bypass_rls = 'on'` and says in one line what an
empty result means without it; C1's criteria gain the negative case executed as a
**non-superuser** role. "There are no dead letters" and "you may not see them"
must not be spelled identically.

### M-4 — C1-I4 is declared schema-enforced and nothing enforces it
*SE-3.* The plan cites `check-audit-metadata-narrative.mjs` (landed on this
branch) for "no free-form narrative column". That gate scans `src,scripts`, never
opens `prisma/schema.prisma`, and keys on the property name `metadata`. A future
`ADD COLUMN last_error TEXT` — mirroring what `recordError` already does for
`audit_outbox` (`audit-outbox-worker.ts:586-590`) — is invisible to it twice
over. **Action**: either restate C1-I4 as `detection or audit only`, or add a
gate that resolves the `AuditDeadLetter` model in the schema and rejects any
`String` field with no `@db.VarChar(n)` — deriving from the TYPE, not from the
three names C1 lists (`note`, `detail`, `description`, `last_error` are the same
defect with a different spelling).

### M-5 — `VarChar(n)` rejects; the row is discarded by C3-I1's own catch
*SE-6, FN-11.* Measured headroom: `scope` 24, `action` 25, `reason` 40, `user_id`
28 — and `error_name`/`error_code` **zero**, because `TOKEN_RE`
(`src/lib/logger/error-fields.ts:9`) admits exactly 64. Two bounds, two files, no
shared constant (R48). **Action**: truncate application-side before the insert
with shared constants; restate C1-I1 as "app-truncated, schema-backstopped".
State whether truncation counts characters or bytes — `varchar(n)` counts
characters, and a naive byte slice turns a length rejection into an encoding one.

### M-6 — The member set was anchored on the spelling `deadLetterLogger.`
*FN-06.* The primitive sweep reproduces exactly (all three experts confirmed the
7 sites and the 3 exclusions). But `writeDirectAuditLogBestEffort`
(`audit-outbox-worker.ts:561-579`) opens its own transaction and **swallows**
failure into a `warn` — its docblock says so — losing an `audit_logs` row with a
log line as the only record. That is the plan's Objective property word for word,
and it is out only under the narrower Requirement 1 wording. **Action**:
re-derive from the property ("a code path that drops an audit event and leaves
only a log line"), do not append to the existing table. The CI guard must key on
the property, not the helper's name, or it reproduces this defect.

### M-7 — The citation excluding the three worker sites documents a different alert
*FN-07.* `alerts.md:159` is verbatim true and sits under
`## delivery.dead_lettered / webhook_delivery.dead_lettered` — the alert that
sentence contrasts *against* `audit-dead-letter`. The conclusion is right (both
FN and SE re-derived it from `recordError` at `:581-646` and the reaper at
`:1360-1395`); the reason on record is wrong, which is what licenses the next
edit. Also correct the `:1946` row: it goes to `PENDING` with backoff on that
pass, not `FAILED`.

### M-8 — C3's signature cannot perform C4's write
*FN-03.* `persistDeadLetter(entry: DeadLetterRecord)` cannot issue one
`createMany` for N entries, and `DeadLetterRecord`'s nested
`error: {name, code}` is assignable to neither Prisma input against C1's flat
`errorName`/`errorCode`. The ORM note's "the two shapes coincide" is true of the
two Prisma inputs and irrelevant to the assignment that must typecheck.
**Action**: lock `toDeadLetterRow()` + `persistDeadLetter` + `persistDeadLetters`
sharing one `withBypassRls` body. State that `id` comes from Prisma's client-side
`@default(uuid(4))` with no DB default (verified: `20260412100000_add_audit_outbox`
has no `DEFAULT`), so a future raw-SQL writer must supply it.

### M-9 — `team_id` has no producer and is the field that separates the two causes
*FN-04, SE-9, TE-10.* `deadLetterEntry` emits no `teamId`, so the column is
structurally always NULL. `resolveTenantId` tries the team branch **first**
(`audit.ts:172-177`), and a `tenant_not_found` there means a dangling or
cross-tenant team reference — a different and more security-relevant fault than
"this user has no tenant yet". An always-NULL `team_id` reads as positive
evidence that no team was involved. **Action**: add `teamId` to
`deadLetterEntry`, or drop the column and say why. Also unspecified: the
`error.name`/`error.code` → `error_name`/`error_code` flattening, on which
scenario 3 entirely depends.

### M-10 — The migration needs `BEGIN`/`COMMIT`
*FN-09.* `scripts/checks/check-migration-transaction.mjs` binds new migrations;
C1's SQL is six-plus top-level DDL statements. Unwrapped, a failure at statement
three leaves the table with no RLS enabled while the deploy proceeds. Note that
`DO $$ BEGIN … END $$` is a PL/pgSQL block opener, not a transaction opener.

### M-11 — Two existing gates fail on this change and are absent from the contracts
*FN-08, SE-8, TE-08.* `registry.test.ts:63` asserts exactly 6 `EXPIRY` entries;
`check-bypass-rls.mjs:93` allowlists `src/lib/audit/audit.ts` for
`["team","user","auditLog"]`. Both are deliberate-enrolment counters an
implementer resolves by widening the number. And C3-I4's claim that the gate
"enumerates purposes" is false — Check 2 is file-scoped and only asserts the
identifier `BYPASS_PURPOSE` appears (`:1147-1152`), which `audit.ts:191` already
satisfies. **Action**: name both edits as deliverables (`"auditDeadLetter"`
explicitly, never `"*"`), and restate C3-I4 as `detection or audit only`.

### M-12 — `audit-db-grants.mjs` cannot exit 0 without an unstated regeneration
*FN-05d, TE-07.* It exits 1 on `UNEXPECTED_GRANT` for any live grant absent from
the manifest, which every new grant is. The `--write` step is unnamed in the plan
— and the denylist's own `_comment` records that a blind `--write` is how a
revoked control was previously laundered. **Action**: name `--write`, require the
diff be reviewed in the PR, and assert the printed grant count rose by exactly
the number added. Also (SE-12): `audit-db-grants.mjs` runs in **no** workflow, so
C2's "fail-closed verification gate" is a manual step; CI runs only the
enforcement half (`bootstrap-rds-roles.mjs --denied-only`).

### M-13 — C2's forbidden pattern forecloses the correct denylist entry
*SE-7.* Banning any `passwd_retention_gc_worker` × `audit_dead_letter` entry
treats it as all-or-nothing; the file's shape is a `privileges` array, and the
correct entry is `["INSERT","UPDATE","TRUNCATE","REFERENCES","TRIGGER"]`, which
wedges nothing. `UPDATE` on this table by any role is evidence tampering.
Separately, the plan's stated reason for choosing option (a) is the weaker half:
`audit_log_purge` takes its cutoff **from the caller**, so copying that shape
buys no bound unless the routine clamps server-side. The real asymmetry is
narrower — for `audit_logs` the GC holds only `EXECUTE`, not raw `DELETE`.

### M-14 — Both unit mocks omit `prisma.auditDeadLetter`, making C3's criteria vacuous
*TE-01.* `src/lib/audit/audit.test.ts:5-10` and `src/__tests__/audit.mocked.test.ts:10-15`
mock the client to two delegates, so `prisma.auditDeadLetter` is `undefined` and
`.createMany` raises a `TypeError` that C3-I1's own catch swallows. Every stated
criterion stays green with no insert attempted — and the RT7 mutation ("remove
the try/catch") reddens for that unrelated reason, so it looks like a proof while
measuring nothing. **Action**: complete both mocks typed against the real client
type, and assert **positively** that the spy was called with the exact row.

### M-15 — No teardown reclaims `audit_dead_letter`
*TE-03.* `deleteTestData` (`src/__tests__/db-integration/helpers.ts:435-608`) and
`cleanup()`'s sweep are `WHERE tenant_id = $1::uuid`. The defining row has
`tenant_id` NULL and the column is `VarChar`, so the cast fails and no NULL row
matches either way. C4's "exactly one row" is a table-wide predicate on a shared
live database. **Action**: give every fixture row a `randomUUID()` discriminator
in `user_id`, scope both teardown and assertions by it, and register the delete
at acquisition (`onTestFinished`) so the abort path still reclaims.

### M-16 — Mutations: one is a no-op, one clause has none, one covers a four-member class
*TE-05.* Removing `WITH CHECK` changes nothing: for a permissive policy without
one, PostgreSQL uses the `USING` expression for `INSERT`, and C1's two
expressions are identical. C4's clause is *four* sites and one mutation is
offered. **C3-I2's log-line-first ordering has no mutation at all** — item 6 only
asserts the line "still happens", which a reversed order satisfies, and the only
stated enforcement is a grep over source text for a runtime ordering.
**Action**: replace the policy mutation with one that can differ (delete the
`CREATE POLICY`, or invert to `<> 'on'`) and say why the `WITH CHECK` deletion
was rejected; assert ordering via `invocationCallOrder`.

### M-17 — C5's integration case is a table-wide DELETE against the shared dev DB
*TE-06.* `globalDelete: true` means what `registry.ts:46-58` says. Running the
case on dev deletes every real dead-letter row past the cutoff — the evidence
table the plan exists to create — and VE2 forbids destructive operations.
**Action**: assert absence/presence **by primary key**, never a table-wide count
(the pattern `retention-gc-append-only-logs.integration.test.ts:85-90` already
uses), assert the fixture rows exist by id first, and record what a local run
costs.

---

## Minor

- **m-1** (FN-10, SE-11) `withBypassRls` throws `INVALID_RLS_NESTING` under an ambient `withTenantRls`; C3-I1's catch would swallow it and lose the row silently. Both experts independently derived **zero** current lexical call sites, so this is a question, not a defect. Closes by stating the precondition in C3 plus an AST assertion in C7 that refuses when it resolves zero `withTenantRls` files.
- **m-2** (FN-12) C5's boundary paragraph describes a tie at `now()`, not at the 90-day cutoff. Vacuous until C-1 lands.
- **m-3** (FN-13) C6 leaves `alerts.md:159`'s durability contrast falsified, and SC1 assigns the Fluent Bit exclusion an owner without saying where its "why it is safe to keep" explanation goes.
- **m-4** (FN-14, TE-09) Testing item 5 states an obligation the tree already satisfies — `setup.ts:51-55` already carries `passwd-sso-retention-gc-worker` with its `stop` command. Restate as a verified precondition, and record what it does not cover (a future competitor that sets no `application_name`).
- **m-5** (SE-10) The 90-day figure is not the bound: `scripts/backup-db.sh` keeps `BACKUP_RETAIN` full dumps, so rows outlive the window in backups. C5's `detection or audit only` also understates a recurring unscoped DELETE on an evidence table (R31 category g).
- **m-6** (SE-12) See M-12's second half.
- **m-7** (SE R55 note) For `reason = 'tenant_not_found'`, `tenant_id` is structurally always absent — a truthy `params.tenantId` short-circuits `resolveTenantId` at `:169`. Consumer 2's claim that the operator uses it "to see whether the value was absent or merely unresolvable" is not representable for that reason code.

## Verified, not findings

Recorded so the negatives are not read as unexamined.

- **R42 member set**: all three experts independently reproduced the 7-site sweep and confirmed the three worker exclusions via `recordError` (`:581-646`) and the reaper's `UPDATE … RETURNING` + `writeDirectAuditLogInTx` (`:1360-1395`). `account-lockout.ts:394` is a comment. M-6 is a *different* class the derivation did not reach, not an error in this one.
- **`user_id` VarChar(64) headroom**: an AST sweep of every audit call site found 12 distinct `userId` and 12 distinct `tenantId` expressions, all sentinels (36-char UUIDs) or DB-derived. No caller-controlled value reaches either today.
- **No generic read interception**: `src/lib/prisma.ts` has no `$extends`/`$use`, and `/api/tenant/audit-logs` and its download sibling read `audit_logs` only.
- **R54**: `withBypassRls` sets `app.bypass_rls` with `set_config(..., true)` (transaction-local) inside `prisma.$transaction`, and `tenantRlsStorage.run` bounds the store, so the suspension is call-scoped and reverts on the error path.
- **C3's control class**: `detection or audit only`, with "the event is still lost; what becomes durable is the record that it was lost" — all three experts called this correctly calibrated.
- **R24 / R15**: the migration is purely additive and uses no environment-dependent literal; the `format(…, current_database())` form matches `20260502000000:36-38`.

## Recurring Issue Check (consolidated)

Every expert returned all 57 lines plus their expert-specific set. Consolidated
to the lines that produced a finding or whose `Checked` status is cited above.

**Produced findings**: R1 (FN), R2 (SE), R3 (FN, SE), R5/R9 (FN m-1), R14 (all
three), R16 (SE), R17 (FN), R18 (all three), R19 (FN→TE, TE), R25 (FN, SE), R27
(SE), R29 (FN, SE), R31 (SE, TE), R34 (FN), R35 (SE), R40 (FN, SE), R41 (FN, TE),
R42 (FN), R43 (FN→SE, SE), R44 (TE), R47 (SE, TE), R48 (SE), R49 (FN, SE, TE),
R50 (FN, SE, TE), R52 (FN), R53 (SE, TE), R55 (SE note), RS3 (SE), RT1 (TE), RT4
(TE), RT5 (TE), RT7 (TE), RT8 (TE), RT10 (TE), RT11 (TE).

**`Checked` and load-bearing**: R6 (no FK by design, nothing cascades), R10 (no
new module edge), R13 (no re-entry into `logAuditAsync`), R24, R15, R32
(`validateRegistry` throws at worker boot), R51 (`assertIdentifier` validates the
registry's table name), R54, R57 (`keyColumns: ["id"]` is a total order for the
batch), RS4 (no PII reaches the row), RT2 (`ctx.app`, `ctx.retentionWorker` and
`appConnectionString()` all exist, so no finding is rejected as untestable), RT6
(the helper is module-private), RT9 (the twin risk is the two test files, not a
duplicated implementation).

**N/A across all three**: R4, R7, R8, R11, R21, R23, R26, R28, R30, R33, R38,
R39, R45, R46, R56, RS1, RS5.

## Round 1 disposition

Not saturated. Saturation requires two completed rounds, and requires no open
Critical or Major in any category — there are 4 Critical and 17 Major, all
against the design itself rather than the prose. Every one is actionable against
a named file and line.

The plan revision this implies is substantial rather than incremental: C-2
changes two production route handlers outside the original scope, C-1 changes a
shared worker's registry type and sweep SQL, C-3 renames a column, and M-2
changes the write shape at every call site. Round 2 must re-review the revised
plan, not the diff alone.

## Go/No-Go Gate

Every contract returns to `pending`. C1, C2, C3, C4, C5 and C6 all have a
Critical or Major finding that changes their signature, invariants, forbidden
patterns, or acceptance criteria.

| ID | Subject | Status |
|----|---------|--------|
| C1 | `audit_dead_letter` table, RLS policy, migration | pending (C-3, M-1, M-3, M-4, M-5, M-10) |
| C2 | Privilege policy + denylist + bootstrap convergence | pending (C-4, M-1, M-2, M-12, M-13) |
| C3 | `persistDeadLetter` helper | pending (M-8, M-9, M-11, M-14, M-16, m-1) |
| C4 | Route the in-class sites through C3 | pending (M-6, M-8, M-16) |
| C5 | Retention GC registry entry + window | pending (C-1, C-4, M-17, m-2, m-5) |
| C6 | Operator contract in alerts.md | pending (M-3, M-9, m-3, m-5, m-7) |
| C7 | Tests | pending (M-14, M-15, M-16, M-17) |
| C8 | *(new)* Pre-auth sentinel-actor audit sites | pending (C-2) |

---

# Round 2 — and the decision to discard this design

Date: 2026-08-31

Two of three experts returned (Functionality: 12 findings, 3 Critical;
Testing: 16 findings, 1 Critical, 12 Major). The Security round was stopped
mid-run once the decision below was taken — it was reviewing a design being
discarded, and its remaining budget bought nothing.

## The finding that matters is the SHAPE, not the count

Every round-2 Critical landed **inside a round-1 fix**:

| Round-2 Critical | Round-1 fix that produced it |
|---|---|
| FN-F-01 / TE-11 | M-6's fix (add `writeDirectAuditLogBestEffort` as a fifth member) collides with M-2's fix (deny `passwd_outbox_worker` every privilege). The worker cannot import `@/lib/audit/audit` — the app Prisma singleton throws at module load with `DATABASE_URL` unset, documented at `sweep.ts:102-110` and `audit-outbox-worker.ts:29-33` — and it is denied the INSERT. The member is named and nothing is closed for it. |
| FN-F-02 | C2's fix moved the grants into the migration (M-1) with `REVOKE ALL … FROM passwd_app` unguarded. `ci-integration.yml:120` and `ci.yml:567` run `prisma migrate deploy` **before** the role exists (`:158-163`, and the E2E job never creates it). `42704` aborts the `BEGIN/COMMIT` migration, so the table is never created and two CI jobs fail. All four sibling migrations guard it. |
| FN-F-03 | C5's fix (`ExpiryEntry.retentionDays`) reinstates C-1's tautology: the value is `envInt("OUTBOX_FAILED_RETENTION_DAYS", 90)` with `min = 0`, `0` is admissible **and falsy**, the branch is a truthiness test, and `validateRegistry` has no rule for the field. `OUTBOX_FAILED_RETENTION_DAYS=0` renders `created_at < now()` again. |
| FN-F-04 / TE-23 | C8's fix relocates unauthenticated-request records from a 90-day table to `audit_logs` under `SYSTEM_TENANT_ID`, whose `audit_log_retention_days` is NULL (`20260428170853:40-48`) and which `sweepAuditLogs` skips (`sweep.ts:368-371`). Requirement 7 is met for the new table by moving the growth somewhere unbounded. |

Two experts reached FN-F-01/TE-11 and FN-F-04/TE-23 independently.

## Why this is a scope signal, not slow convergence

`feedback_rounds_that_seed_their_own_defects_mean_wrong_scope` describes exactly
this, and its recorded case is **this work's predecessor**:
`fix/audit-dead-letter-bound`, local-only, agreed-discarded after four rounds
still carrying 1 Critical and 2 Major.

The non-convergent shape here is the same one that rule names: the design treats
"an audit event whose tenant does not resolve" as an exceptional failure and
builds it a new home. Each element of that home opens the next — a table needs
RLS, RLS needs grants, grants need the role bootstrap, the bootstrap needs CI
ordering, retention needs a shared worker type, the shared type needs a
validator, the column name collides with a parity assertion, denying `SELECT`
forces the write shape, and the fifth class member turns out to live in a process
that cannot reach any of it.

## The convergent direction

Not a new home — **remove the state**. `resolveTenantId`
(`src/lib/audit/audit.ts:168-192`) returns `null` on three paths (team miss, user
miss, non-UUID `userId`), and that `null` is the sole cause of the enqueue-less
return at `:283` / `:368`. Falling back to `SYSTEM_TENANT_ID` makes the branch
unreachable and the event lands in the existing outbox, which already has RLS,
grants, a retention entry, a worker and an anchor lineage.

Verified before proposing it: the sentinel `tenants` row exists with zero
memberships, so no tenant can read it (`20260428170853:35-48`);
`SYSTEM_TENANT_ID` already carries `audit_logs` rows from the anchor publisher
(`audit-anchor-publisher.ts:118,197`) and the retention GC (`sweep.ts:752`).

What that removes: the table, the RLS policy, the grants, the denylist entries,
the bootstrap change, the `ExpiryEntry` change, the new gate, the column-parity
dodge, the `createMany`-everywhere cascade, and C8 — which is subsumed rather
than fixed.

What it does **not** close, stated rather than elided: the two `catch`-arm
emissions (`audit.ts:292`, `:379`). If the enqueue itself failed, no durable
write is available; the log line remains the only record, as today. That residue
is narrow and honest, where the discarded design's residue was a growing set of
new mechanisms.

What it still owes: `audit_log_retention_days` on the sentinel tenant
(FN-F-04 / TE-23 applies to both designs), and the anchor-chain interaction a
retention purge causes (`registry.ts:490-494` cites
`docs/security/audit-chain-threat-model.md#retention-purge-interaction`).

The objection the user weighed and accepted: routing every unresolvable-tenant
event to `__system__` means a tenant's own audit view will not show it. The
`userId` is preserved on the row, so the information is not lost — but it is not
where a tenant would look for it.

## Disposition

This design is discarded, not iterated. Round 3 was not run. The plan file is
replaced by the cause-side design; this artifact is kept in full because the
36 + 28 findings are the evidence for why the smaller design is the right one,
and re-deriving them would cost three more parallel reviews.

Contracts C1-C9 of the discarded design are void. Nothing from it is
cherry-picked: the replacement is written fresh.

---

# Phase 3 — code review of the branch, and what it changed

Date: 2026-08-31. Three experts over `git diff main...HEAD`.
Functionality: 12 findings (1 Critical). Security: 8 (0 Critical) — it traced
every read surface and confirmed the access boundary holds. Testing: 11.

Two experts reached the Critical independently.

## Acted on in `9f532706e` and the follow-up

| Finding | What it was |
|---|---|
| **FN-M2** | The regression. `resolveTenantId` returning null also held `audit-outbox-worker.ts:1959-1970`'s invariant (a payload failing `UUID_RE` must not enter the outbox). Encoding "no owning tenant" removed that side effect without replacing it, so a malformed `userId` would have enqueued a poison row that retries to `max_attempts` and dead-letters — worse than the warn line it replaced. Now rejected at the caller under its own reason, `invalid_user_id`, because it is a different fault: the tenant is unknowable in the unattributable case; here the caller is wrong. |
| **FN-M1** | The comment that hid it: "a non-UUID userId is a sentinel actor". Sentinels ARE UUIDs, and the guard ten lines above in the same function says so. |
| **FN-C1 / SE-S1** | `/api/extension/bridge-code` is a third pre-auth emitter, and its emit sits on the rate limiter's REFUSAL arm — the limiter refuses the response, not the emit, so past the limit each request cost a durable row under a tenant with no retention and no application-reachable delete path. Removed from that arm only; the other three pre-auth arms run only after the limiter allowed the request. |
| **FN-M4 / SE-S2** | The `alerts.md` replacement query filtered `actor_type <> 'SYSTEM'` on a premise that four of the five emitters break. `ip` does not separate them either — the retention GC forwards `last_used_ip`. Now groups by action and names the routine ones, which needs no maintained predicate. |
| **FN-C2 / SE-S5** (partial) | Three comment blocks that contradicted their own files: `auth-adapter.ts:56-64` vs `:297`, `tenant-management.ts:281` vs `:362`, and `bridge-code-failure.ts`'s docblock. |
| **TE-T1** | The gate's three `fail()`-routed refusals asserted stderr only. Red-proved by the reviewer: `fail()` exiting 0 leaves the message byte-identical and all three green, while `queue_step` — which reads only the exit code — reports PASS. Exit status now asserted. |
| **TE-T9** | The pre-pr wiring assertion was open-ended, so `… .mjs \|\| true` and `--warn-only` satisfied it. Anchored at both ends. |
| **FN-m3** | Gate header said 1042 files; measured 1040 on both trees, and the commit message said 1040. |

## Open, with the reason each is open

Recorded here rather than implied. Every one is grounded in a named file:line by
the reviewer who filed it.

**Reconciliation note (C11).** This section was written as part of `e3f50de5e` itself, and no commit
since has touched the source it names — so every item below is **still open**, verified individually
rather than assumed from that fact.

**Test coverage** — the branch's weakest axis, and the findings are correct:
- **TE-T2** `tenantId: SYSTEM_TENANT_ID` at both pre-auth sites is asserted by nothing. `objectContaining` ignores extra keys and `AuditLogParams.tenantId` is optional, so deleting it compiles and leaves three tests green.
  **Still open** — `src/app/api/extension/token/route.test.ts:155` and `src/app/api/mcp/register/route.test.ts:481` both still assert through `expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, ... })`, which remains extra-key-tolerant.
- **TE-T3** A THIRD suite drives `logAuditAsync` (`src/__tests__/audit.mocked.test.ts`); it spreads the real `@/lib/tenant-rls` over a `prisma` mock with no `$transaction`, so every no-`tenantId` case dies as a `TypeError` inside `resolveTenantId` and lands in the catch arm. The "both suites" claim in the previous commit undercounted. (FN-m4 notes the same file never asserted the old branch, so it needed no change — both are true: it needs a mock fix, not a behavioural one.)
  **Still open** — `src/__tests__/audit.mocked.test.ts:17` still spreads the real `@/lib/tenant-rls` via `importOriginal` over a `prisma` mock carrying no `$transaction`.
- **TE-T4 / FN-M3** The new integration file proves FK acceptance by proxy: three read-only SELECTs, no `logAuditAsync`, no INSERT. The plan's own acceptance criterion (`plan:158`) asked for the write.
  **Still open** — `src/__tests__/db-integration/audit-unattributable-tenant.integration.test.ts` still contains exactly three read-only `it` blocks (`SELECT id`, `SELECT COUNT(*)`, `SELECT audit_log_retention_days`); no `logAuditAsync` call and no INSERT.
- **TE-T5** The `audit_log_retention_days IS NULL` pin has no differential. The previous commit claimed its red-proof needs a write to the shared dev database; the reviewer showed that is wrong — `ctx.createTenant()` hands out an isolated tenant swept by `cleanup()` even on the failure path.
  **Still open** — unchanged; the pin in the integration file above still has no differential.
- **TE-T6** Five test comments still carry the pre-change premise.
  **Still open** — no commit since `e3f50de5e` has touched those comments.
- **TE-T7/T8/T10/T11** A stale test name that now states the opposite of its body; the `scanned 0` refusal unreached by any case; `unallocatablePid()`'s Linux path returning without the probe its docblock promises; and a question about the backup-db red-proof's count.
  **Still open** — no commit since `e3f50de5e` has touched these sites.

**Design questions, deliberately not decided here:**
- **SE-S3** Sentinel rows are never purged AND `claimBatch` is a global FIFO, so sentinel volume delays every tenant's audit delivery. Two independent fixes; the retention half is the `TODO(audit-dead-letter-durability)` already in `audit.ts`, and it is entangled with the chain-verify false-TAMPER interaction.
  **Still open** — both `TODO(audit-dead-letter-durability)` markers remain verbatim at `src/lib/audit/audit.ts:196-199`.
- **SE-S4** "Zero `tenant_members`" is the load-bearing read-side invariant and nothing enforces it — `scripts/tenant-domain.ts`'s `resolveTenantRef` accepts a bare UUID with no sentinel refusal. Pre-existing, and this change is what makes it worth closing.
  **Still open** — `scripts/tenant-domain.ts:198` still returns `tx.tenant.findUnique(...)` for any UUID-shaped ref; the file contains no sentinel/`SYSTEM_TENANT_ID` refusal. (C12 on the `audit-sentinel-verification-gaps` branch takes the write-side half of this invariant; the read-side refusal named here is not in that scope.)
- **SE-S6** If `audit_chain_enabled` is ever set fleet-wide, the sentinel's unbounded chain passes `MAX_ROWS_PER_TENANT` and pins `CHAIN_VERIFY_FAILED`.
  **Still open** — no bound was added; `MAX_ROWS_PER_TENANT` has no sentinel-aware handling in `src/workers`.
- **SE-S7** The gate anchors on `metadata`; `targetType`/`targetId`/`userAgent` reach the same row unmodelled.
  **Still open** — `scripts/checks/check-audit-metadata-narrative.mjs:128` still pins the single property `const SINK_PROPERTY = "metadata";`.
- **FN-a1** The synchronous audit line logs the SUPPLIED tenant, not the resolved one, so it says `null` where the row says the sentinel. Fixing it means moving the emit after `resolveTenantId`, which changes the documented "synchronous, before outbox write" ordering — a design decision, not a one-liner.
  **Still open** — `src/lib/audit/audit.ts:314` still emits `tenantId: params.tenantId ?? null` before `resolveTenantId(params)` runs at `:341`.

**Remaining stale prose** — re-derived rather than taken from the reviewers'
lists, which surfaced sites neither named:
`src/auth.ts:111`, `:227`, `:640`; `auth-adapter.ts:379`;
`tenant-management.ts:362`; `unsafe-display-chars.ts:81`;
`auth-failure.ts:173`; `docker-compose.yml:21-22`;
`infra/fluent-bit/fluent-bit.conf:47`; and `audit.ts`'s Bucket C list (FN-m2),
which still names `/api/mcp/register` as relying on `resolveTenantId`.

Derivation:
`grep -rn "dead-letter\|DEAD-LETTER\|without enqueuing\|returns WITHOUT" src docs infra docker-compose.yml`

That the member set grew each time it was re-derived — two sites, then five,
then ten — is the finding, not the count.

**Still open, and the member set is now mixed** — re-checked site by site rather than as a block:
- `docker-compose.yml:21-22` and `infra/fluent-bit/fluent-bit.conf:47` are **genuinely stale**:
  neither file is in `e3f50de5e`'s changed-file list, and the compose comment still claims the
  app-side path "returns without enqueuing anything, making stdout the only copy" — exactly the
  behaviour that commit removed at its cause.
- `src/lib/audit/audit.ts`'s Bucket C list (FN-m2) is **still inaccurate**: it names
  `/api/mcp/register` as relying on `resolveTenantId`, but `src/app/api/mcp/register/route.ts:200`
  now passes `tenantId: SYSTEM_TENANT_ID` directly and never calls it.
- `auth-adapter.ts`, `tenant-management.ts` and `auth-failure.ts` were rewritten by `e3f50de5e`
  itself and already carry post-fix language, so they are **no longer stale** — the original entry
  over-collected. Their line numbers have drifted by 2-5 lines (`auth-adapter.ts` → `:381`,
  `tenant-management.ts` → `:367`); both still land inside the intended comment block, so the
  citations are left as filed.
- `src/auth.ts:111`, `:227`, `:640` and `unsafe-display-chars.ts:81` are untouched by `e3f50de5e`
  and read as historical incident narrative rather than claims about current behaviour; not
  adjudicated stale here.
