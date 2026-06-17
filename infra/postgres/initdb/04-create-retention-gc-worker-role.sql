-- Create dedicated retention-gc worker role.
-- Password is read from PASSWD_RETENTION_GC_WORKER_PASSWORD env var.
--
-- This role is also created by the prisma migration
-- 20260618000000_add_retention_gc_worker_role for clusters
-- that pre-date the role. Both paths use IF NOT EXISTS guards.
--
-- Note: this is a separate file (not appended to 02-create-app-role.sql)
-- because 02 issues GRANTs on application tables (e.g. audit_outbox) that
-- do not exist at initdb time — those GRANTs fail with "relation does not
-- exist", which causes psql to abort the rest of 02 with ON_ERROR_STOP=1.
-- Splitting keeps this role's creation independent of that pre-existing
-- bootstrap-time error.

\getenv passwd_retention_gc_worker_password PASSWD_RETENTION_GC_WORKER_PASSWORD

SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker')
  THEN 'true' ELSE 'false' END AS should_create_retention_gc_worker \gset

\if :should_create_retention_gc_worker
  \if :{?passwd_retention_gc_worker_password}
    CREATE ROLE passwd_retention_gc_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_retention_gc_worker_password';
  \else
    -- Fallback for local dev when PASSWD_RETENTION_GC_WORKER_PASSWORD is not set
    CREATE ROLE passwd_retention_gc_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'passwd_retention_gc_pass';
  \endif
\endif

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the retention-gc-worker role (defense-in-depth).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_retention_gc_worker;
