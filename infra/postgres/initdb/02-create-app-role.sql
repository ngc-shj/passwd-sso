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

-- Grant access to the application database
GRANT CONNECT ON DATABASE passwd_sso TO passwd_app;
GRANT USAGE ON SCHEMA public TO passwd_app;

-- Grant DML on all existing and future tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;

-- Grant sequence usage (for auto-increment / serial columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;
