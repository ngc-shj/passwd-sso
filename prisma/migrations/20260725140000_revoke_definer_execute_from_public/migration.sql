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
-- Fix: revoke from PUBLIC, then grant back only to the roles that legitimately
-- call them. This migration re-asserts passwd_app (auth.ts tenant merge,
-- /api/maintenance/purge-audit-logs); passwd_retention_gc_worker keeps its
-- separate, explicit grant on audit_log_purge from
-- 20260618000000_add_retention_gc_worker_role — the retention worker purges
-- audit logs by design. Net result: app + retention worker on audit_log_purge,
-- app only on audit_log_tenant_migrate, PUBLIC and the outbox worker on neither.

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

-- 3. Prevent the same trap for functions added later.
--
--    NOT `IN SCHEMA public`. The schema-scoped form can only undo a matching
--    schema-scoped GRANT; it cannot cancel PostgreSQL's BUILT-IN global default
--    of granting EXECUTE on new functions to PUBLIC, so it is a silent no-op
--    here (verified: with it, a newly created function was still
--    PUBLIC-executable, and no pg_default_acl row was created). The unscoped
--    form targets the default actually in force.
--
--    This applies to objects created by THIS role in any schema, and only to
--    FUTURE objects — hence steps 1-2 for the two that already exist.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
