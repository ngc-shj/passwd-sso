-- Defense-in-depth: prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from
-- implicitly granting REFERENCES on future tables to the dcr-cleanup-worker
-- role (mirrors the outbox-worker REVOKE block in
-- infra/postgres/initdb/02-create-app-role.sql).
--
-- Issued as a separate migration from
-- 20260428170853_add_dcr_cleanup_worker_role_and_system_tenant so the prior
-- migration's checksum is preserved across environments where it is already
-- applied.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_dcr_cleanup_worker;
