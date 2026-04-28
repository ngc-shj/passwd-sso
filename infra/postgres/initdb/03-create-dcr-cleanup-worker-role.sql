-- Create dedicated DCR cleanup worker role.
-- Password is read from PASSWD_DCR_CLEANUP_WORKER_PASSWORD env var.
--
-- This role is also created by the prisma migration
-- 20260428170853_add_dcr_cleanup_worker_role_and_system_tenant for clusters
-- that pre-date the role. Both paths use IF NOT EXISTS guards.
--
-- Note: this is a separate file (not appended to 02-create-app-role.sql)
-- because 02 issues GRANTs on application tables (e.g. audit_outbox) that
-- do not exist at initdb time — those GRANTs fail with "relation does not
-- exist", which causes psql to abort the rest of 02 with ON_ERROR_STOP=1.
-- Splitting keeps this role's creation independent of that pre-existing
-- bootstrap-time error.

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
-- REFERENCES on future tables to the dcr-cleanup-worker role (defense-in-depth).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_dcr_cleanup_worker;
