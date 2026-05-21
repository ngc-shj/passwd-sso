-- C13 / OWASP A04-2: REVOKE UPDATE/DELETE on audit_logs and audit_chain_anchors
-- from the application role (passwd_app). Privileged mutations (tenant merge
-- in auth.ts, retention purge in /api/maintenance/purge-audit-logs) are
-- exposed via SECURITY DEFINER procedures owned by the schema owner so the
-- app role retains EXECUTE rights but cannot perform arbitrary UPDATE/DELETE.
--
-- HMAC chain (C14 worker) verifies integrity; this REVOKE adds prevention.
-- audit_anchor_manifests table does not exist in current schema and is
-- intentionally omitted.

-- 1. Privileged procedures (owned by current migrate role).

CREATE OR REPLACE PROCEDURE audit_log_tenant_migrate(
  p_user_id UUID, p_from_tenant UUID, p_to_tenant UUID
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE audit_logs SET tenant_id = p_to_tenant
  WHERE user_id = p_user_id AND tenant_id = p_from_tenant;
$$;

CREATE OR REPLACE FUNCTION audit_log_purge(
  p_tenant_id UUID, p_cutoff TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM audit_logs
   WHERE tenant_id = p_tenant_id
     AND created_at < p_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 2. REVOKE generic UPDATE/DELETE from app role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE UPDATE, DELETE ON audit_logs FROM passwd_app;
    REVOKE UPDATE, DELETE ON audit_chain_anchors FROM passwd_app;
  END IF;
END
$$;

-- 3. GRANT EXECUTE on the definer functions to passwd_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT EXECUTE ON PROCEDURE audit_log_tenant_migrate(UUID, UUID, UUID) TO passwd_app;
    GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) TO passwd_app;
  END IF;
END
$$;
