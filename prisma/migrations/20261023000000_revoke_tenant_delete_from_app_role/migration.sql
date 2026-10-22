-- #934 (SC5 of #923). No production code path deletes a tenant: the only
-- `DELETE FROM tenants` statements are test teardown and manual-test scripts,
-- all of which connect as the owner or a dedicated probe role. Holding DELETE
-- anyway let SQL running as passwd_app remove a tenant with no RESTRICT
-- dependents, cascading to its claims, memberships, operator tokens, webhooks,
-- delivery targets and directory-sync rows. The tenants RLS policy does not
-- bound that: its GUCs are settable by any role, and the privilege is the
-- control that does not depend on them.
--
-- TRUNCATE, REFERENCES and TRIGGER are not held today; they are revoked (and
-- declared) for completeness. TRUNCATE in particular ignores row level
-- security altogether.
--
-- scripts/checks/app-role-denied-privileges.json declares the same set, so
-- bootstrap-rds-roles.mjs re-applies it after its table-blind blanket GRANT
-- and audit-db-grants.mjs fails if any of it is held again.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "tenants" FROM passwd_app;
  END IF;
END
$$;
