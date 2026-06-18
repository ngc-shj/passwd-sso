-- SC5: family-aware GC for the MCP OAuth token rotation family.
-- The retention-gc worker deletes expired mcp_access_tokens rows (guarded by a
-- "no live dependents" check); the existing FK ON DELETE CASCADE then removes the
-- now-dead mcp_refresh_tokens and delegation_sessions children.
--
-- Privileges (least-privilege, R14):
--   mcp_access_tokens:   SELECT + DELETE — the worker reads candidates and deletes them.
--   mcp_refresh_tokens:  SELECT only — needed for the guard NOT EXISTS subquery.
--                        NOT DELETE: ON DELETE CASCADE is enforced by an internal RI
--                        trigger that does NOT re-check the invoking role's table
--                        privileges, so no child DELETE grant is required. RLS on the
--                        cascade-target children is satisfied because the worker sets
--                        app.bypass_rls='on' in the same transaction.
--   delegation_sessions: SELECT only — same rationale (guard subquery + cascade).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT SELECT, DELETE ON TABLE "mcp_access_tokens" TO passwd_retention_gc_worker;
    GRANT SELECT ON TABLE "mcp_refresh_tokens" TO passwd_retention_gc_worker;
    GRANT SELECT ON TABLE "delegation_sessions" TO passwd_retention_gc_worker;
  END IF;
END
$$;
