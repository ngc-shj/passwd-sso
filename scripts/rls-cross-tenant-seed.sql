-- RLS Cross-Tenant Verify: Seed data
--
-- Seeds two tenants A (00000000-0000-0000-0000-0000000000A0) and
-- B (00000000-0000-0000-0000-0000000000B0) with exactly one row per
-- tenant in each of the 53 tenant-scoped tables. mcp_clients also
-- gets a third row with tenant_id = NULL (DCR pre-claimed clients).
--
-- Runs as passwd_user (SUPERUSER, BYPASSRLS). Sets app.bypass_rls = 'on'
-- to also bypass the BEFORE INSERT triggers (enforce_tenant_id_from_context)
-- that otherwise would reject inserts when app.tenant_id is unset.
--
-- Local usage:
--   cat scripts/rls-cross-tenant-seed.sql | docker exec -i passwd-sso-db-1 \
--     psql -U passwd_user -d passwd_sso -v ON_ERROR_STOP=1
--
-- Maintenance contract — adding a new tenant-scoped table requires:
--   1. Migration: add tenant_id column + ENABLE/FORCE RLS + tenant_isolation policy.
--   2. This file: insert one row per tenant (A and B), in dependency order
--      (parent FKs first). For nullable-tenant tables, also insert a NULL row.
--   3. scripts/rls-cross-tenant-tables.manifest: append the table name.
-- The coverage step (rls-cross-tenant-coverage.sql) will fail loudly with
-- "expected=1 got=0 — fix rls-cross-tenant-seed.sql" if step 2 is forgotten.
--
-- Identifier convention:
--   - Tenant A id: 00000000-0000-0000-0000-0000000000A0
--   - Tenant B id: 00000000-0000-0000-0000-0000000000B0
--   - User A id:   00000000-0000-0000-0000-0000000000A1
--   - User B id:   00000000-0000-0000-0000-0000000000B1
--   - Other deterministic-needed parents use ...A2/B2, ...A3/B3, etc.
--   - All non-FK-referenced child rows use gen_random_uuid().
--
-- This seed must NOT collide with rls-smoke-seed.sql which uses
--   tenant 00000000-0000-0000-0000-000000000001 + 00000000-...0010 / ...0011.
--
-- Use %I (identifier quoting) — never %s — when extending dynamic SQL here.
-- Identifiers come from system catalog data (trusted). Never widen this rule
-- by interpolating user input.

-- Re-grant DML to passwd_app (the verify step runs as passwd_app).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;

-- Bypass enforce_tenant_id_from_context triggers AND RLS for the entire seed.
-- passwd_user is SUPERUSER so RLS is bypassed already, but the BEFORE INSERT
-- triggers still fire and would raise 'tenant_id missing and app.tenant_id is
-- not set' for tables that have the trigger. The trigger checks app.bypass_rls
-- explicitly and short-circuits.
SET app.bypass_rls = 'on';

-- ---------------------------------------------------------------------------
-- Parents: tenants → users (NOTE: inserting a user with tenant_id matching
--   md5(user.id) auto-creates a tenant_members row via
--   ensure_tenant_owner_membership_after_user_insert. Our deterministic UUIDs
--   do NOT match md5(...), so the trigger no-ops — we insert tenant_members
--   explicitly below.)
-- ---------------------------------------------------------------------------
INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A0', 'rls-x-tenant-a', 'rls-x-tenant-a', NOW(), NOW()),
  ('00000000-0000-0000-0000-0000000000B0', 'rls-x-tenant-b', 'rls-x-tenant-b', NOW(), NOW());

INSERT INTO users (id, tenant_id, email, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', 'rls-x-a@test.local', NOW(), NOW()),
  ('00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', 'rls-x-b@test.local', NOW(), NOW());

-- ---------------------------------------------------------------------------
-- Level 1: depends only on tenant + user
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, user_id, tenant_id, type, provider, provider_account_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', 'oauth', 'rls-x-a', 'rls-x-a-acct'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', 'oauth', 'rls-x-b', 'rls-x-b-acct');

INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-api')::text, 'apxa', 'rls-x-a-api', 'passwords:read', NOW() + interval '1 hour', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-api')::text, 'apxb', 'rls-x-b-api', 'passwords:read', NOW() + interval '1 hour', NOW());

INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A0', 0, '\x00'::bytea, NOW()),
  ('00000000-0000-0000-0000-0000000000B0', 0, '\x00'::bytea, NOW());

-- audit_outbox: cleanup trigger requires status IN ('SENT','FAILED') for DELETE.
-- We pre-set status='SENT' so the cleanup section can DELETE without firing the guard.
INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at) VALUES
  ('00000000-0000-0000-0000-0000000000AA', '00000000-0000-0000-0000-0000000000A0', '{"rls":"x-a"}'::jsonb, 'SENT', NOW()),
  ('00000000-0000-0000-0000-0000000000BA', '00000000-0000-0000-0000-0000000000B0', '{"rls":"x-b"}'::jsonb, 'SENT', NOW());

INSERT INTO audit_delivery_targets (id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag, master_key_version) VALUES
  ('00000000-0000-0000-0000-0000000000A9', '00000000-0000-0000-0000-0000000000A0', 'WEBHOOK', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1),
  ('00000000-0000-0000-0000-0000000000B9', '00000000-0000-0000-0000-0000000000B0', 'WEBHOOK', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1);

INSERT INTO directory_sync_configs (id, tenant_id, provider, display_name, encrypted_credentials, credentials_iv, credentials_auth_tag, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000AD', '00000000-0000-0000-0000-0000000000A0', 'GOOGLE_WORKSPACE', 'rls-x-a-ds', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW()),
  ('00000000-0000-0000-0000-0000000000BD', '00000000-0000-0000-0000-0000000000B0', 'GOOGLE_WORKSPACE', 'rls-x-b-ds', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW());

INSERT INTO emergency_access_grants (id, tenant_id, owner_id, grantee_email, wait_days, token_hash, token_expires_at, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000AC', '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'grantee-a@test.local', 1, md5('rls-x-a-ea')::text, NOW() + interval '1 day', NOW()),
  ('00000000-0000-0000-0000-0000000000BC', '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'grantee-b@test.local', 1, md5('rls-x-b-ea')::text, NOW() + interval '1 day', NOW());

INSERT INTO extension_bridge_codes (id, tenant_id, user_id, code_hash, scope, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-eb')::text, 'passwords:read', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-eb')::text, 'passwords:read', NOW() + interval '1 hour');

INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-et')::text, 'passwords:read', NOW() + interval '1 hour', gen_random_uuid()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-et')::text, 'passwords:read', NOW() + interval '1 hour', gen_random_uuid());

INSERT INTO folders (id, tenant_id, user_id, name, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A8', '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'rls-x-a-folder', NOW()),
  ('00000000-0000-0000-0000-0000000000B8', '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'rls-x-b-folder', NOW());

INSERT INTO mobile_bridge_codes (id, tenant_id, user_id, code_hash, state, code_challenge, device_pubkey, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-mb')::text, 'state-a', md5('rls-x-a-mbc')::text, 'pubkey-a', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-mb')::text, 'state-b', md5('rls-x-b-mbc')::text, 'pubkey-b', NOW() + interval '1 hour');

INSERT INTO notifications (id, tenant_id, user_id, type, title, body) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'SECURITY_ALERT', 'rls-x-a', 'rls-x-a body'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'SECURITY_ALERT', 'rls-x-b', 'rls-x-b body');

INSERT INTO operator_tokens (id, tenant_id, subject_user_id, created_by_user_id, token_hash, prefix, name, scope, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-op')::text, 'opxa', 'rls-x-a-op', 'admin', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-op')::text, 'opxb', 'rls-x-b-op', 'admin', NOW() + interval '1 hour');

INSERT INTO personal_log_access_grants (id, tenant_id, requester_id, target_user_id, reason, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A1', 'rls-x-a reason', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B1', 'rls-x-b reason', NOW() + interval '1 hour');

INSERT INTO scim_external_mappings (id, tenant_id, external_id, resource_type, internal_id, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', 'ext-a', 'User', 'int-a', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', 'ext-b', 'User', 'int-b', NOW());

INSERT INTO scim_tokens (id, tenant_id, token_hash, created_by_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-scim')::text, '00000000-0000-0000-0000-0000000000A1'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-scim')::text, '00000000-0000-0000-0000-0000000000B1');

INSERT INTO sessions (id, user_id, tenant_id, session_token, expires) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-sess')::text, NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-sess')::text, NOW() + interval '1 hour');

INSERT INTO tags (id, tenant_id, user_id, name, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'rls-x-a-tag', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'rls-x-b-tag', NOW());

INSERT INTO tenant_members (id, tenant_id, user_id, role, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'OWNER', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'OWNER', NOW());

INSERT INTO tenant_webhooks (id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', 'https://rls-x-a.test/hook', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', 'https://rls-x-b.test/hook', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW());

INSERT INTO vault_keys (id, tenant_id, user_id, version, verification_ciphertext, verification_iv, verification_auth_tag) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 1, 'ct-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 1, 'ct-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff');

INSERT INTO webauthn_credentials (id, user_id, tenant_id, credential_id, public_key, device_type) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A0', 'cred-rls-x-a', 'pk-a', 'singleDevice'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B0', 'cred-rls-x-b', 'pk-b', 'singleDevice');

-- ---------------------------------------------------------------------------
-- Level 2: teams + service_accounts (depend on user)
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, tenant_id, name, slug, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A2', '00000000-0000-0000-0000-0000000000A0', 'rls-x-a-team', 'rls-x-a-team', NOW()),
  ('00000000-0000-0000-0000-0000000000B2', '00000000-0000-0000-0000-0000000000B0', 'rls-x-b-team', 'rls-x-b-team', NOW());

INSERT INTO service_accounts (id, tenant_id, name, identity_type, is_active, created_by_id, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A3', '00000000-0000-0000-0000-0000000000A0', 'rls-x-a-sa', 'SERVICE_ACCOUNT', true, '00000000-0000-0000-0000-0000000000A1', NOW()),
  ('00000000-0000-0000-0000-0000000000B3', '00000000-0000-0000-0000-0000000000B0', 'rls-x-b-sa', 'SERVICE_ACCOUNT', true, '00000000-0000-0000-0000-0000000000B1', NOW());

-- ---------------------------------------------------------------------------
-- Level 3: depend on team or service_account
-- ---------------------------------------------------------------------------
INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, token_hash, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-avr')::text, NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-avr')::text, NOW() + interval '1 hour');

INSERT INTO access_requests (id, tenant_id, service_account_id, requested_scope, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A3', 'passwords:read', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B3', 'passwords:read', NOW() + interval '1 hour');

INSERT INTO directory_sync_logs (id, tenant_id, config_id, status, started_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000AD', 'SUCCESS', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000BD', 'SUCCESS', NOW());

INSERT INTO emergency_access_key_pairs (id, grant_id, encrypted_private_key, private_key_iv, private_key_auth_tag, tenant_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000AC', 'epk-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', '00000000-0000-0000-0000-0000000000A0'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000BC', 'epk-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', '00000000-0000-0000-0000-0000000000B0');

INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', 'ext-grp-a', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', 'ext-grp-b', NOW());

INSERT INTO service_account_tokens (id, service_account_id, tenant_id, token_hash, prefix, name, scope, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A3', '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-sat')::text, 'satxa', 'rls-x-a-sat', 'passwords:read', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B3', '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-sat')::text, 'satxb', 'rls-x-b-sat', 'passwords:read', NOW() + interval '1 hour');

INSERT INTO team_folders (id, tenant_id, team_id, name, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', 'rls-x-a-tf', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', 'rls-x-b-tf', NOW());

INSERT INTO team_invitations (id, tenant_id, team_id, email, token, expires_at, invited_by_id, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', 'invitee-a@test.local', md5('rls-x-a-inv')::text, NOW() + interval '1 day', '00000000-0000-0000-0000-0000000000A1', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', 'invitee-b@test.local', md5('rls-x-b-inv')::text, NOW() + interval '1 day', '00000000-0000-0000-0000-0000000000B1', NOW());

INSERT INTO team_member_keys (id, tenant_id, team_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag, ephemeral_public_key, hkdf_salt, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', '00000000-0000-0000-0000-0000000000A1', 'etk-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'eph-a', 'aabbccddeeff00112233aabbccddeeff00112233aabbccddeeff00112233aabb', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', '00000000-0000-0000-0000-0000000000B1', 'etk-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'eph-b', 'aabbccddeeff00112233aabbccddeeff00112233aabbccddeeff00112233aabb', NOW());

INSERT INTO team_members (id, tenant_id, team_id, user_id, role, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', '00000000-0000-0000-0000-0000000000A1', 'OWNER', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', '00000000-0000-0000-0000-0000000000B1', 'OWNER', NOW());

INSERT INTO team_policies (id, tenant_id, team_id, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', NOW());

INSERT INTO team_tags (id, tenant_id, team_id, name, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', 'rls-x-a-tt', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', 'rls-x-b-tt', NOW());

INSERT INTO team_webhooks (id, tenant_id, team_id, url, secret_encrypted, secret_iv, secret_auth_tag, updated_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', 'https://rls-x-a-team.test/hook', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', 'https://rls-x-b-team.test/hook', 'enc', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW());

-- ---------------------------------------------------------------------------
-- Level 4: password_entries (depend on user, optional folder)
-- ---------------------------------------------------------------------------
INSERT INTO password_entries (id, tenant_id, user_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, key_version, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A6', '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', 'eb-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'ov-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1, NOW()),
  ('00000000-0000-0000-0000-0000000000B6', '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', 'eb-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'ov-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1, NOW());

INSERT INTO team_password_entries (id, tenant_id, team_id, created_by_id, updated_by_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000A7', '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A2', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A1', 'tb-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'tov-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW()),
  ('00000000-0000-0000-0000-0000000000B7', '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B2', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B1', 'tb-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 'tov-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW());

-- ---------------------------------------------------------------------------
-- Level 5: depend on password_entries / team_password_entries
-- ---------------------------------------------------------------------------
INSERT INTO attachments (id, tenant_id, password_entry_id, created_by_id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A6', '00000000-0000-0000-0000-0000000000A1', 'rls-x-a.txt', 'text/plain', 1, '\x00'::bytea, 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B6', '00000000-0000-0000-0000-0000000000B1', 'rls-x-b.txt', 'text/plain', 1, '\x00'::bytea, 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff');

INSERT INTO password_entry_histories (id, tenant_id, entry_id, encrypted_blob, blob_iv, blob_auth_tag, key_version) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A6', 'h-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B6', 'h-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', 1);

INSERT INTO team_password_entry_histories (id, tenant_id, entry_id, encrypted_blob, blob_iv, blob_auth_tag, changed_by_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A7', 'th-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', '00000000-0000-0000-0000-0000000000A1'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B7', 'th-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', '00000000-0000-0000-0000-0000000000B1');

INSERT INTO team_password_favorites (id, tenant_id, user_id, team_password_entry_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A7'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B7');

INSERT INTO password_shares (id, tenant_id, token_hash, encrypted_data, data_iv, data_auth_tag, expires_at, created_by_id, password_entry_id) VALUES
  ('00000000-0000-0000-0000-0000000000AB', '00000000-0000-0000-0000-0000000000A0', md5('rls-x-a-share')::text, 'sh-a', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW() + interval '1 day', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A6'),
  ('00000000-0000-0000-0000-0000000000BB', '00000000-0000-0000-0000-0000000000B0', md5('rls-x-b-share')::text, 'sh-b', 'aabbccddeeff00112233aabb', 'aabbccddeeff00112233aabbccddeeff', NOW() + interval '1 day', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B6');

INSERT INTO share_access_logs (id, tenant_id, share_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000AB'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000BB');

-- ---------------------------------------------------------------------------
-- audit_logs: depends on outbox (CHECK constraint requires non-null outbox_id
-- unless actor_type='SYSTEM'). Simplest: use SYSTEM actor.
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', 'PERSONAL', 'AUTH_LOGIN', '00000000-0000-0000-0000-0000000000A1', 'SYSTEM'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', 'PERSONAL', 'AUTH_LOGIN', '00000000-0000-0000-0000-0000000000B1', 'SYSTEM');

INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000AA', '00000000-0000-0000-0000-0000000000A9', '00000000-0000-0000-0000-0000000000A0'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000BA', '00000000-0000-0000-0000-0000000000B9', '00000000-0000-0000-0000-0000000000B0');

-- ---------------------------------------------------------------------------
-- MCP chain: clients (NULL row + A + B) → access_tokens → refresh_tokens,
--            authorization_codes, delegation_sessions
-- ---------------------------------------------------------------------------
-- Special case: mcp_clients allows tenant_id IS NULL (DCR pre-claimed clients).
-- Seed three rows: A's, B's, and one with NULL tenant.
INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, allowed_scopes, updated_at, is_dcr) VALUES
  ('00000000-0000-0000-0000-0000000000A4', '00000000-0000-0000-0000-0000000000A0', 'mcpc_rlsxa', md5('rls-x-a-mcp')::text, 'rls-x-a-mcp', 'credentials:list', NOW(), false),
  ('00000000-0000-0000-0000-0000000000B4', '00000000-0000-0000-0000-0000000000B0', 'mcpc_rlsxb', md5('rls-x-b-mcp')::text, 'rls-x-b-mcp', 'credentials:list', NOW(), false),
  ('00000000-0000-0000-0000-0000000000C4', NULL,                                   'mcpc_rlsxn', md5('rls-x-n-mcp')::text, 'rls-x-n-mcp-dcr-preclaimed', 'credentials:list', NOW(), true);

INSERT INTO mcp_access_tokens (id, tenant_id, client_id, user_id, token_hash, scope, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000000A5', '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A4', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-mcat')::text, 'credentials:list', NOW() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000B5', '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B4', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-mcat')::text, 'credentials:list', NOW() + interval '1 hour');

INSERT INTO mcp_authorization_codes (id, tenant_id, client_id, user_id, redirect_uri, scope, code_hash, code_challenge, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A4', '00000000-0000-0000-0000-0000000000A1', 'http://localhost/cb', 'credentials:list', md5('rls-x-a-mac')::text, md5('rls-x-a-mac-cc')::text, NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B4', '00000000-0000-0000-0000-0000000000B1', 'http://localhost/cb', 'credentials:list', md5('rls-x-b-mac')::text, md5('rls-x-b-mac-cc')::text, NOW() + interval '1 hour');

INSERT INTO mcp_refresh_tokens (id, tenant_id, family_id, access_token_id, client_id, user_id, token_hash, scope, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', gen_random_uuid(), '00000000-0000-0000-0000-0000000000A5', '00000000-0000-0000-0000-0000000000A4', '00000000-0000-0000-0000-0000000000A1', md5('rls-x-a-mrt')::text, 'credentials:list', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', gen_random_uuid(), '00000000-0000-0000-0000-0000000000B5', '00000000-0000-0000-0000-0000000000B4', '00000000-0000-0000-0000-0000000000B1', md5('rls-x-b-mrt')::text, 'credentials:list', NOW() + interval '1 hour');

INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, expires_at) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000A1', '00000000-0000-0000-0000-0000000000A5', NOW() + interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000B0', '00000000-0000-0000-0000-0000000000B1', '00000000-0000-0000-0000-0000000000B5', NOW() + interval '1 hour');

RESET app.bypass_rls;
