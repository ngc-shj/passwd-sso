BEGIN;

-- #922. The two SECURITY DEFINER audit functions run with their owner's
-- privileges and did not look at the caller's context, so a caller outside
-- the RLS bypass, or one whose bypass grant does not name audit_logs, could
-- still purge or re-tenant audit rows. Each now asks rls_bypass_admits
-- ('audit_logs') first, which reads the CALLER's session GUCs:
--   - bypass off                      -> refused now (42501);
--   - bypass on, audit_logs granted   -> runs, as before;
--   - bypass on, audit_logs ungranted -> reported now (report mode) and
--                                        refused once rls_bypass_enforced()
--                                        is flipped (#921).
-- Every production caller (retention GC, the maintenance purge route, the
-- sign-in tenant migration) runs under a bypass whose grant names audit_logs.
-- CREATE OR REPLACE keeps the owner and the EXECUTE ACL (PUBLIC revoked by
-- 20260725140000).

CREATE OR REPLACE FUNCTION public.audit_log_purge(p_tenant_id uuid, p_cutoff timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT (SELECT public.rls_bypass_admits('audit_logs')) THEN
    RAISE EXCEPTION 'AUDIT_DEFINER_REQUIRES_BYPASS: audit_log_purge must run under an RLS bypass that grants audit_logs'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM audit_logs
   WHERE tenant_id = p_tenant_id
     AND created_at < p_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE PROCEDURE public.audit_log_tenant_migrate(IN p_user_id uuid, IN p_from_tenant uuid, IN p_to_tenant uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
BEGIN
  IF NOT (SELECT public.rls_bypass_admits('audit_logs')) THEN
    RAISE EXCEPTION 'AUDIT_DEFINER_REQUIRES_BYPASS: audit_log_tenant_migrate must run under an RLS bypass that grants audit_logs'
      USING ERRCODE = '42501';
  END IF;
  UPDATE audit_logs SET tenant_id = p_to_tenant
  WHERE user_id = p_user_id AND tenant_id = p_from_tenant;
END;
$procedure$;

COMMIT;
