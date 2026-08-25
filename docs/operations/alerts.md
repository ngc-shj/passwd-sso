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

## `audit-chain-verify-heartbeat`

Emitted by `scripts/audit-chain-verify-worker.ts` on every hourly
tick. Absence indicates the chain verifier is silently down — chain
tampering would go undetected.

**Severity**: high
**Trigger**: no event for > 2 hours
**Recovery**: restart `worker:audit-chain-verify` service; check
DB SELECT permissions on `audit_logs` and `tenants`.

Datadog: monitor on `absence(_logType="audit-chain-verify-heartbeat") for 2h`
Sentry Cron Monitor: register `audit-chain-verify` with schedule `0 * * * *`.

## `CHAIN_VERIFY_FAILED` (audit event)

Stored in `audit_logs` (NOT a pino log). The audit-chain-verify
worker writes this when a tenant's chain detects tampering. Read
via standard audit-log queries OR via SIEM if you forward audit
events.

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
