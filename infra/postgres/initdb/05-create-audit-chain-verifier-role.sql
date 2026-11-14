-- Create dedicated audit-chain verify worker role.
-- Password is read from PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD env var.
--
-- This role is also created, with its column-level grants, by the prisma
-- migration 20261111000000_audit_chain_verifier_role. Both paths use
-- IF NOT EXISTS guards.
--
-- Separate file for the reason 04 gives: GRANTs on application tables do not
-- exist at initdb time, so they live in the migration.

-- Before any statement that carries a password, so the cleartext reaches no
-- record of statement text: the server log (logged, refused, timed, sampled or
-- as a parse tree), pg_stat_statements, and psql's own `LINE n:` error excerpt on
-- the entrypoint's stderr. The list is scripts/lib/statement-text-settings.mjs
-- (a test pins these lines to it). initdb runs as the bootstrap superuser, which
-- may set all of them for its session.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET debug_print_parse = off;
SET debug_print_rewritten = off;
SET debug_print_plan = off;
SET pg_stat_statements.track_utility = off;
\set VERBOSITY terse

\getenv passwd_audit_chain_verifier_password PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD

SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_audit_chain_verifier')
  THEN 'true' ELSE 'false' END AS should_create_audit_chain_verifier \gset

-- docker-compose.yml forwards the variable as ${...:-}, so an unset one arrives as
-- an empty string, which \getenv still defines: test for a non-empty value. Tested
-- by the shell (psql backticks), so the value is never sent to the server.
\set has_passwd_audit_chain_verifier_password `[ -n "$PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD" ] && echo true || echo false`

\if :should_create_audit_chain_verifier
  \if :has_passwd_audit_chain_verifier_password
    CREATE ROLE passwd_audit_chain_verifier WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'passwd_audit_chain_verifier_password';
  \else
    -- No published fallback password: a LOGIN role with a password in this
    -- repository would be one any process on the network could use.
    \warn 'PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD is not set — creating passwd_audit_chain_verifier NOLOGIN. Set it and rerun initdb, or see docs/operations/deployment.md.'
    CREATE ROLE passwd_audit_chain_verifier WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  \endif
\endif

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the verifier role (defense-in-depth).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_audit_chain_verifier;
