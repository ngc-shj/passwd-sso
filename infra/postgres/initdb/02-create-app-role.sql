-- Create non-superuser application role
-- This role is used by the Next.js app at runtime.
-- RLS policies are enforced for this role (no SUPERUSER or BYPASSRLS).
--
-- Password is read from PASSWD_APP_PASSWORD env var (set in docker-compose.yml).
-- \getenv sets a psql client-side variable (NOT a GUC), expanded by :'varname'.

\getenv passwd_app_password PASSWD_APP_PASSWORD

-- Guard: only create if role doesn't already exist
SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app')
  THEN 'true' ELSE 'false' END AS should_create \gset

\if :should_create
  \if :{?passwd_app_password}
    CREATE ROLE passwd_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_app_password';
  \else
    -- Fallback for local dev when PASSWD_APP_PASSWORD is not set
    CREATE ROLE passwd_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'passwd_app_pass';
  \endif
\endif

-- Revoke default PUBLIC privileges on public schema (defense-in-depth)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Grant access to the application database (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_app', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO passwd_app;

-- Grant DML on all existing and future tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;

-- Grant sequence usage (for auto-increment / serial columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;

-- Create dedicated audit outbox worker role
-- Password is read from PASSWD_OUTBOX_WORKER_PASSWORD env var.
-- \getenv sets a psql client-side variable (NOT a GUC), expanded by :'varname'.

\getenv passwd_outbox_worker_password PASSWD_OUTBOX_WORKER_PASSWORD

-- Guard: only create if role doesn't already exist
SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_outbox_worker')
  THEN 'true' ELSE 'false' END AS should_create_worker \gset

\if :should_create_worker
  \if :{?passwd_outbox_worker_password}
    CREATE ROLE passwd_outbox_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_outbox_worker_password';
  \else
    -- Fallback for local dev when PASSWD_OUTBOX_WORKER_PASSWORD is not set
    CREATE ROLE passwd_outbox_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'passwd_outbox_pass';
  \endif
\endif

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_outbox_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_outbox_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_outbox_worker;

-- Grant database and schema access (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_outbox_worker', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO passwd_outbox_worker;

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the worker role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_outbox_worker;

-- Note: table-specific GRANTs (audit_outbox, audit_logs, tenants, users,
-- teams, service_accounts, audit_delivery_targets, audit_deliveries,
-- audit_chain_anchors) are issued by the prisma migrations that create
-- those tables — NOT here. Issuing them in initdb crashes psql with
-- "relation does not exist" because migrations have not run yet at
-- initdb time, and ON_ERROR_STOP=1 then aborts the rest of this script.
-- See migrations/20260412100001_add_audit_outbox_worker_role,
--     migrations/20260413100000_add_audit_delivery_targets,
--     migrations/20260413110000_add_audit_chain.

