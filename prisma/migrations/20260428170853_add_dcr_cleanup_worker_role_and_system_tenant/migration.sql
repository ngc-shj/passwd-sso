-- Create the dcr-cleanup worker role (no password — set out-of-band via initdb or scripts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_dcr_cleanup_worker') THEN
    CREATE ROLE passwd_dcr_cleanup_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grant database access (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_dcr_cleanup_worker', current_database());
END $$;

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_dcr_cleanup_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_dcr_cleanup_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_dcr_cleanup_worker;

-- Minimal schema access
GRANT USAGE ON SCHEMA public TO passwd_dcr_cleanup_worker;

-- Minimum table privileges:
--   mcp_clients:  SELECT to read target rows for the DELETE; DELETE to remove them.
--   audit_outbox: SELECT for ON CONFLICT (idempotency) checks; INSERT to enqueue
--                 SYSTEM-attributed audit rows for the cleanup operation.
--   tenants:      SELECT for FK existence check inside enqueueAuditInTx
--                 (the sentinel tenant row inserted below).
-- The worker uses raw `SELECT set_config('app.bypass_rls', 'on', true)` inside its
-- own tx to make tenant_id IS NULL rows in mcp_clients visible — NOBYPASSRLS at the
-- role level is independent from the GUC the application checks.
GRANT SELECT, DELETE ON TABLE "mcp_clients" TO passwd_dcr_cleanup_worker;
GRANT SELECT, INSERT ON TABLE "audit_outbox" TO passwd_dcr_cleanup_worker;
GRANT SELECT ON TABLE "tenants" TO passwd_dcr_cleanup_worker;

-- Insert sentinel tenant row used solely for SYSTEM-scope audit attribution.
-- The corresponding TS constant is SYSTEM_TENANT_ID in src/lib/constants/app.ts.
-- IMPORTANT: this migration creates ONLY the tenants row. NO tenant_members,
-- NO tenant_policies, NO tenant_webhooks. Zero memberships is what prevents
-- tenant-admin endpoints from elevating to it (no logged-in user can resolve
-- their actor.tenantId to the sentinel).
INSERT INTO "tenants" (id, name, slug, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000002'::uuid,
  '__system__',
  '__system__',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
