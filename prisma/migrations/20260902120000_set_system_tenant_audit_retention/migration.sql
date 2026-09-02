-- The sentinel tenant's audit rows were never purged, and two pre-auth paths can
-- create them.
--
-- `sweepAuditLogs` enumerates only tenants with `audit_log_retention_days IS NOT
-- NULL` (src/workers/retention-gc-worker/sweep.ts), so a NULL sentinel was
-- permanently excluded from retention. Meanwhile `/api/extension/token` and
-- `/api/mcp/register` emit under this tenant without authentication — the
-- per-IP limiter bounds the RATE, not the total — and the outbox drain is a
-- single all-tenant FIFO claimed `FOR UPDATE SKIP LOCKED` over the whole table,
-- so a sustained inflow here also delays other tenants' audit delivery.
--
-- 365 days, matching the only tenant in this deployment that had set a retention
-- at all. The retention-GC clamps anything below `AUDIT_LOG_RETENTION_MIN` (30)
-- up to it, so a shorter value would not mean what it said.
--
-- WHY THIS IS SAFE HERE AND WAS NOT ASSUMED TO BE. The recorded reason for
-- leaving it NULL was that a retention would incur the chain-verify interaction:
-- `audit_log_purge` does not renumber `chain_seq`, so a default `fromSeq=1`
-- verify reports a false TAMPER at the first retained row
-- (docs/security/audit-chain-threat-model.md #retention-purge-interaction).
-- That interaction is real and does not apply to THIS tenant: the sentinel's
-- `audit_chain_enabled` is false — the schema default, never flipped for it —
-- so there is no chain to falsify. Measured on the database, not inferred.
--
-- If the chain is ever enabled on the sentinel, that interaction becomes real
-- and this value is what makes it so; fix the verify's start sequence first.
UPDATE "tenants"
   SET "audit_log_retention_days" = 365
 WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid
   AND "audit_log_retention_days" IS NULL;
