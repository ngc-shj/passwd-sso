-- SC7: grant the retention-gc worker SELECT + DELETE on the append-only log
-- tables it trims. Leaf tables (no inbound FK) — plain batch DELETE by age.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "share_access_logs" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "directory_sync_logs" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "notifications" TO passwd_retention_gc_worker;
  END IF;
END
$$;
