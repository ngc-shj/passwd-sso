-- Fix team_policies RLS policy: add bypass_rls check and WITH CHECK clause
-- The original policy only had a basic USING clause without bypass_rls or WITH CHECK.

DROP POLICY IF EXISTS "tenant_isolation" ON "team_policies";

CREATE POLICY "tenant_isolation" ON "team_policies"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
