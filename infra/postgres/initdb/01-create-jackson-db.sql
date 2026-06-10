-- Create dedicated non-superuser DB role for BoxyHQ SAML Jackson.
-- Password is read from PASSWD_JACKSON_PASSWORD env var (set in docker-compose.yml).
-- \getenv sets a psql client-side variable (NOT a GUC), expanded by :'varname'.

\getenv jackson_password PASSWD_JACKSON_PASSWORD

-- Guard: only create if role doesn't already exist
SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jackson_user')
  THEN 'true' ELSE 'false' END AS should_create_jackson \gset

\if :should_create_jackson
  \if :{?jackson_password}
    CREATE ROLE jackson_user WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'jackson_password';
  \else
    \warn 'PASSWD_JACKSON_PASSWORD is not set — skipping jackson_user LOGIN role creation. Set the env var and rerun initdb (or create the role manually).'
    CREATE ROLE jackson_user WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  \endif
\endif

-- jackson_user owns the jackson database; it cannot access passwd_sso tables.
CREATE DATABASE jackson OWNER jackson_user;
