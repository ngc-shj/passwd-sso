-- Fix RLS policies for batch_f tables.
-- These tables used the deprecated setting name 'app.current_tenant_id'
-- and lacked the bypass clause needed for cross-tenant operations
-- (e.g. WebAuthn sign-in credential lookup).

-- webauthn_credentials
DROP POLICY IF EXISTS "webauthn_credentials_tenant_isolation" ON "webauthn_credentials";
CREATE POLICY webauthn_credentials_tenant_isolation ON "webauthn_credentials"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- api_keys
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY api_keys_tenant_isolation ON "api_keys"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- directory_sync_configs
DROP POLICY IF EXISTS "directory_sync_configs_tenant_isolation" ON "directory_sync_configs";
CREATE POLICY directory_sync_configs_tenant_isolation ON "directory_sync_configs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- directory_sync_logs
DROP POLICY IF EXISTS "directory_sync_logs_tenant_isolation" ON "directory_sync_logs";
CREATE POLICY directory_sync_logs_tenant_isolation ON "directory_sync_logs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
