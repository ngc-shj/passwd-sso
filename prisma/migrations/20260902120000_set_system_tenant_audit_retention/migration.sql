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
-- 365 days, matching the only tenant in the authoring deployment that had set a
-- retention at all. The retention-GC clamps anything below
-- `AUDIT_LOG_RETENTION_MIN` (30) up to it, so a shorter value would not mean
-- what it said.

-- ─── The safety condition, CHECKED rather than assumed ────────────────────────
--
-- Setting a retention is safe here only because the sentinel's chain is off.
-- `audit_log_purge` does not renumber `chain_seq`, so on a chained tenant a
-- default `fromSeq=1` verify reports a false TAMPER at the first retained row
-- (docs/security/audit-chain-threat-model.md #retention-purge-interaction).
-- `audit_chain_enabled` is `false` by schema default and was never flipped for
-- the sentinel in the authoring deployment — but that is a fact about ONE
-- database, and this file runs against every one of them.
--
-- So it refuses rather than proceeding. Failing the migration is the safe
-- outcome: an operator who has deliberately enabled the chain on the sentinel
-- gets to decide what happens next, and silently turning it off to make the
-- retention safe would destroy a control they chose. Silently setting the
-- retention anyway would arm a false TAMPER at their next verify.
DO $$
DECLARE
  v_chain_enabled BOOLEAN;
BEGIN
  SELECT "audit_chain_enabled" INTO v_chain_enabled
    FROM "tenants"
   WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid;

  -- No sentinel row: nothing to set, and not this migration's business to
  -- create one (20260428170853 owns that). Leave it to the gate that ties the
  -- literal to the constant.
  IF v_chain_enabled IS NULL THEN
    RAISE NOTICE 'sentinel tenant row absent; skipping retention set';
    RETURN;
  END IF;

  IF v_chain_enabled THEN
    RAISE EXCEPTION
      'refusing to set a retention on the sentinel tenant: audit_chain_enabled is true. %',
      'A purge does not renumber chain_seq, so a retention here arms a false TAMPER at the '
      'next fromSeq=1 verify. Decide explicitly — disable the chain on __system__, or fix the '
      'verify start sequence first — then re-run. See '
      'docs/security/audit-chain-threat-model.md#retention-purge-interaction and '
      'docs/operations/sentinel-tenant-membership.md.';
  END IF;

  -- Only where nothing is set. An operator who has already chosen a retention
  -- for this tenant has made this decision; do not overwrite it.
  UPDATE "tenants"
     SET "audit_log_retention_days" = 365
   WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid
     AND "audit_log_retention_days" IS NULL;
END
$$;
