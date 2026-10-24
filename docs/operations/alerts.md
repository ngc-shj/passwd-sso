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
permissions on `audit_logs` and `tenants`. On ECS it connects as `passwd_app`
through the app secret's `DATABASE_URL`, so a rotated app password reaches it
only when its task restarts.

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
  `public.rls_bypass_admits` or, once enforce mode ships (#921), when
  the grant does not name `tenants`.
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
`chainEnabledTenantCount`. A run that failed at the upload or after it is
retried for the same boundary every 15 minutes until 30 minutes before the next
boundary (23:35 UTC); a failure before the upload, `lock_held` and
`upload_cap_reached` wait for the next boundary or the next boot run.

On AWS every filter below reads `/ecs/<name_prefix>/audit-anchor-publisher`, and
every alarm notifies the SNS alarm topic (`infra/terraform/monitoring.tf`).

To get a boot run now — after fixing a cause that the next boundary would
otherwise wait for — restart the service on the same task definition:

```bash
aws ecs update-service --cluster <cluster> --service <name_prefix>-audit-anchor-publisher \
  --force-new-deployment --region <region>
```

Reading what the database holds (as the owner role; `system_settings` admits
only a bypassed session):

```sql
BEGIN READ ONLY;
SET LOCAL app.bypass_rls = 'on';
SET LOCAL app.bypass_tables = 'system_settings';
SET LOCAL app.bypass_purpose = 'system_maintenance';
SELECT key, value, updated_at FROM system_settings
WHERE key LIKE 'audit_anchor_%' ORDER BY key;
ROLLBACK;
```

`audit_anchor_last_published_boundary` is the boundary marker,
`audit_anchor_previous_manifest` the pointer the next manifest chains to, and
`audit_anchor_upload_attempts` the attempt count (`{boundary, count}`).

## `audit-anchor-publisher.cadence_healthy`

Logged once per healthy boundary, and only then: a `published` run, or a
`skipped_no_tenants` run on an install where no tenant has ever enabled the
chain (`everChainEnabled: false`, decided by the absence of any
`audit_chain_anchors` row). `skipped_already_published`, `failed`,
`upload_cap_reached` and `lock_held` never emit it: the boundary marker is a
database row, so a skip must not read as health.

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
the marker was written by something other than a publish — treat it as a
database-write incident (the publisher trusts `system_settings`; see
`docs/security/audit-anchor-verification.md`).

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
**What it means**: three runs for this boundary already passed the marker and
tenant checks — each counted in `audit_anchor_upload_attempts` before it could
upload — so this run uploaded nothing. The first run past the cap writes one
`AUDIT_ANCHOR_PUBLISH_FAILED` row (`failureReason: UPLOAD_ATTEMPT_CAP_REACHED`);
later runs for the same boundary log only. The cap exists so that a crash loop
or a retry storm cannot lock more versions of the day's key.
**Recovery**: read the boundary's earlier `cadence_failed` lines for the cause
(and ECS task-stop events, for a crash loop). A count nobody's runs explain is a
planted row — a database-write incident. The count resets on its own: the next
boundary's first run counts 1 and publishes. The missed boundary is then
reported once as `MISSING_PRIOR_CADENCE_PUBLICATION`.

## `audit-anchor-publisher.commit_failed_after_upload`

**Severity**: high
**Trigger**: any occurrence (alarm
`<name_prefix>-audit-anchor-publisher-commit-failed-after-upload`).
**What it means**: every destination accepted the manifest, then the publish
transaction did not commit (a database error, the 90 s transaction bound, a lost
connection). The object is stored, the pointer and marker are not. No pause is
written — the destination is healthy. The scheduler retries the boundary every
15 minutes; the retry PUTs the same key again, so the bucket keeps both
versions, and the one the next manifest's `previousManifest` names is the
committed one.
**Recovery**: read `error.code` on the line and check the database. Confirm a
later `published` line for the same `boundary`. If none follows before the next
boundary, that version stays unreferenced and the next publish reports
`MISSING_PRIOR_CADENCE_PUBLICATION`.

## `audit-anchor-publisher.cadence_failed` / `audit-anchor-publisher.upload_failed`

**Severity**: high
**Trigger**: any occurrence (alarms
`<name_prefix>-audit-anchor-publisher-cadence-failed` and
`<name_prefix>-audit-anchor-publisher-upload-failed`).
**What it means**: `cadence_failed` is every failed run, with `reason` (a token,
also written to the `AUDIT_ANCHOR_PUBLISH_FAILED` row) and `stage`:

- `before_upload` — the run failed before uploading: the database unreachable,
  the signing step, or an `audit_anchor_previous_manifest` that does not parse.
  It still cost an attempt, and it is **not** retried in-process: it would fail
  the same way again. Fix it and restart the service for a boot run, or the
  boundary is missed until the next one.
- `upload` — a destination refused or the 60 s upload bound fired
  (`UPLOAD_TIMEOUT`). `upload_failed` names the destination and carries
  `error.code` (`AccessDenied` usually means the bucket policy or the task role
  drifted from Terraform). The run also pauses the manifest's tenants until the
  next boundary: the audit-outbox worker stops advancing their chains, and the
  15-minute retry that publishes clears it.
- `after_upload` — see `commit_failed_after_upload` above.

At most three failure rows per boundary, plus the one cap row.

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

Warn level, not alarmed. A publish found that no chain-enabled tenant's
`last_published_at` reaches the previous boundary, and wrote one
`AUDIT_ANCHOR_PUBLISH_FAILED` row (`failureReason:
MISSING_PRIOR_CADENCE_PUBLICATION`) after its own commit. It never stops the
publish.

Expected **once**, on the first publish after a tenant enables the chain. Any
later occurrence means a boundary was never committed — the publisher was down
for that whole day, every attempt failed, or the cap was reached. In the bucket
that day's key may hold versions no manifest references, which
`docs/security/audit-anchor-verification.md` treats as expected only in exactly
this case.

## `audit-anchor-publisher.lock_held`

Info level, not alarmed, not a failure: the run waited 10 s (`lock_timeout`) for
the publish lock another run held, and stood down. It writes no failure row and
no pause; the other run publishes. On ECS the service runs at most one task, so
a recurring `lock_held` means a second publisher is running somewhere against
this database — find it.

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

## `rls.bypass_not_granted`

Emitted by the pool listener in `src/lib/db/pool-factory.ts`. The database
raised it when a bypassed statement examined a row of a table that is not
in the bypass's grant (`app.bypass_tables`). The line names `table` and
`purpose`. It is rate-limited to one line per (table, purpose) per process
per minute.

In report mode the statement was **admitted**. The line records a grant that
is missing a table. Once enforce mode ships (#911), the same reach is
refused.

**Severity**: medium
**Trigger**: any occurrence. The normal count is 0.
**Recovery**: find the code path that serves `purpose` and reaches
`table`. Then either add the table's model to that grant in
`BYPASS_GRANT`, or stop the path from reaching the table. Do this before
enforce mode is turned on.

CloudWatch: the `RlsBypassNotGranted` metric. There is one filter each on
the app, audit-outbox-worker, retention-gc-worker, audit-anchor-publisher and
audit-chain-verify-worker log groups, and the `rls-bypass-not-granted` alarm
fires on `Sum >= 1` in 5 minutes (`infra/terraform/monitoring.tf`). Operator
scripts write the same record to stderr.

**Not covered:** outside AWS the publisher and the verify worker have no
managed log group (the compose files do not define them yet); wherever they
run, collect their stdout and match the same `_logType`. A positive canary for
each filter is a precondition of enforce mode.

Datadog: `{ _logType="rls.bypass_not_granted" OR _logType="rls.bypass_notice_unparsed" }`

A line `rls.bypass_notice_unparsed` means a WARNING came from
`rls_bypass_admits` but did not match the expected text. The listener
logs it with no content, at most once per process per minute. The likely
cause is that the function and the listener disagree on the message
format. It is counted on the same `RlsBypassNotGranted` metric and fires
the same alarm, so a format drift is not read as zero reports.

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
