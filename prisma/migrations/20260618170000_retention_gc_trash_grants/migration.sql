-- SC2: grant the retention-gc worker the privileges needed to auto-purge
-- soft-deleted vault entries. It SELECTs + DELETEs the two entry tables; the
-- ON DELETE CASCADE then removes attachments, history, favorites, and tag
-- links internally (the RI trigger runs without re-checking invoking-role
-- privileges), so no DELETE grant on those child tables is needed. SELECT on
-- attachments is required only so collectEntryAttachmentRefs can read external
-- blob refs before the cascade destroys the rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "password_entries" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "team_password_entries" TO passwd_retention_gc_worker;
    GRANT SELECT ON TABLE "attachments" TO passwd_retention_gc_worker;
  END IF;
END
$$;
