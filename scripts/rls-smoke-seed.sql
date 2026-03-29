-- RLS Smoke Test: Seed data
--
-- Inserts one row into each RLS-protected table so that the verify step
-- can confirm passwd_app (NOSUPERUSER, NOBYPASSRLS) cannot see them.
-- Runs as passwd_user (SUPERUSER) which bypasses RLS.
--
-- IMPORTANT: When adding a table here, also add an ASSERT in rls-smoke-verify.sql.
--
-- Note: tenants and users are inserted as FK parents only — they are NOT asserted
-- in verify because the smoke test focuses on tenant-scoped child tables.
-- Not all 44+ RLS tables are covered; this seeds a representative subset.
-- Add tables as they are created or fixed.
--
-- FK order: tenants → users → teams, service_accounts, tenant_webhooks,
--           mcp_clients → mcp_access_tokens → mcp_refresh_tokens, delegation_sessions
--
-- Local usage:
--   psql -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f scripts/rls-smoke-seed.sql
--   psql -v ON_ERROR_STOP=1 "postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso" -f scripts/rls-smoke-verify.sql
-- Prerequisites: passwd_app role must exist (see .github/workflows/ci.yml "Create app role" step)

-- Re-grant DML on tables created by migration
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;

-- Seed test rows as SUPERUSER (bypasses RLS) to make assertions meaningful.
-- Without data, count(*) = 0 is vacuously true regardless of RLS.

-- Parent records
INSERT INTO tenants (id, name, slug, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000001', 'rls-smoke-tenant', 'rls-smoke-tenant', NOW(), NOW());

INSERT INTO users (id, tenant_id, email, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'rls-smoke@test.local', NOW(), NOW());

-- Core tables
INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'rls-smoke', 'rls-smoke', NOW(), NOW());

INSERT INTO service_accounts (id, tenant_id, name, identity_type, is_active, created_by_id, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'rls-smoke-sa', 'SERVICE_ACCOUNT', true, '00000000-0000-0000-0000-000000000002', NOW(), NOW());

INSERT INTO tenant_webhooks (id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag, events, is_active, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'https://rls-smoke.test/hook', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', '{"test"}', true, NOW(), NOW());

-- MCP chain: clients → access_tokens → refresh_tokens, delegation_sessions
INSERT INTO mcp_clients (id, tenant_id, name, client_id, client_secret_hash, redirect_uris, allowed_scopes, is_active, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'rls-smoke-mcp', 'mcpc_rlssmoke', 'hash', '{"http://localhost"}', 'credentials:list', true, NOW(), NOW());

INSERT INTO mcp_access_tokens (id, tenant_id, token_hash, client_id, user_id, scope, expires_at, created_at)
  VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'rlssmokehash', '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000002', 'credentials:list', NOW() + interval '1 hour', NOW());

INSERT INTO mcp_refresh_tokens (id, tenant_id, token_hash, family_id, client_id, access_token_id, scope, expires_at, created_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'rlssmokerefresh', gen_random_uuid(), '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000011', 'credentials:list', NOW() + interval '1 hour', NOW());

INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, created_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000011', '{}', NOW() + interval '1 hour', NOW());
