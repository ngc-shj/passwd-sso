-- SC4: grant the retention-gc worker SELECT + DELETE on the forensic-credential
-- tables it purges. The worker captures each row's provenance into the audit
-- outbox (already granted INSERT on audit_outbox) before deleting. These are
-- leaf credential tables — no inbound CASCADE to orphan.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "api_keys" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "service_account_tokens" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "operator_tokens" TO passwd_retention_gc_worker;
    GRANT SELECT, DELETE ON TABLE "extension_tokens" TO passwd_retention_gc_worker;
  END IF;
END
$$;
