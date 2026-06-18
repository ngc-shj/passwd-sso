-- SC3: grant the retention-gc worker SELECT + DELETE on the entry-history tables
-- it trims. Both are leaf tables (no inbound FK) — a plain batch DELETE; no
-- cascade or definer function needed (history is mutable, unlike audit_logs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "password_entry_histories" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "team_password_entry_histories" TO passwd_retention_gc_worker;
  END IF;
END
$$;
