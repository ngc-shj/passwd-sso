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
SELECT action, actor_type, COUNT(*) AS n, MAX(created_at) AS latest
FROM audit_logs
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'   -- the sentinel tenant (name/slug: __system__)
GROUP BY action, actor_type
ORDER BY n DESC;
```

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

**The two remaining reasons** — `logAuditAsync_failed` and
`logAuditBulkAsync_failed` — mean the **database was unreachable**, so the
recovery action is different: check DB connectivity and the `audit_outbox` write
path, not tenant mapping. No durable record is possible for them by any design,
because the write that would carry it is the one that failed.

> **Note on the forwarder.** `infra/fluent-bit/fluent-bit.conf` still carries
> `Exclude _logType ^audit-dead-letter$`, and that is now harmless: the two
> remaining reasons fire only when the database is unreachable, and in that state
> nothing durable can be written anyway. Container logs remain capped at
> `max-size: 20m` × `max-file: 5` (`docker-compose.yml`). Removing the exclusion
> is an operator decision, not a required fix.

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
> SELECT audit_log_retention_days, audit_chain_enabled
> FROM tenants WHERE id = '00000000-0000-4000-8000-000000000002';
> ```
>
> **On the first sweep after that migration, sentinel rows older than that window
> are deleted.** On a deployment that has been running long enough to have them,
> that is a one-off drop. To see what will go — computed from the tenant's own
> value, not from an assumed 365:
>
> ```sql
> SELECT count(*), min(a.created_at), max(a.created_at)
> FROM audit_logs a
> JOIN tenants t ON t.id = a.tenant_id
> WHERE a.tenant_id = '00000000-0000-4000-8000-000000000002'
>   AND a.created_at < now() - make_interval(days => t.audit_log_retention_days);
> ```
>
> If any of it is under investigation, **export it** — a `SELECT` in a session is
> not a copy. `\copy (…) TO 'sentinel-audit-<date>.csv' CSV HEADER` from `psql`,
> or `pg_dump --data-only --table=audit_logs` with the same predicate, before the
> next `retention-gc-worker` run.
>
> The retention is safe here only because `__system__` has
> `audit_chain_enabled = false`: a purge does not renumber `chain_seq`, so on a
> chained tenant a default `fromSeq=1` verify would report a false TAMPER (see
> `docs/security/audit-chain-threat-model.md#retention-purge-interaction`). The
> migration **checks** that flag and refuses rather than assuming it, and the
> integration suite asserts both the retention and the flag together. If you ever
> enable the chain on `__system__`, fix the verify's start sequence first — the
> retention is already set, so the interaction becomes real at that moment.

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
`src/workers/audit-outbox-worker.ts` the local helper is
`setBypassRlsGucs`; elsewhere use `withBypassRls` from
`src/lib/tenant-rls.ts`. `scripts/checks/check-rls-read-context.mjs`
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
**Recovery**: restart `worker:audit-chain-verify` service; check
DB SELECT permissions on `audit_logs` and `tenants`.

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
on the right. `erroredTenantCount` is equivalent by construction,
because every tenant increments exactly one of the two counters.)
**Recovery**: the accompanying `tick incomplete` stderr line names the
failing tenant ids. `RLS_CONTEXT_MISSING` there means the worker lost
its RLS context and its reads would have returned zero rows — treat as
"the verifier is inert", not as a per-tenant blip. `P2028` means the
read outgrew `AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS` (default 60s); raise it
or lower `AUDIT_CHAIN_VERIFY_MAX_ROWS`.

Datadog: `@_logType:audit-chain-verify-heartbeat @erroredTenantCount:>0`
Loki: `{_logType="audit-chain-verify-heartbeat"} | json | erroredTenantCount > 0`

## audit-chain tamper detected

**Severity**: critical
**Trigger**: `failedTenantCount > 0` on the heartbeat line
**Recovery**: treat as a possible audit-log rewrite. The
`CHAIN_VERIFY_FAILED` stderr line below carries the reason and the
first offending `chain_seq`.

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
the chain detects tampering within the database boundary only.
