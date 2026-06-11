-- Revoke the PUBLIC default CONNECT privilege on the application database.
-- All legitimate app/worker roles already have explicit GRANT CONNECT (see
-- 02-create-app-role.sql and migration 20260428170853). This tightens
-- connection-level isolation so roles without an explicit grant (e.g.
-- jackson_user) cannot even connect to passwd_sso.
--
-- Pattern mirrors the existing GRANT CONNECT migrations: DO/$$/format()/current_database().
-- Runs as passwd_user (superuser/owner) via `migrate deploy`.
DO $$ BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
END $$;
