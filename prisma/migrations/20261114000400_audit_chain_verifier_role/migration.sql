-- #947. The audit-chain verify worker ran as passwd_app, which can write every
-- table. It gets a role of its own that reads exactly the columns the worker's
-- statements name (src/lib/audit/audit-chain-verify.ts, scripts/audit-chain-verify-worker.ts):
--
--   tenants:             id
--   audit_chain_anchors: tenant_id, chain_seq, prev_hash
--   audit_logs:          id, tenant_id, created_at, chain_seq, event_hash,
--                        chain_prev_hash, metadata   (metadata is part of the hashed payload)
--
-- plus EXECUTE on the two RLS bypass functions its policies call. No write, no
-- sequence, no other column. A future verifier query that names another column
-- fails with 42501 until a migration grants it.
--
-- The role is created NOLOGIN with no password, as the other worker roles are:
-- infra/postgres/initdb/05 (compose) or scripts/bootstrap-rds-roles.mjs (RDS)
-- gives it LOGIN and a password.
--
-- The block between the markers runs whether or not the role existed, so a role
-- that pre-dates this migration (created by initdb or the bootstrap) is brought
-- to the same state. It cannot see a grant made by another grantor, an object
-- the role owns, a role setting or another schema; scripts/audit-db-grants.mjs
-- compares those against the committed manifest on every deploy.
--
-- Wrapped in BEGIN/COMMIT: the statements below are more than one DDL
-- (check-migration-transaction.mjs).
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_audit_chain_verifier') THEN
    CREATE ROLE passwd_audit_chain_verifier WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

-- BEGIN CONVERGE audit-chain-verifier-role
-- CONNECTION LIMIT: the worker's pool holds at most 2 connections and a rolling
-- deploy overlaps two tasks per desired task, so 10 covers two desired tasks.
-- The server enforces it; a role-level timeout would be a session default the
-- holder of the credential can override.
ALTER ROLE passwd_audit_chain_verifier CONNECTION LIMIT 10;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM passwd_audit_chain_verifier;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM passwd_audit_chain_verifier;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM passwd_audit_chain_verifier;
REVOKE ALL ON SCHEMA public FROM passwd_audit_chain_verifier;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_audit_chain_verifier;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_audit_chain_verifier;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM passwd_audit_chain_verifier;

DO $$ BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM passwd_audit_chain_verifier', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_audit_chain_verifier', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO passwd_audit_chain_verifier;

GRANT SELECT ("id") ON "tenants" TO passwd_audit_chain_verifier;
GRANT SELECT ("tenant_id", "chain_seq", "prev_hash") ON "audit_chain_anchors" TO passwd_audit_chain_verifier;
GRANT SELECT ("id", "tenant_id", "created_at", "chain_seq", "event_hash", "chain_prev_hash", "metadata")
  ON "audit_logs" TO passwd_audit_chain_verifier;

GRANT EXECUTE ON FUNCTION public.rls_bypass_enforced() TO passwd_audit_chain_verifier;
GRANT EXECUTE ON FUNCTION public.rls_bypass_admits(text) TO passwd_audit_chain_verifier;

-- Raise rather than repair: a role holding an elevated attribute or a
-- membership was changed by something this migration does not own.
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'passwd_audit_chain_verifier';
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication THEN
    RAISE EXCEPTION 'passwd_audit_chain_verifier holds an elevated attribute (super=%, bypassrls=%, createdb=%, createrole=%, replication=%)',
      r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION 'passwd_audit_chain_verifier is a member of another role';
  END IF;
END $$;
-- END CONVERGE audit-chain-verifier-role

COMMIT;
