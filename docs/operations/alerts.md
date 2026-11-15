# Operational Alert Hooks

Audit-pipeline events that should drive operator alerts. These are
emitted by the application/workers via pino structured logs (and
Sentry for error-level events). Pipe pino → your SIEM, then add the
rules below.

Every error- and fatal-level pino log under `src/workers` and `scripts`
carries a `_logType` string drawn from the namespaces declared below.
Match on that. It is enforced by `scripts/checks/check-worker-logtype.mjs`,
not merely stated here — when it was only stated, 22 of the 25 error-level
worker logs did not carry one, and the three that did were the three
somebody had written a rule for. Re-derive with:

```bash
git archive main@{the ref you are comparing against} | tar -x -C "$T"
WORKER_LOGTYPE_ROOT=$T WORKER_LOGTYPE_DIRS=src/workers \
  WORKER_LOGTYPE_FIXTURE_MODE=1 node scripts/checks/check-worker-logtype.mjs
```

Three things that field does **not** cover, all deliberate:

- **Modules outside `src/workers` and `scripts`**, even when a worker
  calls into them. The gate's class is the two directories plus any file
  named individually in its `SEARCH_DIRS`; `src/lib/webhook-dispatcher.ts`
  is named there because the outbox worker drives it. A `src/lib` module
  that only ever runs in a request is deliberately out — pulling all of
  `src/lib` in would make the gate a wall and get it routed around.

- **warn/info levels.** The named sections below include the warn-level
  events worth alerting on; anything else at warn is routine. The
  boundary is severity, and widening the rule to warn would put ordinary
  worker chatter under an alert.
- **printf lines written with `console`**, which are not structured
  records at all. `CHAIN_VERIFY_FAILED` (below) is the one that matters;
  match it on raw stderr text.

**`_logType` is single-valued.** It used not to be: the app logger set
`_logType: "app"` in its pino `base`, and a call site naming an alert
identifier set `_logType` too, so every alert line went out with the key
twice —

```json
{"level":50,"_logType":"app",...,"_logType":"worker.pool.error","msg":"..."}
```

— and every rule below silently depended on the consumer resolving
duplicate names last-wins. Go's `encoding/json` (Loki) and JavaScript's
`JSON.parse` do; a first-wins or reject-duplicates parser would have seen
`app` and matched nothing, with that silence reading exactly like a
healthy pipeline. The stream label now lives on `_stream`, so the two
facts no longer share a key and no rule here depends on parser
behaviour. Pinned by `src/__tests__/logger.test.ts`, which asserts on the
raw line rather than the parsed record — `JSON.parse` is last-wins and
would hide the very defect that case exists for.

Audit lines are unaffected: they come from a separate pino instance
(`src/lib/audit/audit-logger.ts`) whose base carries `_logType: "audit"`
and which no call site overrides.

## Catch-all: any worker error

Every `_logType` emitted by a worker begins with one of the namespaces in
the marker below, and this is the rule that catches the ones without a
named section of their own — including ones added after this document was
last read.

<!-- alert-namespaces: worker delivery webhook_delivery retention-gc audit-anchor-publisher outbox -->

That marker is not documentation. `scripts/checks/check-worker-logtype.mjs`
**reads the namespace set from it** and rejects any worker error log whose
`_logType` falls outside it, so the list here is the one place it exists.
Adding a namespace to the code means adding it here first; the build says
so. (The first version of that gate only checked the field was *present*,
which is how `outbox.*` came to be emitted outside this list and matched
by nothing but its hand-written sections below.)

Most members are error-level, meaning some part of the audit or retention
pipeline failed and did not complete its work. Two — the dead-letter pair
below — are warn-level; the queries here carry no level filter, so those
match both this rule and their own section.

**Severity**: high
**Trigger**: any occurrence
**Recovery**: read the message identifier — it names the operation that
failed — then `error.code` on the same line.

`error` is `{name, code}`, never the caught Error: pino's default `err`
serializer emits `message` and `stack`, and a pg pool error's message
carries the role name and connection target while a Prisma error's
carries the failing query. `error.code` is the driver's SQLSTATE or
errno where one exists (`src/lib/logger/error-fields.ts` resolves it
through `pgErrorCode`, so a Prisma wrapper does not hide it), and
`"unknown"` when the caught value carried no token-shaped code. A
narrative is deliberately not available here — reproduce locally if the
code alone is not enough.

Datadog: `{ _logType=~"(worker|delivery|webhook_delivery|retention-gc|audit-anchor-publisher|outbox)\\..*" }`
Loki: `{_logType=~"(worker|delivery|webhook_delivery|retention-gc|audit-anchor-publisher|outbox)\\..*"} | json`

Note that `worker.pool.error` fires on transient connection drops and is
the one member of this set with a meaningful benign rate. Alert on a
sustained rate for that identifier rather than on single occurrences.

## `audit-dead-letter`

Emitted by `src/lib/audit/audit-logger.ts` when audit emission
ultimately fails (after all retries / fallbacks). Indicates the
audit pipeline is degraded — events are being lost.

**Severity**: critical
**Trigger**: any occurrence in the last 5 minutes
**Recovery**: investigate audit-outbox-worker logs; check DB write
permissions on the `audit_logs` and `audit_outbox` tables.

**`code: "CHAIN_FLAG_UNREADABLE"` (#923).** The worker reads each tenant's
`audit_chain_enabled` before delivering, and refuses to treat a missing
`tenants` row as "chain disabled": that would write the row unchained and mark
it SENT. The outbox row's foreign key guarantees the tenant exists, so a missing
row means the read lost its RLS scope or grant. Every tenant is affected, so
events retry and then dead-letter. Restore the cause (the `OUTBOX_DRAIN` grant
still naming `tenant`; the worker role's EXECUTE on `public.rls_bypass_admits`
and SELECT on `tenants`), then requeue the dead-lettered rows before
`OUTBOX_FAILED_RETENTION_DAYS` (90) purges them. On RDS `audit_outbox` is under
FORCE RLS for the owner too, so the requeue runs under a transaction-scoped
bypass naming only that table:

```sql
BEGIN;
SET LOCAL app.bypass_rls = 'on';
SET LOCAL app.bypass_tables = 'audit_outbox';
SET LOCAL app.bypass_purpose = 'system_maintenance';
UPDATE audit_outbox
SET status = 'PENDING', attempt_count = 0, next_retry_at = now(), last_error = NULL
WHERE status = 'FAILED' AND last_error LIKE 'CHAIN_FLAG_UNREADABLE%';
COMMIT;
```

Datadog/Loki: `{ _logType="audit-dead-letter" }`
Splunk: `_logType="audit-dead-letter"`
Sentry: auto-captured at error level.

**`tenant_not_found` no longer occurs.** `resolveTenantId` used to return null
when an event could not be attributed — no `params.tenantId`, no team, no `users`
row — and both callers then returned **without** enqueuing, so the stdout line
was the only record the event had ever existed. It now returns
`SYSTEM_TENANT_ID`, the encoding of "no owning tenant" in a `NOT NULL` column, so
the event reaches `audit_outbox` and then `audit_logs` like any other.

**Finding an unattributable event.** It carries the real actor and a sentinel
tenant:

```sql
BEGIN READ ONLY;
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
SELECT action, actor_type, COUNT(*) AS n, MAX(created_at) AS latest
FROM audit_logs
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'   -- the sentinel tenant (name/slug: __system__)
GROUP BY action, actor_type
ORDER BY n DESC;
ROLLBACK;
```

Every `tenants` / `audit_logs` query in this runbook runs inside a block
shaped like this one, never as a bare `SELECT`: on RDS the
migration/owner role is the master user, and FORCE RLS applies to it
there same as to any application role, so a psql session authenticated
as the owner needs its own scope too. `SET LOCAL` + `ROLLBACK` leave
nothing on the session afterward — never `ALTER ROLE … SET app.*` or
`ALTER DATABASE … SET app.*` instead, which would leak the scope to
every later session on that role/database (`audit-db-grants.mjs`
already flags either as a drift finding).

**Group by `action`; do not filter on `actor_type`.** Both populations under this
tenant emit `SYSTEM` — the anchor publisher, the retention GC, and also
`emitAuthLoginFailure`, `emitBridgeCodeIssueFailure` and the DCR registration —
so an `actor_type <> 'SYSTEM'` predicate would hide almost every unattributable
event rather than isolate it. `ip` does not separate them either: the retention
GC forwards a row's `last_used_ip` on some sweeps.

Routine rows to expect: `AUDIT_ANCHOR_*` (the anchor publisher) and
`RETENTION_GC_SWEEP` (the GC heartbeat). **Anything else under this tenant is an
event whose owning tenant could not be resolved** — a first-ever sign-in denial,
a claim refusal, a pre-auth emission. A rising count of one of those actions is
what replaced the old `audit-dead-letter` alert.

No tenant can read these rows: the sentinel has zero `tenant_members` and
`/api/tenant/audit-logs` scopes by membership. Since
`20260901090000_forbid_system_tenant_membership` that is enforced by a `CHECK`
(`tenant_members_not_system_tenant`) rather than left to convention — it used to
say "unenforced invariant, not a constraint" here, and a single membership row
would have handed its holder every unattributable audit row in the deployment.
The runbook for a deployment where such a row already exists is
`docs/operations/sentinel-tenant-membership.md`.

**What replaces the alert.** A broad tenant-resolution failure used to fire
`audit-dead-letter`. It now shows up as a rising count from the query above
rather than as a log-line alert — quieter, but the record survives, which it did
not before. Alert on that count if you relied on the old signal.

**Two of the remaining reasons** — `logAuditAsync_failed` and
`logAuditBulkAsync_failed` — mean the **database was unreachable**, so the
recovery action is different: check DB connectivity and the `audit_outbox` write
path, not tenant mapping. No durable record is possible for them by any design,
because the write that would carry it is the one that failed.

**`invalid_user_id` is not like those two.** It fires with a healthy database —
a caller passed an actor id that is not a UUID, so the entry was rejected before
the outbox rather than lost to an outage — and it is excluded from forwarding
along with them. That is a **known gap**, and it is worse with a forwarder than
without one:

- **Without** `docker-compose.logging.yml`: the line survives in `json-file`
  container logs, capped at `max-size: 20m` × `max-file: 5`.
- **With** it: that overlay switches the `app` service to the **fluentd** driver,
  which replaces `json-file` rather than adding to it — so there is no local copy,
  and the `Exclude` drops the record before any OUTPUT sees it. The event is
  destroyed.

It is stated here rather than left implied, because the forwarder note below used
to justify the exclusion on a premise that covers only the other two.

**`anchor_publisher_emit_failed` also fires with a healthy database.** The
audit-anchor publisher writes its own `AUDIT_ANCHOR_*` rows (scope `TENANT`,
tenant `__system__`) straight to `audit_outbox` under the
`AUDIT_WRITE_DIRECT_OUTBOX` bypass grant, which names `auditOutbox` alone, as
`passwd_anchor_publisher`, which holds `INSERT` on `audit_outbox` (the grant in
`prisma/migrations/20260502000000_audit_anchor_publisher_phase2`). When that
write fails, the line carries `action`, `reason: "anchor_publisher_emit_failed"`
and `error` (`{name, code}`) and the row is lost; the publisher's own
`audit-anchor-publisher.*` lines still say what the run did. With the database
up, the cause is drift in one of the two: the grant in
`src/lib/tenant-rls-grants.ts` no longer naming `auditOutbox` (the bypass then
refuses the table), or the role's `INSERT` on `audit_outbox` (or its `EXECUTE`
on `public.rls_bypass_admits`) revoked — `error.code: "42501"`. On AWS it is
alarmed on its own: filter and alarm
`<name_prefix>-audit-anchor-publisher-dead-letter` on the publisher's log group
(the awslogs driver reads the container's stdout, so the forwarder exclusion
below does not apply there).
**Recovery**: `node scripts/audit-db-grants.mjs` (as `MIGRATION_DATABASE_URL`)
names a revoked privilege. Re-grant it as the owner — for the table, the
migration's own statement, `GRANT INSERT ON TABLE "audit_outbox" TO
passwd_anchor_publisher;`; on RDS `scripts/bootstrap-rds-roles.mjs` re-grants
the function `EXECUTE`s. A grant entry that drifted is a code change: restore it
and redeploy. The lost rows are
not recoverable — the publisher's `cadence` lines for the same boundaries are
the record of what they would have said.

A further reason, `emit_inside_rls_context`, exists but does **not** appear under
this `_logType` — see `audit-refused` below. It ships on its own logger
precisely because the forwarder filters on `_logType` and does not read `reason`,
so a reason added here cannot be carved out of the exclusion.

> **Note on the forwarder.** `infra/fluent-bit/fluent-bit.conf` still carries
> `Exclude _logType ^audit-dead-letter$`, and that is harmless **for the two
> database-unreachable reasons**: they fire only when the database is down, and
> in that state nothing durable can be written anyway. It is NOT harmless for
> `invalid_user_id`, which fires with a healthy database — see the gap noted
> above. It is not harmless in general,
> which is why `emit_inside_rls_context` ships under its own `_logType` rather
> than as a third reason here — adding it under the excluded type would have
> produced an alert no operator receives, and every OUTPUT in that config matches
> `app.*`, so re-tagging to escape the exclusion forwards nothing either.
> Container logs remain capped at `max-size: 20m` × `max-file: 5`
> (`docker-compose.yml`). Removing the exclusion is an operator decision, not a
> required fix.

## `audit-refused`

**What it means.** An audit emit was refused because it was issued while an RLS
context was open. `logAuditAsync` / `logAuditBulkAsync` write nothing in that
state: the Prisma Proxy would fold the outbox write into the caller's
transaction, and writing it independently instead would let the row survive a
rollback — a row asserting something that did not happen.

**Why it is its own type.** It is the only audit-loss signal that fires with a
**healthy** database **and is forwarded** — `invalid_user_id` also fires healthy
but stays under the excluded type, which is the gap recorded above. It produces
no `audit_logs` row, no `audit_outbox` row, and no movement in the sentinel-count
query. If it is not forwarded, it is not observable anywhere.

**Query.** Datadog/Loki: `{ _logType="audit-refused" }` · Splunk:
`_logType="audit-refused"`

> This signal reaches a SIEM only where a forwarder is running.
> `infra/fluent-bit/fluent-bit.conf` is mounted by `docker-compose.logging.yml`,
> an **opt-in overlay** — without it (or an equivalent) the refusal lives only in
> container logs capped at `max-size: 20m` × `max-file: 5`. The control is
> loud by design; whether anyone hears it is a deployment choice.

**Recovery action.** This is a code defect, not an operational one — it means a
caller emits audit from inside a transaction. The fix is at that call site:
`logAuditInTx` when the record must be atomic with the mutation, or issuing the
emit outside the RLS scope when it need not be. Note the predicate is the
AsyncLocalStorage store, not the transaction: work started inside an opener
callback keeps reading the store after the transaction closes, and moving such an
emit "past the transaction" does not clear it.

**Expected volume.** Zero. Any occurrence is worth a ticket.

> **Sentinel-tenant growth.** `__system__` now has an
> `audit_log_retention_days`, so `sweepAuditLogs` — which enumerates only tenants
> with a non-NULL value — no longer skips it. It previously had none, so these
> rows were never purged, while two pre-auth routes (`/api/extension/token`,
> `/api/mcp/register`) emit under it bounded only by their per-IP rate limiters.
> Rate limits cap the inflow, not the total; a retention is what makes the total
> finite.
>
> **The value is not 365 everywhere.**
> `20260902120000_set_system_tenant_audit_retention` sets 365 **only where the
> column was NULL** — a deployment that had already chosen a value for
> `__system__` keeps it. Read the actual number before acting on anything below:
>
> ```sql
> BEGIN READ ONLY;
> SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
> SELECT audit_log_retention_days, audit_chain_enabled
> FROM tenants WHERE id = '00000000-0000-4000-8000-000000000002';
> ROLLBACK;
> ```
>
> (See the audit-dead-letter section above for why every `tenants` /
> `audit_logs` query here runs inside this scope rather than as a bare
> `SELECT`.)
>
> **On the first sweep after that migration, sentinel rows older than that window
> are deleted.** On a deployment that has been running long enough to have them,
> that is a one-off drop. To see what will go — computed from the tenant's own
> value, not from an assumed 365:
>
> ```sql
> BEGIN READ ONLY;
> SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
> SELECT count(*), min(a.created_at), max(a.created_at)
> FROM audit_logs a
> JOIN tenants t ON t.id = a.tenant_id
> WHERE a.tenant_id = '00000000-0000-4000-8000-000000000002'
>   AND a.created_at < now()
>       - make_interval(days => GREATEST(t.audit_log_retention_days, 30));
> ROLLBACK;
> ```
>
> `GREATEST(…, 30)` because the sweep does: `sweepAuditLogs` clamps with
> `Math.max(retention, AUDIT_LOG_RETENTION_MIN)` (`sweep.ts`), so a value below 30
> deletes nothing extra. The API refuses one, but this migration preserves a value
> set directly in the database, so the two can differ — and a preview that used
> the stored number would over-report what is about to go.
>
> If any of it is under investigation, **export it first** — a `SELECT` in a
> session is not a copy. From `psql`, with the predicate spelled out:
>
> ```
> BEGIN READ ONLY;
> SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
> \copy (SELECT * FROM audit_logs a JOIN tenants t ON t.id = a.tenant_id WHERE a.tenant_id = '00000000-0000-4000-8000-000000000002' AND a.created_at < now() - make_interval(days => GREATEST(t.audit_log_retention_days, 30))) TO 'sentinel-audit-export.csv' CSV HEADER
> ROLLBACK;
> ```
>
> No `;` after `\copy` — psql takes the rest of that line as its own
> arguments, and a trailing `;` would be read as part of the output path.
>
> Not `pg_dump`: it has no row predicate, so `--table=audit_logs` would write
> **every tenant's** audit rows to that file.
>
> The retention is safe here only because `__system__` has
> `audit_chain_enabled = false`: a purge does not renumber `chain_seq`, so on a
> chained tenant a default `fromSeq=1` verify would report a false TAMPER (see
> `docs/security/audit-chain-threat-model.md#retention-purge-interaction`). The
> migration **checks** that flag and refuses rather than assuming it, and the
> integration suite asserts both the retention and the flag together. Enabling
> the chain on `__system__` makes the interaction real; see "Enabling the chain
> on `__system__`" under `audit-chain-verify-heartbeat` before doing so.

## `delivery.dead_lettered` / `webhook_delivery.dead_lettered`

Emitted by `src/workers/audit-outbox-worker.ts` when a delivery or
webhook-delivery row exhausts `max_attempts` and moves to a terminal
FAILED state. Logged at **warn**, because the row reached that state
cleanly rather than by a fault — but the payload is not delivered and
will not be retried, so this is permanent loss at the destination.

Unlike `audit-dead-letter`, the record itself is durable: the transition
is written in the same transaction as an `AUDIT_DELIVERY_DEAD_LETTER`
row in `audit_logs`, so a missed log line does not lose the fact.

**Severity**: high
**Trigger**: any occurrence
**Recovery**: read the `FAILED` rows for the destination
(`/api/maintenance/audit-outbox-metrics` reports `dead_letter_count`);
fix the destination, then requeue.

Datadog: `{ _logType="delivery.dead_lettered" OR _logType="webhook_delivery.dead_lettered" }`

## `outbox.depth.alert`

Emitted by `src/workers/audit-outbox-worker.ts` when the
`audit_outbox` table has more than `OUTBOX_READY_PENDING_THRESHOLD`
pending rows (default 1000) OR the oldest pending row is older than
`OUTBOX_READY_OLDEST_THRESHOLD_SECS` (default 3600s).

Hysteresis: fires once on clear → alarm transition, then re-fires
every 24h while still in alarm. Operators see the alarm at first
breach and again daily until cleared.

**Severity**: high
**Trigger**: any occurrence
**Recovery**: scale the outbox worker; check DB INSERT permissions
on `audit_logs` for the `passwd_outbox_worker` role.

Datadog: `{ _logType="outbox.depth.alert" } | count`
Loki: `{_logType="outbox.depth.alert"} | json`

## `delivery.tenant_mismatch`

Emitted by `src/workers/audit-outbox-worker.ts` when a claimed delivery
row's `tenant_id` does not match its outbox row's. The delivery is
skipped, not sent.

**Severity**: critical
**Trigger**: any occurrence
**Recovery**: this is a data-integrity failure, not a transient one —
snapshot the `audit_outbox` / delivery rows for the named ids before
touching anything, and treat it as a potential cross-tenant leak
attempt until shown otherwise.

Datadog: `{ _logType="delivery.tenant_mismatch" }`

## `outbox.depth.check_failed`

Emitted by `src/workers/audit-outbox-worker.ts` when the depth query
itself throws. **This is the watchdog for the alert above**: while it
fires, `outbox.depth.alert` cannot fire at all, so a silent outbox
means "the check is broken", not "the outbox is healthy". Alerting on
`outbox.depth.alert` alone therefore fails open — pair the two.

The check runs on the reaper cadence — at least 30s apart, and longer
under load, since it runs only after the batch, delivery and webhook
passes have all returned in the same loop iteration. A persistent
fault therefore repeats until fixed; dedupe in the alert rule rather
than sampling, or a transient single failure is lost.

**Severity**: high
**Trigger**: any occurrence
**Recovery**: read `error.code` on the log line. Two known causes,
and only one of them is a bug:

- **22P02** (`invalid input syntax for type uuid: ""`) — the depth
  query ran outside a bypass transaction and tripped the
  `audit_outbox` RLS policy's `''::uuid` cast. A custom GUC set via
  `SET LOCAL` reverts to the session default (`''`), not to unset,
  when the transaction ends, so every pooled connection that has run
  one bypass transaction fails this query afterwards.
- **P2028** (transaction timeout) — the aggregate outgrew the
  transaction budget. `MIN(created_at)` has no index-only path, so
  this scan slows as the outbox deepens. This means a real backlog,
  not a bug: check `outbox.depth.alert`, which normally fires first.

The same trap applies to any read of an RLS-forced table by a
`NOBYPASSRLS` role on a pooled connection. Inside
`src/workers/audit-outbox-worker.ts` each transaction calls
`setBypassGucs` from `src/lib/tenant-rls-grants.ts` with its grant;
elsewhere use `withBypassRls` from `src/lib/tenant-rls.ts`. `scripts/checks/check-rls-read-context.mjs`
enforces this for `src/workers` and `scripts` — but it is a bounded
verification gate, not a boundary: `src/app` and `src/lib` are out of
its scope (their context is ambient, via the AsyncLocalStorage Proxy
in `src/lib/prisma.ts`), and its declared misses are listed in the
gate's own header.

Datadog: `{ _logType="outbox.depth.check_failed" } | count`
Loki: `{_logType="outbox.depth.check_failed"} | json`

## `audit-chain-verify-heartbeat`

Emitted by `scripts/audit-chain-verify-worker.ts` on every hourly
tick, unconditionally. It means **the process ran** — liveness only.
How much that tick actually covered is carried by the counts on the
same line, and is a separate alarm (below).

The heartbeat is deliberately NOT withheld when a tenant fails to
verify: its alarm is absence-based, so withholding would make one
permanently-failing tenant indistinguishable from a dead worker, and
the resulting always-firing alarm gets muted.

**Severity**: high
**Trigger**: no event for > 2 hours
**Recovery**: restart the verify worker (on ECS the `*-audit-chain-verify-worker`
service; elsewhere `npm run worker:audit-chain-verify`); check DB SELECT
permissions on `audit_logs` and `tenants`. It connects as
`passwd_audit_chain_verifier` (column-level SELECT only), through the app
secret's `AUDIT_CHAIN_VERIFY_DATABASE_URL`; in production it has no
`DATABASE_URL` fallback and does not start without that key. A rotated
password reaches it only when its task restarts. A verifier query that names a
column outside the role's grant fails with 42501 and counts as an errored tick.

CloudWatch (`infra/terraform/monitoring.tf`): filter
`<name_prefix>-audit-chain-verify-heartbeat` on
`/ecs/<name_prefix>/audit-chain-verify-worker`, alarm
`<name_prefix>-audit-chain-verify-heartbeat-absent` (fewer than one heartbeat in
each of two consecutive hours; missing data breaches).
Datadog: monitor on `absence(_logType="audit-chain-verify-heartbeat") for 2h`
Sentry Cron Monitor: register `audit-chain-verify` with schedule `0 * * * *`.

## audit-chain verify coverage shortfall

The same heartbeat line carries `tenantCount`, `verifiedTenantCount`,
`erroredTenantCount` and `failedTenantCount`. A tick that verified only
some tenants must never read as a verified fleet, so alert on the
counts, not on absence.

Note the split: a tenant whose chain shows TAMPERING counts as
*verified* (the check ran and produced a verdict) and is reported by
`failedTenantCount`. `erroredTenantCount` means the check could not run
at all. Conflating them would hide a tamper behind a coverage page.

**Severity**: high
**Trigger**: `erroredTenantCount > 0`

(Not `verifiedTenantCount < tenantCount`: neither LogQL nor Datadog can
compare two extracted fields — a label-filter expression needs a literal
on the right. `erroredTenantCount` is per-tenant failures plus one for
each tick-level reason under "Enumeration failures" below, so it is
strictly stronger than `verifiedTenantCount < tenantCount`:
`verifiedTenantCount + erroredTenantCount` can exceed `tenantCount`, and a
tick that verified every listed tenant can still report
`erroredTenantCount = 1`.)

`tenantCount` counts the tenants the worker verifies, which is every tenant,
`__system__` included, whatever its `audit_chain_enabled`. The worker cannot
open a tenant context on the sentinel (it is the FK target of every
unattributable audit row), so it reads the sentinel's anchor and chained
rows under the `AUDIT_CHAIN_VERIFY_SENTINEL_READ` bypass grant, which names
only `audit_chain_anchors` and `audit_logs`. With its chain off (the
default) the sentinel has no anchor and no chained rows and verifies clean.
A deployment with no tenants besides `__system__` therefore reports
`tenantCount = 1` with `erroredTenantCount = 0`.

**Enabling the chain on `__system__`.** Keep it off. Until the purge
watermark exists (the `purged_up_to_seq` TODO in
`docs/security/audit-chain-threat-model.md#retention-purge-interaction`),
enabling it is one-way: the sentinel will eventually fail every tick, and
turning the chain off again does not clear that.

- `20260902120000_set_system_tenant_audit_retention` gave the sentinel a
  365-day retention, and a purge removes rows (`created_at` before the
  cutoff) without renumbering `chain_seq` or touching the anchor. From the
  first sweep after the first chained row is 365 days old, the walk reports
  TAMPER at the first retained row; once every chained row is purged, the
  anchor remains with nothing to walk and it reports RANGE_INCOMPLETE. Both
  count in `failedTenantCount`. Clearing the retention instead brings back
  the unbounded growth that migration exists to stop (unauthenticated
  callers can create these rows), and trades the false TAMPER for
  TRUNCATED, below. The same holds for any tenant whose chain was once
  enabled; the sentinel is simply the one whose retention is already set.
- The sentinel's volume is driven by pre-auth inflow and system events, so
  it is the tenant most likely to pass `AUDIT_CHAIN_VERIFY_MAX_ROWS` and
  report TRUNCATED (counted in `failedTenantCount`). Raise that, and
  `AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS` with it.

To stop chaining new rows (on RDS the owner is under FORCE RLS, so the
write runs in a transaction-scoped tenant scope without `READ ONLY`):

```sql
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
UPDATE tenants SET audit_chain_enabled = false
WHERE id = '00000000-0000-4000-8000-000000000002';
COMMIT;
```

This is not a recovery: the rows and anchor already written stay and are
still verified every tick, so the failures above still arrive once
retention reaches them.

**Enumeration failures (#923).** `tenants` now carries the same RLS
policy as every other table, so the worker's tenant-list read runs under
a named bypass grant like any other tenant read. `__system__` always
exists and only a full bypass read sees it, so a list without it means
the read lost its scope; it does not mean the deployment has no tenants.
Each case adds 1 to `erroredTenantCount` directly (not per tenant like
the construction above) and logs a `tick incomplete` line with its
reason:

- `TENANT_ENUMERATION_FAILED` — the read threw (the line carries the
  error code), e.g. 42501 when a role lacks EXECUTE on
  `public.rls_bypass_admits`, or when the grant does not name `tenants`
  (`RLS_BYPASS_NOT_GRANTED: tenants`).
- `TENANT_ENUMERATION_EMPTY` — the read returned no tenants at all.
- `TENANT_ENUMERATION_INCOMPLETE` — it returned tenants but not
  `__system__`, i.e. a tenant-scoped rather than a bypass read. The
  tenants it did return are still verified.

None of these throws: a throw would skip the heartbeat and leave only
the absence alarm, which cannot distinguish "inert" from "dead".
**Recovery**: treat the verifier as inert, as for `RLS_CONTEXT_MISSING`
below: check that the worker's role holds EXECUTE on
`public.rls_bypass_admits` and SELECT on `tenants`, and that
`SYSTEM_MAINTENANCE_TENANT_LOOKUP` still names `tenant`.

**Recovery (per-tenant failures)**: the accompanying `tick incomplete`
stderr line names the failing tenant ids. `RLS_CONTEXT_MISSING` there
means the worker lost its RLS context and its reads would have
returned zero rows — treat as "the verifier is inert", not as a
per-tenant blip. `BYPASS_CONTEXT_MISSING` is the same for `__system__`,
which is read under a bypass: the bypass was not set with the
`AUDIT_CHAIN_VERIFY_SENTINEL_READ` grant. `BYPASS_SCOPE_VIOLATION` means a
read for `__system__` returned another tenant's row — the query lost its
`WHERE tenant_id` — or more than one anchor row; treat either as a code
defect. `P2028` means the read outgrew
`AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS` (default 60s); raise it or lower
`AUDIT_CHAIN_VERIFY_MAX_ROWS`.

CloudWatch: alarm `<name_prefix>-audit-chain-verify-errored` (the heartbeat's
`erroredTenantCount` summed over an hour, `>= 1`).
Datadog: `@_logType:audit-chain-verify-heartbeat @erroredTenantCount:>0`
Loki: `{_logType="audit-chain-verify-heartbeat"} | json | erroredTenantCount > 0`

## audit-chain tamper detected

**Severity**: critical
**Trigger**: `failedTenantCount > 0` on the heartbeat line
**Recovery**: treat as a possible audit-log rewrite. The
`CHAIN_VERIFY_FAILED` stderr line below carries the reason and the
first offending `chain_seq`.

CloudWatch: alarm `<name_prefix>-audit-chain-verify-failed` (the heartbeat's
`failedTenantCount` summed over an hour, `>= 1`).
Datadog: `@_logType:audit-chain-verify-heartbeat @failedTenantCount:>0`
Loki: `{_logType="audit-chain-verify-heartbeat"} | json | failedTenantCount > 0`

## `CHAIN_VERIFY_FAILED`

Emitted by `scripts/audit-chain-verify-worker.ts` when a tenant's
chain shows tampering, with hysteresis (re-emit on clean → failed,
then every 24h while still failed).

Prefer the structured `failedTenantCount` alert above as the primary
signal — this line is the detail, not the trigger, and its hysteresis
means it is absent on most ticks of an ongoing failure.

It is written with `console.error` as a printf-formatted line — it is
**not** stored in `audit_logs` and is not a structured pino record, so
it carries no `_logType` and cannot be matched by the rules above.
Alert on the raw stderr text, or ship container stdout to a durable
sink.

**Severity**: critical
**Trigger**: any occurrence
**Recovery**: do NOT immediately purge or rewrite anything.
Snapshot the affected tenant's `audit_logs` and `audit_chain_anchors`,
notify security team, investigate.

## Audit anchor publisher

The publisher (`src/workers/audit-anchor-publisher.ts`, scheduled by
`src/workers/audit-anchor-scheduler.ts`) runs once per daily cadence boundary
(00:05 UTC) and logs one `audit-anchor-publisher.cadence` line per run, whose
`kind` is the outcome: `published`, `skipped_already_published`,
`skipped_no_tenants`, `lock_held`, `upload_cap_reached` or `failed` (with
`reason` and `stage`). Every line carries `boundary` and
`chainEnabledTenantCount`. A failed run, at any stage, and a `lock_held` run are
retried for the same boundary every 15 minutes, at most three times per process
and never later than 30 minutes before the next boundary (23:35 UTC). When a
retryable run gets no retry the scheduler logs
`audit-anchor-publisher.retries_exhausted` (warn, with `boundary`, `retries` and
`reason`: `count` when the three are used up, `window_closed` when the next
retry would land inside the last 30 minutes) and waits. `upload_cap_reached` is
not retried. All of these wait for the next boundary or the next boot run.

On AWS every filter below reads `/ecs/<name_prefix>/audit-anchor-publisher`, and
every alarm notifies the SNS alarm topic (`infra/terraform/monitoring.tf`).

To get a boot run now — after fixing a cause that the next boundary would
otherwise wait for — restart the service on the same task definition:

```bash
aws ecs update-service --cluster <cluster> --service <name_prefix>-audit-anchor-publisher \
  --force-new-deployment --region <region>
```

**What decides a run.** Not a database row: the publisher lists its primary
destination (the first configured: S3, else GitHub Releases, else the
filesystem), reads and verifies the latest manifest there, and compares it
with one database value, the greatest `audit_chain_anchors.last_published_at`.
A run publishes, adopts an object an earlier run stored but did not commit,
skips, or fails closed; the fail-closed reasons, what triggers each and how
each is reset per destination type are the table "Fail-closed reasons and
their resets" in `docs/operations/audit-anchor-rotation-runbook.md`. Every one
of them reaches this page as `cadence_failed` (below): no reason has an alarm
of its own.

Reading what the database holds (as the owner role; both tables admit only a
bypassed session):

```sql
BEGIN READ ONLY;
SET LOCAL app.bypass_rls = 'on';
SET LOCAL app.bypass_tables = 'system_settings,audit_chain_anchors';
SET LOCAL app.bypass_purpose = 'system_maintenance';
SELECT key, value, updated_at FROM system_settings
WHERE key LIKE 'audit_anchor_%' ORDER BY key;
SELECT tenant_id, last_published_at, publish_paused_until FROM audit_chain_anchors
ORDER BY last_published_at DESC NULLS LAST;
ROLLBACK;
```

`audit_anchor_upload_attempts` is the attempt count (`{boundary, count}`); a
count row that does not parse is replaced by the next run with the first count
past the cap for that run's boundary (see `upload_cap_reached`).
`audit_anchor_deployment_id` is the value the publisher was first booted with.
`audit_anchor_last_published_boundary` and `audit_anchor_previous_manifest`,
which earlier releases decided from, are removed by the migration
`20261115000000_remove_audit_anchor_legacy_settings`. Nothing reads or writes
them: one that appears again was written by hand or by a rolled-back release,
and changes nothing.

`last_published_at` is what a publish records, per tenant in the manifest: the
wall clock clamped into the published boundary. It can make a run refuse
(`LAST_PUBLISHED_AHEAD_OF_CLOCK`, `DESTINATION_BEHIND_DATABASE`,
`LEGACY_MANIFEST_UNSETTLED`) or adopt again; it never makes one skip.

Lines the publisher logs that have no alarm of their own, all warn level
unless noted:

- `audit-anchor-publisher.published_object_unverifiable` (error) — with
  `artifactKey` and `detail`, on a run that fails with
  `CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE`; `detail` says which check
  failed (`PUBLIC_KEY_NOT_ARCHIVED`, `PUBLIC_KEY_INVALID`, `SIGNATURE_INVALID`,
  `DATE_MISMATCH`, `OBJECT_MISSING`). The run's `cadence_failed` line is what
  alarms.
- `audit-anchor-publisher.published_by_other_identity` — the boundary's
  manifest exists and was published under another `kid` or `DEPLOYMENT_ID`
  (`kidMatches`, `deploymentMatches`, `artifactKey`). The run is a
  `skipped_already_published`, and one `AUDIT_ANCHOR_PUBLISH_FAILED` row with
  `PUBLISHED_BY_OTHER_IDENTITY` is written per boundary per process start.
  Expected for the rest of the day after a signing-key rotation or a
  `DEPLOYMENT_ID` change. On any other day a second deployment publishes to
  this prefix; since a skip is never healthy, the cadence-absent alarm follows
  within a day.
- `audit-anchor-publisher.previous_manifest_deployment_changed` — the manifest
  this run chains to carries another `deploymentId`. Expected once, on the
  first publish after a `DEPLOYMENT_ID` change.
- `audit-anchor-publisher.mirror_backfill_failed` — after a publish, copying
  older manifests to a secondary destination failed (`destination`,
  `error.code`; `MIRROR_DIVERGED` when the secondary holds other bytes at a
  key, `PRIMARY_OBJECT_MISSING` when a listed key could not be read). It does
  not change the run's outcome, and the next publishing run tries again.
  The backfill is a log-only byte copy: this line, including an older mirror
  object that differs (`MIRROR_DIVERGED`), reaches no alarm and no
  `cadence_failed`. Only the boundary's own manifest diverging at a secondary
  fails the run. Repeating daily, the secondary is not catching up: fix its
  access, or look at what it holds.
- `audit-anchor-publisher.unrecognised_manifest_key` — the primary holds keys
  that look like a manifest's (`????-??-??.kid-*.jws`) but are not ones the
  publisher builds. One line per listing (a publishing run lists twice), with
  `count` and `artifactKeys`, the first five. They are ignored. On the anchors
  bucket only the publisher's task role can have written them: treat it as use
  of that role's credentials.
- `audit-anchor-publisher.previous_manifest_unavailable` — a run could not
  read back the previous manifest a stored one names to compare the two: the
  manifest it adopted, or an earlier one no publish settled (`artifactKey` is
  the stored manifest whose previous is unavailable; `detail` is the check
  that failed as for `published_object_unverifiable`, `HASH_MISMATCH` when the
  object there is not the one named, `FOREIGN_LOCATION` when it is a version 2
  manifest bound to another chain location, or an error code — the
  destination's, or `UPLOAD_TIMEOUT` when the run's 60 s bound fired). The
  run's outcome is unchanged; the
  `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` row below is written with it.

Rows a publish writes beside its `AUDIT_ANCHOR_PUBLISHED` row, each an
`AUDIT_ANCHOR_PUBLISH_FAILED` row carrying `failureReason`, `artifactKey` (the
manifest this run published) and `anchoredAt`. The four comparison rows —
`TENANT_DROPPED_FROM_MANIFEST` to `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON`
— also carry `comparedArtifactKey`, the manifest the row is about: equal to
`artifactKey`, or an earlier manifest no publish settled (below);
`UNSETTLED_WALK_TRUNCATED` and `GENESIS_AFTER_EARLIER_MANIFESTS` carry it too.
None stops the publish and none is alarmed; read them with the query under
Step 7 of the rotation runbook. The four comparison rows and
`GENESIS_AFTER_EARLIER_MANIFESTS` are also written by a run that **fails** once
the primary holds the boundary's manifest, right after its failure row (below):

| `failureReason` | Meaning | Expected when |
|---|---|---|
| `OWN_PUBLIC_KEY_NOT_ARCHIVED` | `public-keys/<kid>.pub` for the publisher's own key is missing at the primary, or holds another key. Verifiers cannot fetch the key. | Daily, until the key is archived (`npm run audit-anchor-publish-pubkey`, rotation runbook Step 4). |
| `MULTIPLE_MANIFESTS_FOR_DATE` (`date`, `count`) | The date of the manifest this run chained to holds more than one manifest key. | Never. A second key on a date is a second publisher or a planted object. |
| `TENANT_DROPPED_FROM_MANIFEST` (`count`) | Tenants of the manifest `comparedArtifactKey` chains to are absent from it. | Once, with every tenant, on the first publish after a tag-secret rotation. Otherwise a tenant's `audit_chain_enabled` was cleared, or its anchor row deleted — find who did (see `cadence` below). |
| `CHAIN_SEQ_REGRESSION` (`count`) | Tenants whose `chainSeq` is lower than in the previous manifest, in the same epoch. | Never. A bug or tampering: a security incident. |
| `EPOCH_CHANGED` (`count`) | Tenants whose `epoch` differs from the previous manifest's, in either direction. A `chainSeq` is compared within one epoch only, so for these tenants `CHAIN_SEQ_REGRESSION` says nothing. | Never: no code path writes `audit_chain_anchors.epoch`. The column was changed in the database directly — a database-write incident; compare the tenant's `chainSeq` in the two manifests by hand. |
| `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` | The previous manifest that `comparedArtifactKey` names — the manifest this run adopted, or an earlier one no publish settled — is missing at the primary, does not verify, is not the object its `sha256` names, or is bound to another chain location; or the read-back failed or hit the run's bound (the `previous_manifest_unavailable` line's `detail` is then an error code: `AccessDenied`, `HTTP_5xx`, `UPLOAD_TIMEOUT`). The three rows above could not be computed for that manifest. | Only after a destination error; otherwise never on a store nothing deletes from. The `previous_manifest_unavailable` line says which; then compare the two manifests by hand (`audit-verify --prior-manifest`). |
| `UNSETTLED_WALK_TRUNCATED` (`count`) | More manifests lie between the published high-water and this publish than one run compares (7). `count` were compared, the last of them `comparedArtifactKey`; the unsettled manifests before it were not, and no row speaks for them. | Never in normal operation: it takes more than 7 boundaries stored and not settled, or a `last_published_at` that is null or behind while the chain is longer than that. Compare the remaining manifests by hand, each with the one before it (`passwd-sso audit-verify --prior-manifest`), and find why `last_published_at` is behind — a value nobody's runs explain is a database-write incident. |
| `GENESIS_AFTER_EARLIER_MANIFESTS` | The manifest `comparedArtifactKey` names — the one this run adopted, or the one its manifest chains to — carries `previousManifest: null` although the primary lists a manifest key dated before it. The chain's link is broken at that manifest: `audit-verify --prior-manifest` on it and the manifest before it passes with the genesis `WARN` instead of checking a link. | Never, except once after an upgrade that spanned the publish time: the earlier release's publisher ran after the migration removed its pointer row (`docs/operations/deployment.md` "Upgrade order"). Then record it as the known break and tell verifiers which two manifests it lies between. Otherwise a manifest signed with the publisher's key outside the publisher: a signing-key incident. A run that skips a boundary already recorded writes no row; the row comes with the next publish, which chains to that manifest, and once more if that publish's commit fails and is retried. The first manifest of a location has no earlier key and gets none. |
| `MISSING_PRIOR_CADENCE_PUBLICATION` | See `missing_prior_cadence` below. | |

The three comparison rows are computed against the manifest the published one
chains to: the one in hand on a fresh publish, and on an adopted publish the
one the stored manifest names, read back from the primary and held to the hash
it carries. So a publish reports them whether it signed the manifest or adopted
it. A boundary that is adopted more than once — nothing its manifest covers
could be settled — writes them again with each adopt, at most three times: the
attempt cap bounds it.

A run that fails once the primary holds the boundary's manifest — a secondary
failure, `COMMIT_FAILED_AFTER_UPLOAD`, any other stage-`upload` or
`after_upload` failure with the object stored — writes the comparison rows for
that manifest itself, after its `AUDIT_ANCHOR_PUBLISH_FAILED` failure row and
with the same `anchoredAt`: against the manifest it chained to when it created
the object, against the one the stored manifest names, read back, when it
found the object there. So a failure row of those stages may be followed by
`TENANT_DROPPED_FROM_MANIFEST`, `CHAIN_SEQ_REGRESSION`, `EPOCH_CHANGED` or
`PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` rows whose `artifactKey` and
`comparedArtifactKey` are both the stored manifest; nothing follows when the
comparison finds no change, and a failure before the primary held the object
writes the failure row alone. Each retry of the boundary that fails the same
way writes them again — at most three times, the attempt cap — and the adopt
that settles the manifest writes them once more. Read repeated rows with one
`comparedArtifactKey` as one finding.

The run that created the object compares it with the manifest it has in hand
and reads nothing. A retry found the object there and must read the
predecessor back, inside the same 60 s bound as the rest of the run. So a
retry that fails **on that bound** — a secondary that hangs, say
(`<destination>_UPLOAD_FAILED:UPLOAD_TIMEOUT`) — has no time left for the
read: it writes `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` after its
failure row instead of the comparison rows, and its
`previous_manifest_unavailable` line carries `detail: UPLOAD_TIMEOUT`. That
row says the retry could not compare, not that the predecessor is gone: the
rows the creating run wrote for the same `comparedArtifactKey` stand, and the
adopt that settles the manifest compares it again.

A manifest that was stored but never settled — every run of its boundary failed
after the primary held the object, or the attempt cap stopped them — is also
compared by the next publish that does commit, which covers a run that was
killed before it wrote its rows. After
its mirror backfill that publish walks back from the
manifest it chains to, through every manifest dated after the published
high-water (the greatest `last_published_at`, read before the publish writes
it; all of them when no row has one), reads each one's previous manifest back
the same way, and writes the same rows with `comparedArtifactKey` naming the
unsettled manifest and `artifactKey` and `anchoredAt` its own. A manifest dated
on the high-water's date was settled by the publish that recorded it and is not
compared again; a genesis manifest has nothing to be compared with. The
read-backs share the run's 60 s bound: one that fails or outlasts it ends the
walk with `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` for that manifest. One
publish compares at most 7 unsettled manifests; when another lies past them the
walk stops and writes `UNSETTLED_WALK_TRUNCATED` instead of ending silently.

`AUDIT_ANCHOR_KEY_ROTATED` (`oldKid`, `newKid`, `anchoredAt`, `artifactKey`) is
written by the first publish whose manifest is under another `kid` than the one
it chains to. Expected once per rotation; one naming a `kid` no operator
archived is a forged predecessor (`docs/security/audit-chain-threat-model.md`).
`AUDIT_ANCHOR_PUBLISHED` carries `adopted` (the run stored nothing: the object
was already at the primary) and `genesis` (the manifest has no
`previousManifest` — the first ever, or the first after a chain restart).

## `audit-anchor-publisher.stale_boundary`

**Severity**: high
**Trigger**: any occurrence (filter and alarm
`<name_prefix>-audit-anchor-publisher-stale-boundary`). Warn level, with
`boundary` and `latestArtifactKey`; the run is a `skipped_already_published`.
**What it means**: a run for a boundary found, at the primary destination, a
verified manifest dated after that boundary but not after the wall clock's
current one. The run skips. On ECS this has no legitimate cause: a boundary's
retries stop 30 minutes before the next, and a timer never runs before its
boundary, so this process never runs a boundary after it published a later
one. Another writer published the later manifest — a second publisher against
this destination. It is never a clock that went back: that clock's current
boundary is earlier too, so the manifest reads as ahead of it and the run
fails closed with `CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD`.
**Recovery**: look for a second publisher. Run the holder query under
`audit-anchor-publisher.lock_held` (below), and list every session the
publisher's pool would open:

```sql
SELECT pid, usename, client_addr, backend_start, state
FROM pg_stat_activity
WHERE application_name = 'passwd-sso-audit-anchor-publisher';
```

More than the one task's connections, or a `client_addr` that is not the
service's task, is a second publisher: stop it. A second publisher need not
share this database — a clone pointed at the same prefix shows only at the
destination. `latestArtifactKey` names the object; who wrote it is in the
destination's own records (on AWS, the trail's data events for the anchors
bucket).

## `audit-anchor-publisher.cadence_healthy`

Logged once per healthy boundary, and only then: a `published` run, or a
`skipped_no_tenants` run on an install where no tenant has ever enabled the
chain (`everChainEnabled: false`, decided by the absence of any
`audit_chain_anchors` row and of any manifest key at the primary destination,
so deleting the anchor rows does not turn the skip healthy). A tenant that has
the chain enabled and no anchor row yet — the outbox worker creates the row
with the tenant's first chained event — has nothing to anchor and is not
published; when no chain-enabled tenant has a row the run is this same
`skipped_no_tenants`, with `chainEnabledTenantCount` above 0.
`skipped_already_published`, `failed`, `upload_cap_reached` and `lock_held`
never emit it (nor does a `stale_boundary` skip, which is a
`skipped_already_published`): a skip means this run published nothing, so it
must not read as health. A `published` run that adopted a stored object emits
it once, like any other.

**Severity**: high
**Trigger**: the alarm `<name_prefix>-audit-anchor-cadence-absent` — no line
(filter `<name_prefix>-audit-anchor-cadence-healthy`) in each of 25 consecutive
hours; missing data breaches.
**What it means**: no boundary has been published for over a day. Look for the
cause among the other publisher alarms: the service down, every run failing,
the attempt cap, or no tenant chain-enabled any more.
**Recovery**: read the last day's cadence lines (below); fix what their `reason`
names; restart the service for a boot run. If the runs report
`skipped_already_published` while no `published` line exists for that boundary,
the boundary's manifest was published by something else: the
`published_by_other_identity` line beside the skip says whether its `kid` or
its `DEPLOYMENT_ID` differs. After a rotation or a `DEPLOYMENT_ID` change that
is the rest of that day and clears at the next boundary; otherwise a second
deployment writes to this prefix.

A **deliberate full disable** — every tenant's chain turned off after one was
on — leaves this alarm in ALARM, and that is the state to see: nothing is being
anchored. Do not silence it to make the dashboard green. On a new stack the
alarm can be in ALARM from creation until the publisher's first healthy run.

```bash
aws logs tail /ecs/<name_prefix>/audit-anchor-publisher --since 26h --region <region> \
  --filter-pattern '{ $._logType = "audit-anchor-publisher.cadence" }'
```

## `audit-anchor-publisher.cadence`

The per-run line above. One alarm reads it directly:

**Severity**: high
**Trigger**: the alarm `<name_prefix>-audit-anchor-chain-enabled-fell-to-zero` —
a cadence line with `kind: "skipped_no_tenants"`, `chainEnabledTenantCount: 0`
and `everChainEnabled: true`.
**What it means**: no tenant is chain-enabled now, though one was. It is not
edge-triggered: every run in that state matches, so it fires at each boundary
and each boot run until a tenant is chain-enabled again (the cadence-absent
alarm follows a day later).
`chainEnabledTenantCount` counts every chain-enabled tenant, with or without an
anchor row. A `skipped_no_tenants` line with a count above 0 and
`everChainEnabled: true` therefore does not match this alarm: tenants are
enabled, none of them has an anchor row, and anchor rows or manifests of
earlier ones exist. Only the cadence-absent alarm reports that state. It is
what deleting every enabled tenant's anchor row leaves until the outbox worker
writes the next chained event; if it persists, look at the worker and at who
deleted the rows.
**Recovery**: no application path writes `tenants.audit_chain_enabled`, so the
change was made in the database directly; find who made it from the database's
own logs. If the disable was deliberate, the state is correct and both alarms
stay as they are. If not, treat it as a database-write incident and re-enable
the chain with a tenant-scoped `UPDATE` (the shape of the `__system__` one under
`audit-chain-verify-heartbeat`, with `true`).

## `audit-anchor-publisher.upload_cap_reached`

**Severity**: high
**Trigger**: any occurrence (filter and alarm
`<name_prefix>-audit-anchor-publisher-upload-cap-reached`).
**What it means**: three runs for this boundary already found something to
publish or adopt — each counted in `audit_anchor_upload_attempts` before its
publish transaction opened — so this run wrote nothing. The first run past the
cap writes one `AUDIT_ANCHOR_PUBLISH_FAILED` row (`failureReason:
UPLOAD_ATTEMPT_CAP_REACHED`); later runs for the same boundary log only. The cap
bounds how often a crash loop or a retry storm reaches the destinations for one
boundary. A run that skips or fails closed at its first look is not counted.

The line also fires, with `countUnreadable: true`, when the stored
`audit_anchor_upload_attempts` value does not parse (not JSON, or not
`{boundary, count}` with a positive integer count). Such a value cannot say how
many runs reached the publish transaction, so the run treats the boundary as
past the cap: it overwrites the value with `{boundary: <this boundary>, count:
4}`, writes nothing, and writes the one row with `failureReason:
UPLOAD_ATTEMPT_COUNT_UNREADABLE` instead.
**Recovery**: read the boundary's earlier `cadence_failed` lines for the cause
(and ECS task-stop events, for a crash loop). A count nobody's runs explain —
or an unreadable one, which no publisher writes — is a planted or damaged row:
a database-write incident. The count resets on its own: the next boundary's
first run counts 1 and publishes. The missed boundary is then reported once as
`MISSING_PRIOR_CADENCE_PUBLICATION`; when a counted run had stored the missed
boundary's manifest, that publish also writes the comparison rows for it
(`comparedArtifactKey` is its key), as the run that stored it did with its
failure row.

## `audit-anchor-publisher.commit_failed_after_upload`

**Severity**: high
**Trigger**: any occurrence (alarm
`<name_prefix>-audit-anchor-publisher-commit-failed-after-upload`).
**What it means**: every destination holds the manifest, then the publish
transaction did not commit (a database error, the 90 s transaction bound, a lost
connection). The object is stored, `last_published_at` is not. No pause is
written — the destinations are healthy. The scheduler retries the boundary every
15 minutes; the retry finds the stored object, verifies it and adopts it
(`published` with `adopted: true`), so the key keeps its one version.
**Recovery**: read `error.code` on the line and check the database. Confirm a
later `published` line for the same `boundary`. If none follows before the next
boundary, the next publish still chains to the stored object — the destination
decides, not the database — and reports `MISSING_PRIOR_CADENCE_PUBLICATION`
because nothing recorded the earlier one. The failed run compared the stored
object with its previous manifest before it returned: a tenant dropped, a
`chainSeq` lowered or an `epoch` changed in that object is in the
`AUDIT_ANCHOR_PUBLISH_FAILED` rows right after this failure's row, with
`comparedArtifactKey` that object's key. The adopt, or the next boundary's
publish, reports the same comparison again.

## `audit-anchor-publisher.cadence_failed` / `audit-anchor-publisher.upload_failed`

**Severity**: high
**Trigger**: any occurrence (alarms
`<name_prefix>-audit-anchor-publisher-cadence-failed` and
`<name_prefix>-audit-anchor-publisher-upload-failed`).
**What it means**: `cadence_failed` is every failed run, with `reason` (a token,
also written to the `AUDIT_ANCHOR_PUBLISH_FAILED` row) and `stage`:

- `before_upload` — the run failed before the primary held the boundary's
  object. Either before the
  attempt count was written — the database unreachable, the tenants read
  failing, or one of the fail-closed states — in which case it cost no attempt;
  or after it — the signing step, or the same states found again under the
  lock — in which case it cost one. The fail-closed states are
  `<destination>_READ_FAILED:<code>` (the primary could not be listed or read),
  `CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE`,
  `CADENCE_FAILED:PUBLISHED_OBJECT_FOREIGN_LOCATION`,
  `CADENCE_FAILED:LEGACY_MANIFEST_UNSETTLED`,
  `CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD`,
  `CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK`,
  `CADENCE_FAILED:DESTINATION_BEHIND_DATABASE` and
  `CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY`; trigger and reset of each are in
  the rotation runbook's table. `<code>` is `ARTIFACT_TOO_LARGE` when the object
  the run must read at the primary is larger than 8 MiB, which no publisher
  wrote: every run fails until it is dealt with (the runbook's table); on the
  filesystem destination it is `ARTIFACT_NOT_REGULAR_FILE` when the name of an
  artifact holds a symlink, a directory or a device instead of a file.
  `<destination>` is `s3-object-lock`,
  `github-release` or `filesystem`. For an S3 service error `<code>` is the S3 error
  name: right after an upgrade,
  `s3-object-lock_READ_FAILED:AccessDenied` on every run is the publisher's IAM read
  grant not applied yet (`docs/operations/deployment.md` "Upgrade order"). Both
  kinds are retried every 15 minutes (at most three times per process), so
  a transient database outage at the boundary does not cost the day; a
  deterministic failure after the count reaches `upload_cap_reached` after
  three runs, and one before it stops at `retries_exhausted`. (An
  `audit_anchor_upload_attempts` value that does not parse is not a failure
  here: it reports `upload_cap_reached` with `countUnreadable: true`, and the
  next boundary recovers by itself.) Fix it and delete the
  `audit_anchor_upload_attempts` row if the boundary must still be published.
- `upload` — a create at the primary or at a secondary failed, or the 60 s
  bound on the run's destination I/O fired (`UPLOAD_TIMEOUT`):
  `<destination>_UPLOAD_FAILED:<code>` (`<code>` is `ARTIFACT_TOO_LARGE` when the
  signed manifest is larger than 8 MiB). `upload_failed` names the destination
  and carries `error` (`name: AccessDenied` usually means the bucket policy or
  the task role drifted from Terraform; the line's `code` is `unknown` for an S3
  service error, while the reason token carries the name). The anchors bucket
  policy is also written to refuse, with `AccessDenied`, a PUT that carries no
  `If-None-Match` (`DenyUnconditionalPut`; its effect on AWS is checked once by
  hand, `infra/terraform/README.md` "Verify the conditional-write policy
  once"): this release always sends it, so
  `s3-object-lock_UPLOAD_FAILED:AccessDenied` right after the Terraform apply
  of an upgrade is the previous release's publisher, still running, whose PUT is
  unconditional (`docs/operations/deployment.md` "Upgrade order"). Two more reasons have this stage and no `upload_failed` line, both
  about a secondary that already held the boundary's key:
  `<destination>_MIRROR_DIVERGED` (it holds other bytes than the primary) and
  `<destination>_READ_FAILED:<code>` (it could not be read back to compare;
  `ARTIFACT_TOO_LARGE` when the object there is larger than 8 MiB).
  The run also pauses the manifest's tenants until the next boundary: the
  audit-outbox worker stops advancing their chains, and the 15-minute retry
  that publishes clears it. The retry adopts what the primary already holds.
  A `CADENCE_FAILED:<code>` reason at this stage is a database or other error
  raised once the primary held the boundary's object and before every
  secondary did (`<code>` as for `before_upload`); it writes no pause, and the
  retry adopts the stored object. The one database statement in that interval
  is a read of the anchor rows the manifest covers, and the code handles a lock
  timeout there as `CADENCE_FAILED:55P03` at stage `upload`. In practice it does
  not occur: the transaction has read `audit_chain_anchors` before it stores
  anything, so it already holds a read lock on the table until it ends, a later
  `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` (or DDL) queues behind it, and the
  transaction's own later read returns at once. A lock timeout after the create
  is the anchor-row update's, which runs after every destination holds the
  object: `COMMIT_FAILED_AFTER_UPLOAD:55P03` at stage `after_upload`, whether
  the lock is a table lock queued ahead of the update or a **row** lock (what an
  `UPDATE` or `SELECT … FOR UPDATE` on the anchor rows holds). A table lock held
  *before* the transaction's first read fails that read, before anything is
  stored, so it is a `before_upload` failure. Neither is
  `lock_held`: once the object is stored a lock timeout is a failed run with
  its rows; `lock_held` is the publish lock only, before anything is created.
  Every failure of this stage with the object stored, and every `after_upload`
  one, is followed by the stored manifest's comparison rows when it differs
  from its predecessor (see "Rows a publish writes" above).
- `after_upload` — `COMMIT_FAILED_AFTER_UPLOAD:<code>`, `<code>` being the `error.code` of
  the `commit_failed_after_upload` line; see that section above.

Rows per boundary: the persisted count admits at most three counted runs across
restarts, each writing at most one failure row — and, when it failed with the
manifest stored, at most three comparison rows after it (or the one
unavailable row) and at most one `GENESIS_AFTER_EARLIER_MANIFESTS` row — plus
the one cap row (either reason). A failure before the count is written is not counted, so the count
does not bound it; the scheduler does: each process runs a boundary at most
four times (the first run and at most three retries), and so writes at most
that many failure rows for it per process start, counted runs included.

## `audit-anchor-publisher.pause_persist_failed`

**Severity**: medium
**Trigger**: any occurrence (alarm
`<name_prefix>-audit-anchor-publisher-pause-persist-failed`).
**What it means**: after an upload failure, writing the pause failed. The outbox
worker keeps advancing those tenants' chains past what was published; the next
publish covers them, so nothing is lost, but the protection window is wider.
**Recovery**: check the database (`error.code`).

## `audit-anchor-publisher.pool.error` / `audit-anchor-publisher.cadence_error`

`pool.error` is the publisher's `pg` pool reporting a dropped idle connection
(alarm `<name_prefix>-audit-anchor-publisher-pool-error`); alert on a sustained
rate, as for `worker.pool.error`. `cadence_error` means a run threw out of
`runCadence`, which is written never to throw — a code defect (alarm
`<name_prefix>-audit-anchor-publisher-cadence-error`); the scheduler retries
the boundary as for an upload failure.

## `audit-anchor-publisher.missing_prior_cadence`

Warn level, not alarmed. A run found that no chain-enabled tenant's
`last_published_at` reaches the previous boundary. When that run publishes, it
writes one `AUDIT_ANCHOR_PUBLISH_FAILED` row (`failureReason:
MISSING_PRIOR_CADENCE_PUBLICATION`) after its own commit; a run that fails
writes only its own failure row, so the retries that follow do not repeat it
and the run that publishes reports the gap once. It never stops the publish.

Expected **once**, on the first publish after a tenant enables the chain, and
once after a chain restart. Any later occurrence means a boundary was never
committed — the publisher was down for that whole day, every attempt failed, or
the cap was reached — or that its object was stored and never recorded: a
commit lost with no retry after it, including one lost just before a
signing-key rotation or a `DEPLOYMENT_ID` change, which the new identity does
not adopt. In that last case the day's manifest exists at the destination and
the next one chains to it. The query reads the database only: it says nothing
about what the destination holds.

## `audit-anchor-publisher.lock_held`

**Severity**: high
**Trigger**: any occurrence (filter and alarm
`<name_prefix>-audit-anchor-publisher-lock-held`).
**What it means**: the run waited 10 s (`lock_timeout`) for the publish lock
another session held, and stood down, with nothing stored at the primary. It
writes no failure row and no pause. It
is retried for the same boundary like a failure (every 15 minutes, at most three
times per process, not inside the last 30 minutes); if the holder published in
the meantime, the retry finds the boundary's manifest at the primary destination
and is `skipped_already_published`.
Nothing guarantees the holder publishes — any role that can connect can take
the advisory lock — so after the retries the boundary waits like any other
failure. On ECS it should never occur: the service runs one task and a deploy
stops the old one before starting the new, so a held lock means a second
publisher, or some other session holding the key, against this database.
**Recovery**: find the holder, as a role that can read every session's
`pg_stat_activity` row (the RDS master user, or a member of `pg_read_all_stats`):

```sql
SELECT l.pid, a.usename, a.application_name, a.client_addr, a.backend_start, a.xact_start, a.state
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
  AND l.classid = ((hashtext('audit-anchor-publish')::bigint >> 32) & 4294967295)::oid
  AND l.objid = (hashtext('audit-anchor-publish')::bigint & 4294967295)::oid;
```

The lock is `pg_advisory_xact_lock(hashtext('audit-anchor-publish'))`:
`hashtext` returns an `int4`, which the one-argument (`bigint`) form widens, so
PostgreSQL stores it with `objsubid = 1`, the key's high 32 bits as `classid`
(0 for this key, whose hash is positive) and its low 32 bits as `objid`. A
publisher's own session shows `application_name =
passwd-sso-audit-anchor-publisher`. Stop the process that owns it (a second
publisher: scale it down; anything else: `SELECT pg_terminate_backend(<pid>)`
once you know what it is), then restart the service for a boot run if the
boundary is still unpublished.

## audit-anchor-publisher down

**Severity**: high
**Trigger**: alarm `<name_prefix>-audit-anchor-publisher-down` — Container
Insights `RunningTaskCount` below 1 for 10 consecutive minutes (missing data
breaches). Ten, not the other workers' two, because the publisher deploys with
`deployment_minimum_healthy_percent = 0`: every deploy has a window with no task
while the old one drains (up to its 120 s `stopTimeout`) and the new one starts.
**Recovery**: read the stopped tasks' reason (ECS task-stop events) and the
publisher's fatal lines, which are plain JSON without `_logType`:
`env validation failed` (path and code only, never the value),
`audit-anchor-publisher.boot_failed` (e.g. `DeploymentIdMismatchError` — see
`docs/operations/deployment.md` "`DEPLOYMENT_ID`"), or a secret key the task
definition names but the app secret lacks (the task never starts). A service
scaled to 0 on purpose keeps this alarm in ALARM.

```bash
aws logs tail /ecs/<name_prefix>/audit-anchor-publisher --since 1h --region <region> \
  --filter-pattern '"boot_failed"'
```

## ECS Exec session opened

**Severity**: medium
**Trigger**: the EventBridge rule `<name_prefix>-ecs-execute-command` (CloudTrail
`ExecuteCommand` from `ecs.amazonaws.com`) — one SNS notification per session.
**What it means**: someone opened a shell in a task. ECS Exec session logging is
`NONE` (the bootstrap shell handles role passwords), so this event is the only
record. The rule receives events only from an account with a trail logging
management events (`docs/operations/deployment.md` "CloudTrail prerequisite").
**Recovery**: match it to a known operator action (the event names the principal,
cluster, task and container). An unexplained session is an incident: what it did
left no transcript.

## Anchors bucket configuration changed

**Severity**: high
**Trigger**: the EventBridge rule `<name_prefix>-audit-anchor-bucket-config-change`
— `PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketLifecycle`,
`PutBucketLifecycleConfiguration`, `PutObjectLockConfiguration` or
`PutBucketVersioning` on the anchors bucket. Same trail prerequisite.
**What it means**: the bucket policy that decides who may write an anchor holds
only while nobody replaces it, and the account root always can. **A Terraform
apply that touches these resources is the expected false positive** — compare
the event's principal and time with the apply.
**Recovery**: anything else is a tamper attempt on the evidence store. Capture
the current state before changing it, then let Terraform report the drift:

```bash
aws s3api get-bucket-policy --bucket <bucket> --region <region>
aws s3api get-object-lock-configuration --bucket <bucket> --region <region>
aws s3api get-bucket-versioning --bucket <bucket> --region <region>
terraform plan -var-file=envs/prod/terraform.tfvars
```

## Publisher task role passed to another task

**Severity**: high
**Trigger**: either EventBridge rule, same trail prerequisite. Both match the
role by its full ARN and by its bare name (`*-ecs-audit-anchor-publisher-task`),
since CloudTrail records the request as sent and `RegisterTaskDefinition`
accepts either spelling:

- `<name_prefix>-audit-anchor-publisher-role-override` — CloudTrail `RunTask`
  or `StartTask` whose `overrides.taskRoleArn` is the publisher's task role;
- `<name_prefix>-audit-anchor-publisher-role-task-definition` — CloudTrail
  `RegisterTaskDefinition` whose `taskRoleArn` is the publisher's task role and
  whose `family` is anything but the publisher's own
  (`<name_prefix>-audit-anchor-publisher`). A run of such a definition needs no
  override, so the first rule never sees it.

**What it means**: that role is the only principal the anchors bucket policy
lets write a manifest, and its trust policy admits any ECS task of this account
(`aws:SourceAccount`). A task run with it — any image, any command — can write
one. The publisher's own service never sends an override and registers only its
own family, so there is no expected false positive.
**Recovery**: the event names the principal, the cluster and the task
definition. Stop any task running it (`aws ecs stop-task`); for a registered
definition, deregister it (`aws ecs deregister-task-definition`). Then remove
`iam:PassRole` on the publisher role from that principal. List the bucket's versions
(`docs/security/audit-anchor-verification.md` "Object versions"): a manifest key
has one version, so a second version of any key, or a manifest key no
`published` cadence line explains, was written with that role.

A task of the publisher's **own** family needs neither an override nor a new
family; that route has its own section, "Publisher-family task outside the
publisher service" (below). Together the three cover every way a task gets the
role through direct ECS calls in this stack's region: (a) an override names it — the first rule; (b1) a task definition of
another family names it — the second rule, at registration; (b2) a task
definition of the publisher's family names it, which is legitimate only for a
task the publisher service launched — the next section.

**Not alarmed by this stack.** Every task-launch route needs `iam:PassRole` on
the publisher role, so restricting who holds it (an SCP or permission boundary) is
the control for those; these rules only detect part of them. The role-change routes
below need no `iam:PassRole`: their control is who holds `iam:UpdateAssumeRolePolicy`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:DeleteRolePolicy`, `iam:DetachRolePolicy`, `iam:PutRolePermissionsBoundary`, `iam:DeleteRolePermissionsBoundary`, `iam:DeleteRole`, and `iam:CreateRole` scoped to its name (and, for any customer-managed policy attached to it, `iam:CreatePolicyVersion` / `iam:SetDefaultPolicyVersion` on that policy; Terraform gives it an inline policy only) on the
publisher role. Outside their reach: the
same ECS calls in any other region — the role is global, the rules and the
events they match are regional — and another AWS service that launches ECS tasks
under a role it is passed (AWS Batch's `jobRoleArn` on Fargate, for one). Changes to the role itself —
`UpdateAssumeRolePolicy`, `PutRolePolicy`, `AttachRolePolicy`, a `DeleteRole`
followed by a `CreateRole` of the same name — are IAM events, which EventBridge
delivers only in `us-east-1`. This configuration has no provider there, so they
reach CloudTrail and are not alarmed here. Nor is the deploy path itself: an
`UpdateService` (or a `CreateService` replacing the service) that points the
publisher service at a revision of its family registered outside a deploy —
another image or command — runs that revision as the publisher's own task,
which no rule can tell from a deploy (`terraform plan` shows the service's task
definition drifted; `aws ecs describe-services` names the revision). Alarming
the IAM events is the operator's: an organisation trail's rules, or an
EventBridge rule in `us-east-1` matching `eventSource: iam.amazonaws.com` with
`requestParameters.roleName` set to the publisher role's name. `terraform plan`
reports a drifted trust or inline policy.

## Publisher-family task outside the publisher service

**Severity**: high
**Trigger**: either of two EventBridge rules.

- `<name_prefix>-anchor-publisher-family-outside-svc` — the
  native ECS "ECS Task State Change" event (no trail needed) for a task whose
  `taskDefinitionArn` is a revision of the publisher's family (the family's ARN
  followed by `:`, so a family whose name only starts with it does not match)
  and that is either outside this stack's cluster or in it with a `group` other
  than `service:<name_prefix>-audit-anchor-publisher`. ECS sets `group` to
  `service:<service name>` for a task a service launched and to
  `family:<family>` by default for one started otherwise. A task emits several
  state changes, so one task can notify more than once. Until #1020 it was named
  `<name_prefix>-audit-anchor-publisher-family-task-outside-service`, which is
  66 characters with `passwd-sso-prod` (EventBridge allows 64) and failed every
  plan. On a stack that deployed it under the old name (a `<name_prefix>` of at
  most 13 characters), the rename replaces the rule: between the old rule's
  deletion and the new one's creation in that `terraform apply`, a matching task
  notifies nobody.
- `<name_prefix>-audit-anchor-publisher-family-run-task` — CloudTrail `RunTask`
  or `StartTask` naming the publisher's family in `taskDefinition` (`family`,
  `family:revision` or the full ARN), in any cluster (needs the trail). `group`
  is a parameter of both calls, so a caller can claim the publisher service's
  group and pass the first rule; this one sees the call whatever it claims. The
  service's scheduler starts its tasks without either call, so a deploy raises
  neither rule.

**What it means**: a task is running the publisher's task definition — so its
task role, the only principal the anchors bucket policy lets write a manifest —
without the publisher service having launched it: a `RunTask` / `StartTask`, a
service other than the publisher's, or a service of the publisher's name in
another cluster. Such a task can write a manifest, and a revision registered
outside a deploy can carry any image and command. There is no expected false
positive.
**Recovery**: the event names the task, its cluster, its group and the
revision (the CloudTrail one also names the principal). Stop the task
(`aws ecs stop-task --cluster <cluster> --task <task>`); if a service launched
it, delete that service. Compare the revision with the one the publisher
service runs (`aws ecs describe-services`) and deregister any revision no
deploy registered. Remove `ecs:RunTask` / `ecs:StartTask` (or `iam:PassRole` on
the publisher role) from the principal that started it. Then list the
bucket's versions and compare the manifest keys with the `published` cadence
lines (`docs/security/audit-anchor-verification.md` "Object versions"), as for
the rules above.

## `rls.bypass_not_granted`

Emitted by the pool listener in `src/lib/db/pool-factory.ts`. The database
raised it when a bypassed statement examined a row of a table that is not
in the bypass's grant (`app.bypass_tables`). The line names `table` and
`purpose`. It is rate-limited to one line per (table, purpose) per process
per minute, so the metric counts lines, not refused statements.

The database is enforcing (`public.rls_bypass_enforced()` is true): the
WARNING this line reports is followed by a refusal, SQLSTATE 42501 with
`RLS_BYPASS_NOT_GRANTED: <table>`. A statement was **refused**, and the
request or job that issued it failed unless its code caught the error. This
line and `rls.bypass_refused` (below) are the only trace of a refusal that was
caught.

**Severity**: medium
**Trigger**: any occurrence. The normal count is 0.
**Recovery**: find the code path that serves `purpose` and reaches
`table`: the same time window in the same log group holds the failing request
or job (a 42501 whose message names the table). Then either add the table's
model to that grant in `BYPASS_GRANT`, or stop the path from reaching the table,
and deploy the fix.
**Emergency lever**: if a production path is failing and the fix cannot ship
soon, un-flip the database (`docs/operations/deployment.md`, "Un-flip"). That
makes every bypass admitted again until the function is restored: the
protection is off for all grants, not only the one that failed, and the audit of
every later deploy fails until the function is restored or the deploy carries
`RLS_REPORT_MODE_ACK`. Reports keep counting after an un-flip, as long as
`client_min_messages` is at `warning` or below: in report mode there is no
refusal, so the WARNING is the only signal.

A deploy that carries the acknowledgement logs one line with
`_logType: "rls.report_mode_acknowledged"` from the migrate task (app log
group, stream prefix `migrate`), whether the database is in report mode or
enforcing again: a variable left behind would let a later un-flip pass. The `RlsReportModeAcknowledged` metric counts
it and the `rls-report-mode-acknowledged` alarm fires on `Sum >= 1` in 5
minutes, on every such deploy, so an acknowledgement left in a pipeline
variable does not become the steady state unnoticed. Between deploys, and on
compose, nothing reports an un-flipped database.

CloudWatch: the `RlsBypassNotGranted` metric. There is one filter per `_logType` on
the app, audit-outbox-worker, retention-gc-worker, audit-anchor-publisher and
audit-chain-verify-worker log groups, and the `rls-bypass-not-granted` alarm
fires on `Sum >= 1` in 5 minutes (`infra/terraform/monitoring.tf`). Operator
scripts write the same record to stderr.

On AWS all five processes have a managed log group, each with all three filters
(`rls.bypass_not_granted`, `rls.bypass_refused` and `rls.bypass_notice_unparsed`). On docker compose
the publisher and the verify worker have no service (the compose files do not
define them yet); wherever they run, collect their stdout and match the same
`_logType`. A positive canary for each filter is part of the checklist before a
deploy that flips the database (`docs/operations/deployment.md`).

Datadog: `{ _logType="rls.bypass_not_granted" OR _logType="rls.bypass_refused" OR _logType="rls.bypass_notice_unparsed" }`

A line `rls.bypass_notice_unparsed` means a WARNING or a refusal came from
`rls_bypass_admits` but did not match the expected text, or the log sink threw
while recording a report. The listener logs it with no content, at most once
per process per minute. The likely causes are that the function and the
listener disagree on the message format (including the function's frame no
longer being `public.rls_bypass_admits(text)`, as when its `SET search_path`
is dropped), or that the logger or its output stream failed: the process's
other output around that time shows a sink fault. It is counted on the same
`RlsBypassNotGranted` metric and fires the same alarm, so neither is read as
zero reports.

## `rls.bypass_refused`

Emitted by the same pool listener in `src/lib/db/pool-factory.ts`, from the
error that refuses the statement (SQLSTATE 42501, `RLS_BYPASS_NOT_GRANTED:
<table>`, raised by `public.rls_bypass_admits`) rather than from the WARNING
before it. The line names `table` and `purpose`, as `rls.bypass_not_granted`
does, and is rate-limited the same way, separately from it.

It exists because the WARNING can be kept from the client: a
`client_min_messages` above `warning`, set on the role or database between
deploys, suppresses it, and a caller that catches the 42501 then leaves no
trace. The error is always delivered to the client, unless SQL itself catches
it in an `EXCEPTION` handler that does not re-raise (none does today). The
line is taken on the connection before any caller sees the error, so a
swallowed refusal still counts. It exists only on an enforcing database; in
report mode nothing is refused.

All three RLS lines are written at warn. When `LOG_LEVEL` is above `warn`
(`error` or `fatal`, the env schema's values above `warn`; pino's `silent`
takes the same path), the pool listener writes them straight to stderr
as the same JSON line, so the filters still match.

Normally a refusal produces both lines, so one refused statement counts twice
on `RlsBypassNotGranted`; a refusal line without its `rls.bypass_not_granted`
line in the same group and window means the WARNING is being suppressed.
Find where `client_min_messages` comes from and remove it: in report mode it
would silence every report. As the service's role, `SELECT setting, source
FROM pg_settings WHERE name = 'client_min_messages'` names the source:

- `user`, `database`, `database user` or `global`: a catalog setting from
  `ALTER ROLE` / `ALTER DATABASE … SET` (`global` is `ALTER ROLE ALL SET`), all
  listed in `pg_db_role_setting`;
- `client`: the connection's startup options (`PGOPTIONS`, or `options=` in the
  connection string). The service's own pools refuse these, so this is your own
  psql session's setting; check its shell and connection string;
- `configuration file`, `command line` or `environment variable`: a
  server-level setting, such as an RDS parameter group;
- `session`: your own session ran `SET`; reconnect and query again;
- `default`: no persistent setting. The remaining cause is a `SET
  client_min_messages` run by the service's code, which no other session can
  see: search the code for `client_min_messages`.

**Severity**: medium
**Trigger**: any occurrence. The normal count is 0.
**Recovery**: as for `rls.bypass_not_granted` above.

CloudWatch: the `RlsBypassNotGranted` metric, one filter per log group
(`rls_bypass_refused` in `infra/terraform/monitoring.tf`), and the same
`rls-bypass-not-granted` alarm. Operator scripts write the same record to
stderr.

## `auth.tenant_claim.binding_refused`

Emitted at warn level by the claim-binding adjudicator in
`src/lib/tenant/tenant-management.ts`. It fires when strict binding refuses a
sign-in because its tenant claim cannot be used through the provider it
arrived on. The call site sets no `_logType`, so
match on `msg`. Fields:

- `tenantId`: the tenant that owns the claim.
- `boundProvider`: the row's binding, or `null` for an unbound row.
- `signInProvider`: the raw ID of the provider the sign-in came through.
- `verdict`: `unbound` or `provider_mismatch`.

The matching `AUTH_LOGIN_FAILURE` audit row has the reason
`tenant_claim_unbound` or `tenant_claim_provider_mismatch`. That row is
readable by the owning tenant's admins, so it carries the sign-in provider
only as `signInProviderRef`. This line, which only operators see, carries both
raw IDs.

**Severity**: `provider_mismatch` is high on every occurrence. It is the
signature of one Jackson connection's IdP asserting another customer's claim.
`unbound` is low during an upgrade and medium after it.
**Trigger**: any `provider_mismatch`. For `unbound`, any occurrence once the
[upgrade](../../README.md#sso-tenant-claim-binding-upgrade) is complete. The
normal count of both is 0.
**Recovery**: run `tenant-domain unmapped`. It lists these denials under the
provider-binding heading, which says to investigate first. For a mismatch,
first establish which customer the presenting connection belongs to. Do not
bind the claim to it to make the denial stop. If a sign-in through another
customer's provider created the bound tenant, re-point the claim to the
rightful tenant with `add --from … --provider <theirs>`. For an unbound row
whose tenant is the rightful owner, bind it with `tenant-domain bind`.

## `auth.tenant_claim.provider_mismatch`

Emitted at warn level from the same place, in `off` mode only: one SSO
provider is configured, and strict binding was not opted in. A sign-in
presented a claim whose row is bound to a different provider. The claim
**resolved anyway**, because off mode does not enforce the binding. Fields:
`tenantId`, `boundProvider`, `signInProvider`. With one claim provider, the
line fires only for rows bound to a provider the deployment no longer
configures: a renamed `AUTH_JACKSON_CONNECTIONS` `id`, or a Google or Jackson
provider removed from the env.

**Severity**: medium.
**Trigger**: any occurrence. The normal count is 0.
**Recovery**: find out why the row's provider is no longer configured. A
renamed connection `id` also orphans that connection's accounts, so restore
the old `id` rather than rebinding. Otherwise rebind the claim with
`tenant-domain bind` to the provider its tenant now signs in through. Then
consider `AUTH_CLAIM_BINDING=strict`, under which this sign-in would have been
refused.

## `AUTH_LOGIN_FAILURE` with reason `account_not_linked`

An audit row, not a log line: the signIn callback in `src/auth.ts` refused an
OAuth/OIDC sign-in whose provider account is linked to no user while the email
it asserts names an existing user, through a provider that does not link by
email ([Audit Log Schema](../security/audit-log-schema.md#account_not_linked)).
Nothing was written for that user. The row's `userId` is the user the email
names and its tenant is that user's. `metadata.provider` is the audit enum
(`google`, `saml`), so the row does not say which Jackson connection the
sign-in came through. `tenant-domain unmapped` does not list it: it is not a
claim denial.

The same row has three causes:

- **Attack**: an IdP asserting another user's email, the case the refusal
  exists for. Typically one user, with no account at that provider, and few
  denials.
- **Upgrade lockout**: after the
  [binding upgrade](../../README.md#sso-tenant-claim-binding-upgrade), a
  deployment of the Known-lockout class sees many distinct users of one or
  more tenants refused through `saml`, starting at the cutover. Run
  `tenant-domain legacy-accounts` and follow the README's Known lockout.
- **A user's own mistake**: signing in through a provider other than the one
  their account was created with.

**Severity**: medium. High for a denial whose user holds no account at that
provider and is an admin or owner, outside the upgrade window.
**Trigger**: any occurrence outside the upgrade window; during it, a count
that keeps rising after the cutover. The normal count is 0.
**Recovery**: group the denials (query below). Many users of one tenant
starting at the cutover is the lockout: those users must be re-provisioned.
For a single user, ask them how they signed in. If they did not, treat it as
an IdP asserting their email: correlate by time with Jackson's or Google's
logs to find the connection, and review that connection's IdP. Never link the
account by hand to make the denial stop.

Run it on a privileged connection (`MIGRATION_DATABASE_URL`; `audit_logs` has
FORCE ROW LEVEL SECURITY). Widen the interval as needed:

```sql
SELECT tenant_id,
       metadata->>'provider'   AS provider,
       count(*)                AS denials,
       count(DISTINCT user_id) AS users,
       min(created_at)         AS first_seen,
       max(created_at)         AS last_seen
  FROM audit_logs
 WHERE action = 'AUTH_LOGIN_FAILURE'
   AND metadata->>'reason' = 'account_not_linked'
   AND created_at > now() - interval '7 days'
 GROUP BY tenant_id, metadata->>'provider'
 ORDER BY denials DESC;
```

## `csp.violation`

Emitted by `/api/csp-report` when the browser reports a CSP
violation. Most are benign (extensions, ad-blockers); investigate
spikes.

**Severity**: low (per-event); medium (volume anomaly)
**Trigger**: 10x baseline rate over 1 hour
**Recovery**: examine `violatedDirective` / `blockedURI` patterns;
either update CSP allowlist or block the offending source.

Datadog: `{ _logType="csp.violation" } | rate`

## SIEM Forwarding

The app forwards structured logs via pino to stdout. For SIEM:

- **Container deploy**: tail container logs, ship to Loki/Splunk/Datadog.
- **Dedicated forwarder**: set `AUDIT_LOG_FORWARD` env to enable.

Strip the following fields before storage if your SIEM doesn't
support hashed identifiers — they are already PII-safe but
duplicate-data concerns may apply:
- `identifierHash` (16-hex from auth-failure events)

## External Timestamp Anchors (A09-5)

Audit chain integrity uses the DB clock for `created_at`. A
compromised DB could rewrite history with consistent timestamps.
Defense-in-depth: publish the periodic chain anchor to a third-
party timestamping service so any forged chain past the publish
point can be disproven by the external record.

The anchor publisher (`src/lib/audit/anchor-manifest.ts`) emits a
signed manifest at the configured cadence. Routing options to add
in operator config:

- **Sigstore Rekor** (free, public log): POST the anchor digest
  to `https://rekor.sigstore.dev/api/v1/log/entries`.
- **Public NTS / NTP-signed** timestamp (e.g., Cloudflare time):
  embed an NTS timestamp in the manifest before signing.
- **AWS QLDB** or **Azure Confidential Ledger**: append-only ledger
  with cryptographic verification, customer-managed.
- **Internal SIEM** that uses a separate clock source: forward the
  manifest event via the standard pino → SIEM path and require the
  SIEM to record its own ingest timestamp.

Operators MUST pick at least one external destination before
treating the audit chain as evidentiary. Without external anchoring
the chain detects tampering within the database boundary only. On AWS
that destination is the Terraform-managed S3 Object Lock bucket (see
"Audit anchor publisher" above).
