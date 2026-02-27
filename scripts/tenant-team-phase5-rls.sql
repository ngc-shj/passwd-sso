-- Phase 5 (optional): PostgreSQL RLS for tenant isolation
--
-- Precondition:
--   SET app.tenant_id = '<tenant-id>' on each request/transaction,
--   or SET app.bypass_rls = 'on' for trusted service jobs.

-- Helper expression used in each policy:
--   COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
--   OR tenant_id = current_setting('app.tenant_id', true)

-- teams
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_tenant_isolation ON "teams";
CREATE POLICY teams_tenant_isolation ON "teams"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- tenant_members
ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_tenant_isolation ON "tenant_members";
CREATE POLICY tenant_members_tenant_isolation ON "tenant_members"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- scim_tokens
ALTER TABLE "scim_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_tokens_tenant_isolation ON "scim_tokens";
CREATE POLICY scim_tokens_tenant_isolation ON "scim_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- scim_external_mappings
ALTER TABLE "scim_external_mappings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_external_mappings_tenant_isolation ON "scim_external_mappings";
CREATE POLICY scim_external_mappings_tenant_isolation ON "scim_external_mappings"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- Enable this only after staging verification:
-- ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "scim_tokens" FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "scim_external_mappings" FORCE ROW LEVEL SECURITY;
