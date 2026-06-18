-- SC6b: grant the retention-gc worker SELECT + DELETE on emergency_access_grants.
-- The worker GCs only DEAD grants (terminal or expired-unaccepted, via the
-- EMERGENCY_GRANT_DEAD guard). The cascade to emergency_access_key_pairs needs
-- no child grant (RI runs internally).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "emergency_access_grants" TO passwd_retention_gc_worker;
  END IF;
END
$$;
