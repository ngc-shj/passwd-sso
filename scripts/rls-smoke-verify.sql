-- RLS Smoke Test: Verify enforcement
--
-- Runs as passwd_app (NOSUPERUSER, NOBYPASSRLS).
-- Asserts that seeded rows are invisible without app.tenant_id set.
--
-- IMPORTANT: Every table seeded in rls-smoke-seed.sql (except FK parents)
-- must have a corresponding ASSERT here.

-- 1. Verify role flags
DO $$ BEGIN
  ASSERT (SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user),
    'passwd_app must not be SUPERUSER';
  ASSERT (SELECT NOT rolbypassrls FROM pg_roles WHERE rolname = current_user),
    'passwd_app must not have BYPASSRLS';
END $$;

-- 2. Verify RLS blocks access to seeded rows without app.tenant_id
DO $$ BEGIN
  ASSERT (SELECT count(*) = 0 FROM teams),
    'RLS must block access to teams without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM service_accounts),
    'RLS must block access to service_accounts without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM tenant_webhooks),
    'RLS must block access to tenant_webhooks without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM mcp_clients),
    'RLS must block access to mcp_clients without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM mcp_access_tokens),
    'RLS must block access to mcp_access_tokens without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM mcp_refresh_tokens),
    'RLS must block access to mcp_refresh_tokens without app.tenant_id';
  ASSERT (SELECT count(*) = 0 FROM delegation_sessions),
    'RLS must block access to delegation_sessions without app.tenant_id';
END $$;
