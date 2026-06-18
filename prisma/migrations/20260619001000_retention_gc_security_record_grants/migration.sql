-- SC6: grant the retention-gc worker SELECT + DELETE on the six security-record
-- tables it purges with provenance. password_shares has an ON DELETE CASCADE
-- child (share_access_logs) — the cascade runs internally and needs no child
-- grant (and SC7 already granted share_access_logs anyway). The other five are
-- clean leaves.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "access_requests" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "admin_vault_resets" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "master_key_rotations" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "personal_log_access_grants" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "password_shares" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "team_invitations" TO passwd_retention_gc_worker;
  END IF;
END
$$;
