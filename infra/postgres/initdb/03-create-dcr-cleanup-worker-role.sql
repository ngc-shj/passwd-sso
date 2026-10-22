-- Create the retired DCR cleanup worker role: NOLOGIN, no password, no grants.
--
-- The role has been unused since the retention GC worker absorbed DCR cleanup,
-- and migration 20261023010000_retire_dcr_cleanup_worker_role retires it on
-- every database (scripts/audit-db-grants.mjs RETIRED_ROLES asserts that).
-- It is still created here, in its retired state, because a dump taken before
-- that migration carries GRANTs naming it: restoring such a dump onto a fresh
-- cluster (docs/operations/dev-host-migration.md, `pg_restore --exit-on-error`)
-- needs the grantee to exist, and the post-restore `prisma migrate deploy` then
-- retires it. Migration 20260428170853 also creates the role (IF NOT EXISTS) on
-- clusters that pre-date it.
--
-- This is a separate file (not appended to 02-create-app-role.sql) for the
-- reason it always was: 02 aborts the rest of its script on relation-dependent
-- statements under ON_ERROR_STOP=1, and this role's creation must not depend on
-- that.

SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_dcr_cleanup_worker')
  THEN 'true' ELSE 'false' END AS should_create_dcr_worker \gset

\if :should_create_dcr_worker
  CREATE ROLE passwd_dcr_cleanup_worker WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
\endif
