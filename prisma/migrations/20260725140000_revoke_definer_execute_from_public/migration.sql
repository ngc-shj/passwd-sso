-- Revoke EXECUTE on the SECURITY DEFINER audit routines from PUBLIC.
--
-- PostgreSQL grants EXECUTE on new functions/procedures to PUBLIC by DEFAULT.
-- 20260522000200_audit_log_revoke_via_definer created audit_log_tenant_migrate
-- and audit_log_purge as SECURITY DEFINER and then GRANTed EXECUTE to
-- passwd_app — but that grant was redundant, and the default PUBLIC grant was
-- never removed. Every role could therefore call them.
--
-- That defeats the purpose of the original migration: it REVOKEs UPDATE/DELETE
-- on audit_logs from passwd_app precisely so the app cannot mutate audit records
-- arbitrarily, while these routines perform exactly those mutations with the
-- OWNER's privileges. A compromised passwd_outbox_worker or
-- passwd_retention_gc_worker — roles that are supposed to have no access to
-- audit_logs beyond their narrow grants — could delete or re-tenant any tenant's
-- audit log by calling audit_log_purge / audit_log_tenant_migrate.
--
-- Fix: revoke from PUBLIC, then grant back only to the role that legitimately
-- calls them (passwd_app, from auth.ts and /api/maintenance/purge-audit-logs).
-- Also set a default so FUTURE functions in this schema are not PUBLIC-executable.

BEGIN;

-- 1. Remove the implicit PUBLIC grant on both routines.
REVOKE EXECUTE ON PROCEDURE audit_log_tenant_migrate(UUID, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) FROM PUBLIC;

-- 2. Re-assert the intended grant (idempotent; the original migration issued it,
--    but it was indistinguishable from the PUBLIC grant until now).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT EXECUTE ON PROCEDURE audit_log_tenant_migrate(UUID, UUID, UUID) TO passwd_app;
    GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) TO passwd_app;
  END IF;
END
$$;

-- 3. Prevent the same trap for functions added later: strip the default PUBLIC
--    EXECUTE grant for objects created by the migration role in this schema.
--    (ALTER DEFAULT PRIVILEGES only affects FUTURE objects, hence steps 1-2.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
