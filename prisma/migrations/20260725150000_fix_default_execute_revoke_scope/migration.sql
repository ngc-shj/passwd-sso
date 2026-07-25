-- Fix the scope of the default-privilege REVOKE added in
-- 20260725140000_revoke_definer_execute_from_public.
--
-- That migration used:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- which has NO EFFECT here. `ALTER DEFAULT PRIVILEGES IN SCHEMA <s>` can only
-- undo a matching schema-scoped GRANT; it cannot cancel PostgreSQL's BUILT-IN
-- global default of granting EXECUTE on new functions to PUBLIC. Verified: after
-- that migration, a newly created function was still PUBLIC-executable.
--
-- Dropping `IN SCHEMA public` targets the global default, which is the one
-- actually in force. Verified: with this form, a newly created function has
-- PUBLIC EXECUTE = false.
--
-- Why this matters beyond the audit: scripts/audit-db-grants.mjs does flag a
-- PUBLIC-executable function, but it runs AFTER the migration has committed, so
-- the over-permissive function is already live until someone reacts. This is the
-- preventive half; the audit is the detective half.
--
-- Scope note: this applies to objects created by THIS role (the migration role)
-- in any schema. It does not retroactively change existing functions —
-- 20260725140000 handled the two that existed.

-- The ineffective statement left no pg_default_acl row at all (verified), so
-- there is nothing to clean up — only the correct one to add.

BEGIN;

ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
