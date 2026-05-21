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
