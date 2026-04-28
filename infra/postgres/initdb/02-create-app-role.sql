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

-- Minimum table privileges: claim + deliver + delete SENT/FAILED rows from outbox,
-- insert delivered rows into audit_logs, read tenant for FK validation.
GRANT SELECT, UPDATE, DELETE ON audit_outbox TO passwd_outbox_worker;
-- SELECT needed for ON CONFLICT (outbox_id) DO NOTHING dedup check
GRANT SELECT, INSERT ON audit_logs TO passwd_outbox_worker;
-- FK-referenced tables: SELECT needed for referential integrity checks under RLS
GRANT SELECT ON tenants TO passwd_outbox_worker;
GRANT SELECT ON users TO passwd_outbox_worker;
GRANT SELECT ON teams TO passwd_outbox_worker;
GRANT SELECT ON service_accounts TO passwd_outbox_worker;
-- Phase 3: delivery targets
GRANT SELECT, UPDATE ON TABLE "audit_delivery_targets" TO passwd_outbox_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_deliveries" TO passwd_outbox_worker;

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the worker role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_outbox_worker;

-- Create dedicated DCR cleanup worker role
-- Password is read from PASSWD_DCR_CLEANUP_WORKER_PASSWORD env var.
-- Mirrors the audit-outbox-worker role pattern above; grants are also applied
-- by the prisma migration that creates the role for existing clusters.

\getenv passwd_dcr_cleanup_worker_password PASSWD_DCR_CLEANUP_WORKER_PASSWORD

SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_dcr_cleanup_worker')
  THEN 'true' ELSE 'false' END AS should_create_dcr_worker \gset

\if :should_create_dcr_worker
  \if :{?passwd_dcr_cleanup_worker_password}
    CREATE ROLE passwd_dcr_cleanup_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_dcr_cleanup_worker_password';
  \else
    -- Fallback for local dev when PASSWD_DCR_CLEANUP_WORKER_PASSWORD is not set
    CREATE ROLE passwd_dcr_cleanup_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'passwd_dcr_pass';
  \endif
\endif

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the dcr-cleanup-worker role (mirrors
-- the outbox-worker REVOKE block above).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_dcr_cleanup_worker;
