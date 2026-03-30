-- Enable and force RLS on all Machine Identity tables

-- service_accounts
ALTER TABLE "service_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_accounts_tenant_isolation ON "service_accounts";
CREATE POLICY service_accounts_tenant_isolation ON "service_accounts"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- service_account_tokens
ALTER TABLE "service_account_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_account_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_account_tokens_tenant_isolation ON "service_account_tokens";
CREATE POLICY service_account_tokens_tenant_isolation ON "service_account_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- access_requests
ALTER TABLE "access_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_requests_tenant_isolation ON "access_requests";
CREATE POLICY access_requests_tenant_isolation ON "access_requests"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- mcp_clients
ALTER TABLE "mcp_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_clients" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_clients_tenant_isolation ON "mcp_clients";
CREATE POLICY mcp_clients_tenant_isolation ON "mcp_clients"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- mcp_authorization_codes (tenant_id column present)
ALTER TABLE "mcp_authorization_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_authorization_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_authorization_codes_tenant_isolation ON "mcp_authorization_codes";
CREATE POLICY mcp_authorization_codes_tenant_isolation ON "mcp_authorization_codes"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- mcp_access_tokens
ALTER TABLE "mcp_access_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_access_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_access_tokens_tenant_isolation ON "mcp_access_tokens";
CREATE POLICY mcp_access_tokens_tenant_isolation ON "mcp_access_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
