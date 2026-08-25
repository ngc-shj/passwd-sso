# Operational Alert Hooks

Audit-pipeline events that should drive operator alerts. These are
emitted by the application/workers via pino structured logs (and
Sentry for error-level events). Pipe pino → your SIEM, then add the
rules below.

All structured logs include a `_logType` field on the alerting paths.
Match on that.

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

> **⚠️ Known gap — this record is not durable, and the default deployment does
> not forward it.** Tracked as an open security risk; not fixed.
>
> For the `tenant_not_found` reason (`src/lib/audit/audit.ts`, in
> `logAuditAsync` and `logAuditBulkAsync`) the function returns **without**
> enqueuing anything, so there is no `audit_outbox` row and no `audit_logs`
> row. The stdout line is the only record that the audit event existed.
>
> Two things then work against it:
> - `infra/fluent-bit/fluent-bit.conf` matches `_logType ^(audit|app)$`, so the
>   audit-log-forwarding overlay **drops** `audit-dead-letter` before any output
>   plugin sees it. Adopting that overlay does not make this record leave the
>   host.
> - Container logs are capped at `max-size: 20m` × `max-file: 5`
>   (`docker-compose.yml`). Ordinary application logging can therefore push the
>   record out of the retention window. Before the cap existed the log grew
>   until the disk filled — which is the incident the cap was added for — so
>   this is a narrowed window, not a new loss, but it is narrower.
>
> **What to do until it is fixed**: if you rely on dead-letter alerting, do not
> rely on the shipped forwarder. Ship the raw container stdout (not the
> `docker-compose.logging.yml` overlay) to a durable sink, or widen the Fluent
> Bit `Regex` to include `audit-dead-letter` yourself — noting that the record
> then carries whatever a caller passed, including error text, so review what
> your sink retains.
>
> **The fix** is to persist `tenant_not_found` to a durable dead-letter table
> rather than only to stdout, so alerting stops depending on log retention.

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
**Recovery**: read `err` on the log line. Two known causes:

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
`src/lib/tenant-rls.ts`. Note this is a convention, not an enforced
invariant — no gate currently derives the set of RLS-table reads and
checks each one is wrapped, so a new unwrapped read will not be
caught at review time.

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

The same heartbeat line carries `tenantCount`, `verifiedTenantCount`
and `erroredTenantCount`. A tick that verified only some tenants must
never read as a verified fleet, so alert on the counts, not on
absence.

**Severity**: high
**Trigger**: `verifiedTenantCount < tenantCount`
**Recovery**: the accompanying `tick incomplete` stderr line names the
failing tenant ids. `RLS_CONTEXT_MISSING` there means the worker lost
its RLS context and its reads would have returned zero rows — treat as
"the verifier is inert", not as a per-tenant blip. `P2028` means the
read outgrew `AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS` (default 60s); raise it
or lower `AUDIT_CHAIN_VERIFY_MAX_ROWS`.

Datadog: `{ _logType="audit-chain-verify-heartbeat" } | verifiedTenantCount < tenantCount`
Loki: `{_logType="audit-chain-verify-heartbeat"} | json | verifiedTenantCount < tenantCount`

## `CHAIN_VERIFY_FAILED`

Emitted by `scripts/audit-chain-verify-worker.ts` when a tenant's
chain shows tampering, with hysteresis (re-emit on clean → failed,
then every 24h while still failed).

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
