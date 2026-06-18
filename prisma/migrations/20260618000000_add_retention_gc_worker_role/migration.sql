-- Create the retention-gc worker role (no password — set out-of-band via initdb or scripts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    CREATE ROLE passwd_retention_gc_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grant database access (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_retention_gc_worker', current_database());
END $$;

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_retention_gc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_retention_gc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_retention_gc_worker;

-- Prevent implicit REFERENCES grants on future tables (defense-in-depth).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_retention_gc_worker;

-- Minimal schema access
GRANT USAGE ON SCHEMA public TO passwd_retention_gc_worker;

-- EXPIRY registry table privileges:
--   SELECT to identify target rows for batch-bounded DELETE;
--   DELETE to remove them.
-- The worker sets bypass_rls GUC inside each transaction so NOBYPASSRLS at the
-- role level is independent from the application-level GUC check (globalDelete).
GRANT SELECT, DELETE ON TABLE "mcp_clients" TO passwd_retention_gc_worker;
GRANT SELECT, DELETE ON TABLE "sessions" TO passwd_retention_gc_worker;
GRANT SELECT, DELETE ON TABLE "verification_tokens" TO passwd_retention_gc_worker;
GRANT SELECT, DELETE ON TABLE "extension_bridge_codes" TO passwd_retention_gc_worker;
GRANT SELECT, DELETE ON TABLE "mobile_bridge_codes" TO passwd_retention_gc_worker;
GRANT SELECT, DELETE ON TABLE "mcp_authorization_codes" TO passwd_retention_gc_worker;

-- PER_TENANT_FN: enumerate tenants with non-null auditLogRetentionDays
-- and invoke the audit_log_purge SECURITY DEFINER function per tenant.
-- No direct audit_logs DELETE grant — deletion is exclusively via the definer fn.
GRANT SELECT ON TABLE "tenants" TO passwd_retention_gc_worker;

-- EXECUTE on the audit_log_purge definer function (signature must match exactly).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) TO passwd_retention_gc_worker;
  END IF;
END
$$;

-- audit_outbox: SELECT for ON CONFLICT (idempotency) checks; INSERT to enqueue
-- SYSTEM-attributed heartbeat rows per sweep cycle.
GRANT SELECT, INSERT ON TABLE "audit_outbox" TO passwd_retention_gc_worker;

-- tenants is the ONLY other table the worker reads: the heartbeat emit path
-- (enqueueAuditInWorkerTx) does an EXISTS check on tenants, and audit_outbox's
-- only FK is to tenants. The worker never reads users/teams/service_accounts —
-- the audit row is enqueued to audit_outbox, not delivered to audit_logs (the
-- outbox worker, with its own grants, performs that delivery). Granted above.
