-- C7: grant the retention-gc worker UPDATE on access_requests.status only, so
-- it can flip PENDING -> EXPIRED (a status transition, not a delete) while
-- remaining unable to rewrite tenant_id / requested_scope / expires_at /
-- approver fields. Column-scoped GRANT keeps the NOBYPASSRLS role's write
-- surface as narrow as the read/delete grant it already holds
-- (20260619001000_retention_gc_security_record_grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT UPDATE (status) ON TABLE "access_requests" TO passwd_retention_gc_worker;
  END IF;
END
$$;
