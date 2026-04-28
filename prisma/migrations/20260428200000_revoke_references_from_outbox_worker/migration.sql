-- Defense-in-depth: prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from
-- implicitly granting REFERENCES on future tables to the outbox-worker
-- role. This was previously only in initdb, which historically aborted
-- before reaching this statement (see deviation log for the dcr-cleanup
-- PR). The dcr-cleanup-worker received this fix via migration
-- 20260428190000_revoke_references_from_dcr_cleanup_worker; mirroring
-- here for parity.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_outbox_worker;
