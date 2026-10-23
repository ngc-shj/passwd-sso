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

-- Before any statement that carries a password, so the cleartext reaches no
-- record of statement text: the server log (logged or refused), pg_stat_statements,
-- and psql's own `LINE n:` error excerpt on the entrypoint's stderr. initdb runs as
-- the bootstrap superuser, which may set all of these for its session.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET pg_stat_statements.track_utility = off;
\set VERBOSITY terse

\getenv passwd_retention_gc_worker_password PASSWD_RETENTION_GC_WORKER_PASSWORD

SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker')
  THEN 'true' ELSE 'false' END AS should_create_retention_gc_worker \gset

\if :should_create_retention_gc_worker
  \if :{?passwd_retention_gc_worker_password}
    CREATE ROLE passwd_retention_gc_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_retention_gc_worker_password';
  \else
    -- No published fallback password (docker-compose.yml requires PASSWD_RETENTION_GC_WORKER_PASSWORD, so
    -- this branch is reached only by another launcher of this directory).
    \warn 'PASSWD_RETENTION_GC_WORKER_PASSWORD is not set — creating passwd_retention_gc_worker NOLOGIN. Set it and rerun initdb.'
    CREATE ROLE passwd_retention_gc_worker WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  \endif
\endif

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the retention-gc-worker role (defense-in-depth).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_retention_gc_worker;
