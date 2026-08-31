# Durable dead letters — plan (cause-side design)

Closes the KNOWN GAP at `src/lib/audit/audit.ts:271`.

**This replaces a discarded design.** The first two rounds are recorded in
`audit-dead-letter-durability-review.md`, including why they were stopped: every
round-2 Critical landed inside a round-1 fix, which
`feedback_rounds_that_seed_their_own_defects_mean_wrong_scope` identifies as a
scope signal rather than slow convergence — and whose recorded case is this
work's own predecessor branch. Contracts C1-C9 of that design are void. Nothing
is cherry-picked from it; this is written fresh.

## Project context

- **Type**: service / web app (Next.js 16 + Prisma 7 + PostgreSQL 16) plus worker
  processes.
- **Test infrastructure**: unit (vitest) + real-DB integration + E2E + CI/CD + 76
  `scripts/checks` gates.
- **Verification environment constraints**
  - **VE1** — no Fluent Bit / SIEM here. Nothing below rests on a record reaching
    a log sink; that dependency is what this change removes.
  - **VE2** — the dev database is shared and live. Forward-only migrations.
  - **VE3** — integration tests cannot share a database with the compose workers;
    `setup.ts:51-55` already refuses on `application_name`, and detects only
    competitors that set one.
  - **VE4** — RDS role bootstrap is not runnable here. **This design issues no
    grants and creates no role**, so no contract is `blocked-deferred` on it.

## Objective

Make the record of a lost audit event survive independently of log retention.

## The gap, and where the previous design went wrong

`logAuditAsync` / `logAuditBulkAsync` resolve a tenant before enqueuing; when
resolution returns null they emit one `deadLetterLogger.warn` and **return
without enqueuing** (`audit.ts:283`, `:368`). No `audit_outbox` row, no
`audit_logs` row. The shipped forwarder drops the line
(`infra/fluent-bit/fluent-bit.conf:51`) and the host copy is capped at 20m × 5
(`docker-compose.yml` `x-logging`).

The discarded design read that as "these records have no home" and built one. The
cause is one level up: `audit_logs.tenant_id` and `audit_outbox.tenant_id` are
`NOT NULL`, so **"no owning tenant" needs an encoding**, and this tree already
has one.

### The position this changes, and why it is not what that position forbids

Two places record a deliberate, round-3-reviewed decision that dead-lettering is
correct here — `src/lib/auth/session/auth-adapter.ts:288-300` and
`src/lib/tenant/tenant-management.ts:275-285`. The auth-adapter's wording:

> `claim_invalid` has no owning tenant by construction — an unstorable claim
> belongs to nobody — and a first-ever sign-in has no user row either, so
> `resolveTenantId` finds nothing and `logAuditAsync` DEAD-LETTERS it: the
> synchronous structured log line is the durable record. There is nothing to bind
> it to; stating that is the honest position, and inventing a binding would file
> the denial under a tenant that has nothing to do with it.

What that position protects is real and is preserved here: **a denial must not
appear in an unrelated tenant's audit log.** `SYSTEM_TENANT_ID` has zero
`tenant_members` (`20260428170853:35-48`) and `/api/tenant/audit-logs` scopes by
membership, so no tenant ever sees these rows. Binding to `__system__` is not
"filing the denial under a tenant" — `__system__` is not a tenant anyone
occupies; it is the representation of "no owning tenant" in a column that cannot
be null, and the anchor publisher (`audit-anchor-publisher.ts:118`, `:197`) and
the retention GC heartbeat (`sweep.ts:752`) already use it that way.

The half of that position which does **not** survive is its premise: *"the
synchronous structured log line is the durable record."* It is not, and
`audit.ts:271` is the record of it not being — the shipped forwarder excludes it
and the host copy is capped. Both comments are rewritten as part of this change
rather than left contradicting it; that is work, not a side effect.

Attribution stays honest in the row itself: `userId` and `actorType` say who
acted, and `__system__` says no tenant owns it — where today the event says
nothing at all because it does not exist. `tenant-domain unmapped`, which groups
by `tenant_id` on both tables (`tenant-management.ts:281`), moves from showing
nothing to showing these under `__system__`.

`SYSTEM_TENANT_ID` (`src/lib/constants/app.ts:71`) exists, has zero
`tenant_members` so no tenant-admin endpoint can elevate to it
(`20260428170853_add_dcr_cleanup_worker_role_and_system_tenant/migration.sql:35-48`),
and already carries `audit_logs` rows from the anchor publisher
(`audit-anchor-publisher.ts:118`, `:197`) and the retention GC's heartbeat
(`sweep.ts:752`).

## Member-set derivation (R42)

The class is **a code path that drops an audit event and leaves only a log
line**.

```
grep -rn "deadLetterLogger\." src scripts --include="*.ts" | grep -v "\.test\." | grep -v "__tests__"
grep -rn "BestEffort" src/workers/audit-outbox-worker.ts
```

| Site | Durable counterpart | Closed by this design |
|---|---|---|
| `audit.ts:283` `tenant_not_found` (single) | none | **yes** — N1 makes the branch unreachable |
| `audit.ts:368` `tenant_not_found` (bulk) | none | **yes** — same |
| `audit.ts:292` `logAuditAsync_failed` | none — the enqueue is what failed | **no** — see Residue |
| `audit.ts:379` `logAuditBulkAsync_failed` | none | **no** — see Residue |
| `audit-outbox-worker.ts:561-579` `writeDirectAuditLogBestEffort` | none — swallows into a `warn` | **no** — see Residue |
| `audit-outbox-worker.ts:1400` reaper | row at `FAILED`, co-committed audit via `writeDirectAuditLogInTx` (`:1360-1395`) | n/a — not in class |
| `audit-outbox-worker.ts:1946` invalid userId | `recordError` (`:581-646`) persists `last_error` + `attempt_count` | n/a |
| `audit-outbox-worker.ts:2009` max attempts | `recordError`, terminal transition | n/a |

Not `alerts.md:159` for the exclusions — that documents `delivery.dead_lettered`,
the alert the sentence contrasts *against*.

---

## Contracts

### N1 — `resolveTenantId` attributes the unattributable

```ts
async function resolveTenantId(params: AuditLogParams): Promise<string>;
```

Return type narrows from `string | null` to `string`. The three `null` paths
(`audit.ts:177`, `:187`, `:190` — team miss, user miss, non-UUID `userId`) return
`SYSTEM_TENANT_ID`.

**Invariants**

| # | Invariant | Enforcement |
|---|---|---|
| N1-I1 | Every audit event reaches the outbox | **type-enforced** — the narrowed return type makes the `if (!tenantId)` branches dead code the compiler rejects, so they are deleted rather than left unreachable |
| N1-I2 | An unattributable event is distinguishable from a genuine `__system__` event | app-enforced — the row keeps its `userId`, `teamId` and `actorType`; a real `__system__` emission carries `SYSTEM_ACTOR_ID`, an unattributable one carries the caller's actor |
| N1-I3 | No tenant can read `__system__`'s audit rows | **enforceable boundary**, pre-existing — zero `tenant_members`, and `/api/tenant/audit-logs` scopes by membership |

N1-I1 is why the return type changes rather than the call sites gaining a
fallback: a `?? SYSTEM_TENANT_ID` at each of two call sites is two places to
forget. Narrowing the type makes the compiler delete the branch.

**Also in scope, not a side effect** — the two comments that record the
superseded position must be rewritten in the same change:
`src/lib/auth/session/auth-adapter.ts:288-300` and
`src/lib/tenant/tenant-management.ts:275-285`. Leaving them would leave the tree
asserting that these events dead-letter and that the log line is their durable
record, both of which stop being true. `src/lib/security/rate-limit-audit.ts:12`
and `src/lib/audit/auth-failure.ts:197` reference the same behaviour and are
checked too. Derivation, not a list:
`grep -rn "dead.letter\|DEAD-LETTER" src --include="*.ts" | grep -v "\.test\."`.

**Control class (R49)**: `detection or audit only`. This denies nothing. It
changes where an unattributable event is recorded, from nowhere to
`__system__`.

**Forbidden patterns**
- `pattern: deadLetterEntry\(params, "tenant_not_found"\)` — reason: the branch is gone; a surviving occurrence means one call site was missed.
- `pattern: Promise<string \| null>` on `resolveTenantId` — reason: N1-I1.

**Acceptance criteria**
- `npx tsc --noEmit` (via `npx next build`) fails if either `if (!tenantId)` branch is left in place — the narrowed type is what makes that a compile error rather than dead code.
- Integration, driving the real `logAuditAsync`: a `userId` that resolves to no tenant produces exactly one `audit_outbox` row with `tenant_id = SYSTEM_TENANT_ID` and the caller's `userId`, and **zero** `audit-dead-letter` log lines.
- Allow side: a resolvable tenant still enqueues under **its own** tenant id, not `__system__`. Pin it, or a fallback that fires unconditionally passes every other clause.
- The non-UUID `userId` path and the team-miss path each get their own case; they are different branches of `resolveTenantId` and a single case covers one.

---

### N2 — The two pre-auth sites state their tenant explicitly

`src/app/api/extension/token/route.ts:61-67` and
`src/app/api/mcp/register/route.ts:189-197` pass a sentinel `userId` with no
tenant. No `users` row exists for the sentinels (no migration or seed inserts
one), so both are unconditional `tenant_not_found` today.

N1 already routes them to `__system__`. They still gain an explicit
`tenantId: SYSTEM_TENANT_ID`, because relying on the fallback makes an
intentional system-scoped emission indistinguishable from an accident, and
`resolveTenantId`'s short-circuit at `:169` also saves both a DB round trip on a
pre-auth path.

Their comments assert the dead-letter behaviour this removes
(`extension/token/route.ts:59-60`) and must be corrected.

**Acceptance criteria**
- Both sites' emissions land in `audit_outbox` under `SYSTEM_TENANT_ID`.
- `resolveTenantId` is not called on either path — assert the short-circuit, so a later edit that drops the explicit tenant is visible as a behaviour change rather than absorbed by N1.

---

### N3 — Sentinel-tenant growth

N1 and N2 route unattributable events, including two pre-auth ones, into
`audit_logs` under `SYSTEM_TENANT_ID`. `sweepAuditLogs` enumerates only tenants
with `auditLogRetentionDays IS NOT NULL` (`sweep.ts:368-371`), and the sentinel
row is inserted without it, so those rows are never purged.

This is **not new** — the anchor publisher and the retention GC heartbeat already
accumulate there unbounded. N1 raises the rate; it does not create the class.

Two options, and this plan states the decision rather than assuming it:

- **(a) Leave `audit_log_retention_days` NULL.** The bound is the two routes'
  rate limiters (`extension/token/route.ts:41-57` with `boundUnknownIp: true`;
  `mcp/register/route.ts` DCR limit plus the unclaimed-client cap) plus
  authenticated audit volume. Rate-limited-forever still integrates to unbounded.
- **(b) Set it to `AUDIT_OUTBOX.FAILED_RETENTION_DAYS`.** Bounds the growth, and
  incurs the documented, test-verified chain-verify interaction: `audit_log_purge`
  does not touch `audit_chain_anchors` or renumber `chain_seq`, so a default
  `fromSeq=1` verify after a purge re-seeds from genesis and reports a FALSE
  TAMPER at the first retained row (`registry.ts:487-494`, citing
  `docs/security/audit-chain-threat-model.md#retention-purge-interaction`).

**Chosen: (a)**, with the limiters named as the bound and a `TODO` filed. Reason:
(b) trades an unbounded-growth risk that is already present for a false-TAMPER on
the tamper-evidence surface, on the one tenant whose chain nothing else verifies
routinely. That is a worse trade on an evidence system, and it is a decision
about the anchor chain rather than about dead letters — it belongs to whoever
owns that threat model, not to this change.

`TODO(audit-dead-letter-durability): decide __system__ audit_logs retention
against the chain-verify false-TAMPER interaction.`

**Acceptance criterion**: a test asserting `audit_log_retention_days IS NULL` for
`SYSTEM_TENANT_ID`, so option (b) cannot be adopted silently by a later migration
without this decision being revisited.

---

### N4 — Operator contract

Replace the known-gap block at `docs/operations/alerts.md:120-149`.

- `tenant_not_found` no longer occurs; the remaining `audit-dead-letter` reasons are `logAuditAsync_failed` and `logAuditBulkAsync_failed`, which mean the database was unreachable — state that, because it changes the recovery action.
- Unattributable events are now findable: `SELECT … FROM audit_logs WHERE tenant_id = '<sentinel>' AND user_id = …`.
- `alerts.md:159`'s "Unlike `audit-dead-letter`, the record itself is durable" contrast still holds for the two remaining reasons, so it is left alone — an improvement over the discarded design, which falsified it.
- The Fluent Bit exclusion may stay: the two remaining reasons fire only when the database is unreachable, and in that state no durable record is possible by any design.
- Every reason token greppable in `audit.ts` (R29).

---

### N5 — Residue, stated rather than elided

Three sites stay open and this plan says so rather than implying closure:

- `audit.ts:292`, `:379` — the `catch` arms. The enqueue itself failed, so no
  durable write is available. The log line remains the only record, as today.
- `audit-outbox-worker.ts:561-579` — `writeDirectAuditLogBestEffort` swallows an
  `audit_logs` write failure into a `warn`. Closing it needs a durable store the
  worker can reach, which is the design just discarded; the worker cannot import
  `@/lib/audit/audit` (the app Prisma singleton throws at module load with
  `DATABASE_URL` unset — `sweep.ts:102-110`, `audit-outbox-worker.ts:29-33`).

`TODO(audit-dead-letter-durability): the three database-unreachable dead-letter
sites remain log-only.`

This residue is smaller in kind, not just in count: all three require the
database to be unavailable, which is the one condition under which no durable
write can succeed. The discarded design's residue was a growing set of new
mechanisms, each of which opened the next.

---

## Consumer-flow walkthrough

The shape produced is an ordinary `AuditOutboxPayload` / `audit_logs` row — no
new shape is introduced, so the walkthrough covers the changed field only.

- **`audit-outbox-worker`** reads `tenant_id` to set `app.tenant_id` and to satisfy the FK. `SYSTEM_TENANT_ID` exists, so `enqueueAuditInTx`'s existence check (`audit-outbox.ts:34-40`) passes rather than throwing.
- **`audit-anchor-publisher`** groups by tenant and already emits under `SYSTEM_TENANT_ID`; the new rows join an existing lineage rather than creating one.
- **`/api/tenant/audit-logs`** scopes by `tenant_members`, of which the sentinel has none — so the rows are invisible to every tenant, which is the intended access boundary and is unchanged by this plan.
- **Operator SQL** (N4) reads `tenant_id`, `user_id`, `team_id`, `action`, `created_at`. All are existing columns.

## Testing strategy

1. **Integration, real `logAuditAsync`** — `rate-limit-fail-closed.integration.test.ts:4` is the precedent for driving it unmocked. A mocked emitter cannot show which tenant the row landed under.
2. **Allow side pinned** (Remedy Floor 1): a resolvable tenant still enqueues under its own id. Without it, an unconditional fallback passes.
3. **One mutation per clause, executed** (Remedy Floor 2): (i) revert the team-miss path → that case reddens, the user-miss case stays green; (ii) revert the user-miss path → the mirror; (iii) revert the non-UUID path → the third; (iv) drop N2's explicit tenant at one site → the short-circuit assertion reddens while the row still lands under `__system__` via N1, which is what distinguishes N2 from N1.
4. **Fail loudly** (Remedy Floor 3): the integration case asserts the `audit_outbox` row exists *before* asserting its tenant, so "the route never ran" is not spelled like "the fallback worked".
5. **Both unit mocks** — `src/lib/audit/audit.test.ts` and `src/__tests__/audit.mocked.test.ts` are two suites over one module. Both assert the current `tenant_not_found` dead-letter behaviour (`audit.test.ts:326-345`) and both must change together; changing one leaves the other asserting a branch that no longer exists.
6. **Teardown**: rows land in `audit_outbox` / `audit_logs`, both tenant-keyed, so `deleteTestData` reclaims them — the discarded design's untouchable-row problem does not arise. Sentinel-tenant rows are the exception: scope assertions by `user_id` and a captured start instant, not by a table-wide count.

## Considerations

### Scope contract
- **SC1** — the Fluent Bit exclusion stays; N4 records why.
- **SC2** — `writeDirectAuditLogBestEffort` and the two `catch` arms (N5).
- **SC3** — `__system__` audit-log retention (N3, option (b)).
- **SC4** — no backfill: historical dead letters were only log lines.

### Risks
- **R-1**: unattributable events accumulate under `__system__` with no retention (N3, accepted with the limiters named).
- **R-2**: an operator reading `__system__`'s audit log now sees two kinds of row — genuine system emissions and unattributable ones. N1-I2 says how to tell them apart; N4 documents it.
- **R-3**: a bug that makes tenant resolution fail broadly would now silently attribute real tenants' events to `__system__` instead of dead-lettering them. Before this change those events were lost entirely, so this is strictly better — but it is quieter, and the `audit-dead-letter` alert no longer fires for it. N4 must say what replaces that signal: a rising `__system__` row count with non-`SYSTEM_ACTOR_ID` actors.

### No concurrency-control primitive
No isolation level, lock, or `SELECT … FOR UPDATE` is introduced. `resolveTenantId`
already runs inside `withBypassRls`; this changes its return value, not its
transaction shape.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| N1 | `resolveTenantId` returns `SYSTEM_TENANT_ID` instead of `null` | pending |
| N2 | The two pre-auth sites pass the tenant explicitly | pending |
| N3 | Sentinel-tenant growth: option (a), pinned by a test | pending |
| N4 | Operator contract in alerts.md | pending |
| N5 | Residue recorded with a grep-able TODO | pending |
