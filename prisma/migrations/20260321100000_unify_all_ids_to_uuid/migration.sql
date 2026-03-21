-- =============================================================================
-- Migration: Convert all CUID v1 IDs to UUID v4
--
-- Strategy:
--   1. Disable FK trigger checks (session_replication_role = 'replica')
--   2. For each parent table with CUID data, build a temp mapping table
--      (old_cuid TEXT -> new_uuid UUID)
--   3. Update parent PKs and child FK columns via the mapping
--   4. Change column DEFAULTs to gen_random_uuid()
--   5. Re-enable FK checks
--
-- NOTE: Column type remains TEXT. Migration to native PostgreSQL uuid type
-- is deferred to a separate task (export → reset → import).
--
-- Tables skipped (already have UUID v4 PKs, DEFAULT already set or fixed
-- in migration 20260321090000):
--   password_entries, team_password_entries, teams, attachments,
--   password_entry_histories, team_password_entry_histories
--
-- Those tables still have FK columns pointing at CUID parents, which ARE
-- updated in step 4 below.
-- =============================================================================

BEGIN;

-- Disable FK enforcement for the duration of this migration
SET session_replication_role = 'replica';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Build mapping tables for every parent that has CUID PKs.
--
-- Ordering matters: parents must be mapped before their children so we can
-- update FK columns in one pass.  Dependency order:
--   tenants → users → (most tables)
--   tags (self-ref), folders (self-ref), team_folders (self-ref),
--   team_tags (self-ref)
--   directory_sync_configs → directory_sync_logs
--   emergency_access_grants → emergency_access_key_pairs
--   password_shares → share_access_logs
-- ─────────────────────────────────────────────────────────────────────────────

-- tenants
CREATE TEMP TABLE _id_map_tenants (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_tenants (old_id)
    SELECT id FROM tenants WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- users
CREATE TEMP TABLE _id_map_users (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_users (old_id)
    SELECT id FROM users WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- accounts
CREATE TEMP TABLE _id_map_accounts (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_accounts (old_id)
    SELECT id FROM accounts WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- sessions
CREATE TEMP TABLE _id_map_sessions (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_sessions (old_id)
    SELECT id FROM sessions WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- api_keys
CREATE TEMP TABLE _id_map_api_keys (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_api_keys (old_id)
    SELECT id FROM api_keys WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- audit_logs
CREATE TEMP TABLE _id_map_audit_logs (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_audit_logs (old_id)
    SELECT id FROM audit_logs WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- directory_sync_configs  (parent of directory_sync_logs)
CREATE TEMP TABLE _id_map_directory_sync_configs (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_directory_sync_configs (old_id)
    SELECT id FROM directory_sync_configs WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- directory_sync_logs
CREATE TEMP TABLE _id_map_directory_sync_logs (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_directory_sync_logs (old_id)
    SELECT id FROM directory_sync_logs WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- emergency_access_grants  (parent of emergency_access_key_pairs)
CREATE TEMP TABLE _id_map_emergency_access_grants (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_emergency_access_grants (old_id)
    SELECT id FROM emergency_access_grants WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- emergency_access_key_pairs
CREATE TEMP TABLE _id_map_emergency_access_key_pairs (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_emergency_access_key_pairs (old_id)
    SELECT id FROM emergency_access_key_pairs WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- extension_tokens
CREATE TEMP TABLE _id_map_extension_tokens (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_extension_tokens (old_id)
    SELECT id FROM extension_tokens WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- folders  (self-referential: parent_id → id)
CREATE TEMP TABLE _id_map_folders (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_folders (old_id)
    SELECT id FROM folders WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- notifications
CREATE TEMP TABLE _id_map_notifications (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_notifications (old_id)
    SELECT id FROM notifications WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- password_shares  (parent of share_access_logs)
CREATE TEMP TABLE _id_map_password_shares (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_password_shares (old_id)
    SELECT id FROM password_shares WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- personal_log_access_grants
CREATE TEMP TABLE _id_map_personal_log_access_grants (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_personal_log_access_grants (old_id)
    SELECT id FROM personal_log_access_grants WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- scim_external_mappings
CREATE TEMP TABLE _id_map_scim_external_mappings (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_scim_external_mappings (old_id)
    SELECT id FROM scim_external_mappings WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- scim_group_mappings
CREATE TEMP TABLE _id_map_scim_group_mappings (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_scim_group_mappings (old_id)
    SELECT id FROM scim_group_mappings WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- scim_tokens
CREATE TEMP TABLE _id_map_scim_tokens (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_scim_tokens (old_id)
    SELECT id FROM scim_tokens WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- share_access_logs
CREATE TEMP TABLE _id_map_share_access_logs (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_share_access_logs (old_id)
    SELECT id FROM share_access_logs WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- tags  (self-referential: parent_id → id)
CREATE TEMP TABLE _id_map_tags (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_tags (old_id)
    SELECT id FROM tags WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_folders  (self-referential: parent_id → id)
CREATE TEMP TABLE _id_map_team_folders (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_folders (old_id)
    SELECT id FROM team_folders WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_invitations
CREATE TEMP TABLE _id_map_team_invitations (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_invitations (old_id)
    SELECT id FROM team_invitations WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_member_keys
CREATE TEMP TABLE _id_map_team_member_keys (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_member_keys (old_id)
    SELECT id FROM team_member_keys WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_members
CREATE TEMP TABLE _id_map_team_members (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_members (old_id)
    SELECT id FROM team_members WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_password_favorites
CREATE TEMP TABLE _id_map_team_password_favorites (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_password_favorites (old_id)
    SELECT id FROM team_password_favorites WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_policies
CREATE TEMP TABLE _id_map_team_policies (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_policies (old_id)
    SELECT id FROM team_policies WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_tags  (self-referential: parent_id → id)
CREATE TEMP TABLE _id_map_team_tags (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_tags (old_id)
    SELECT id FROM team_tags WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- team_webhooks
CREATE TEMP TABLE _id_map_team_webhooks (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_team_webhooks (old_id)
    SELECT id FROM team_webhooks WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- tenant_members
CREATE TEMP TABLE _id_map_tenant_members (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_tenant_members (old_id)
    SELECT id FROM tenant_members WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- tenant_webhooks
CREATE TEMP TABLE _id_map_tenant_webhooks (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_tenant_webhooks (old_id)
    SELECT id FROM tenant_webhooks WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- vault_keys
CREATE TEMP TABLE _id_map_vault_keys (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_vault_keys (old_id)
    SELECT id FROM vault_keys WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- webauthn_credentials
CREATE TEMP TABLE _id_map_webauthn_credentials (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_webauthn_credentials (old_id)
    SELECT id FROM webauthn_credentials WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- admin_vault_resets
CREATE TEMP TABLE _id_map_admin_vault_resets (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO _id_map_admin_vault_resets (old_id)
    SELECT id FROM admin_vault_resets WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Update parent PKs
--
-- Process leaf/child tables first, then parents, so self-referential FK
-- updates (parent_id) happen in the correct order within a single table.
-- Because FK checks are disabled we can freely re-order.
-- ─────────────────────────────────────────────────────────────────────────────

-- tenants.id
UPDATE tenants t SET id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.id = m.old_id;

-- users.id
UPDATE users t SET id = m.new_id::TEXT
FROM _id_map_users m WHERE t.id = m.old_id;

-- accounts.id
UPDATE accounts t SET id = m.new_id::TEXT
FROM _id_map_accounts m WHERE t.id = m.old_id;

-- sessions.id
UPDATE sessions t SET id = m.new_id::TEXT
FROM _id_map_sessions m WHERE t.id = m.old_id;

-- api_keys.id
UPDATE api_keys t SET id = m.new_id::TEXT
FROM _id_map_api_keys m WHERE t.id = m.old_id;

-- audit_logs.id
UPDATE audit_logs t SET id = m.new_id::TEXT
FROM _id_map_audit_logs m WHERE t.id = m.old_id;

-- directory_sync_configs.id
UPDATE directory_sync_configs t SET id = m.new_id::TEXT
FROM _id_map_directory_sync_configs m WHERE t.id = m.old_id;

-- directory_sync_logs.id
UPDATE directory_sync_logs t SET id = m.new_id::TEXT
FROM _id_map_directory_sync_logs m WHERE t.id = m.old_id;

-- emergency_access_grants.id
UPDATE emergency_access_grants t SET id = m.new_id::TEXT
FROM _id_map_emergency_access_grants m WHERE t.id = m.old_id;

-- emergency_access_key_pairs.id
UPDATE emergency_access_key_pairs t SET id = m.new_id::TEXT
FROM _id_map_emergency_access_key_pairs m WHERE t.id = m.old_id;

-- extension_tokens.id
UPDATE extension_tokens t SET id = m.new_id::TEXT
FROM _id_map_extension_tokens m WHERE t.id = m.old_id;

-- folders.id
UPDATE folders t SET id = m.new_id::TEXT
FROM _id_map_folders m WHERE t.id = m.old_id;

-- notifications.id
UPDATE notifications t SET id = m.new_id::TEXT
FROM _id_map_notifications m WHERE t.id = m.old_id;

-- password_shares.id
UPDATE password_shares t SET id = m.new_id::TEXT
FROM _id_map_password_shares m WHERE t.id = m.old_id;

-- personal_log_access_grants.id
UPDATE personal_log_access_grants t SET id = m.new_id::TEXT
FROM _id_map_personal_log_access_grants m WHERE t.id = m.old_id;

-- scim_external_mappings.id
UPDATE scim_external_mappings t SET id = m.new_id::TEXT
FROM _id_map_scim_external_mappings m WHERE t.id = m.old_id;

-- scim_group_mappings.id
UPDATE scim_group_mappings t SET id = m.new_id::TEXT
FROM _id_map_scim_group_mappings m WHERE t.id = m.old_id;

-- scim_tokens.id
UPDATE scim_tokens t SET id = m.new_id::TEXT
FROM _id_map_scim_tokens m WHERE t.id = m.old_id;

-- share_access_logs.id
UPDATE share_access_logs t SET id = m.new_id::TEXT
FROM _id_map_share_access_logs m WHERE t.id = m.old_id;

-- tags.id
UPDATE tags t SET id = m.new_id::TEXT
FROM _id_map_tags m WHERE t.id = m.old_id;

-- team_folders.id
UPDATE team_folders t SET id = m.new_id::TEXT
FROM _id_map_team_folders m WHERE t.id = m.old_id;

-- team_invitations.id
UPDATE team_invitations t SET id = m.new_id::TEXT
FROM _id_map_team_invitations m WHERE t.id = m.old_id;

-- team_member_keys.id
UPDATE team_member_keys t SET id = m.new_id::TEXT
FROM _id_map_team_member_keys m WHERE t.id = m.old_id;

-- team_members.id
UPDATE team_members t SET id = m.new_id::TEXT
FROM _id_map_team_members m WHERE t.id = m.old_id;

-- team_password_favorites.id
UPDATE team_password_favorites t SET id = m.new_id::TEXT
FROM _id_map_team_password_favorites m WHERE t.id = m.old_id;

-- team_policies.id
UPDATE team_policies t SET id = m.new_id::TEXT
FROM _id_map_team_policies m WHERE t.id = m.old_id;

-- team_tags.id
UPDATE team_tags t SET id = m.new_id::TEXT
FROM _id_map_team_tags m WHERE t.id = m.old_id;

-- team_webhooks.id
UPDATE team_webhooks t SET id = m.new_id::TEXT
FROM _id_map_team_webhooks m WHERE t.id = m.old_id;

-- tenant_members.id
UPDATE tenant_members t SET id = m.new_id::TEXT
FROM _id_map_tenant_members m WHERE t.id = m.old_id;

-- tenant_webhooks.id
UPDATE tenant_webhooks t SET id = m.new_id::TEXT
FROM _id_map_tenant_webhooks m WHERE t.id = m.old_id;

-- vault_keys.id
UPDATE vault_keys t SET id = m.new_id::TEXT
FROM _id_map_vault_keys m WHERE t.id = m.old_id;

-- webauthn_credentials.id
UPDATE webauthn_credentials t SET id = m.new_id::TEXT
FROM _id_map_webauthn_credentials m WHERE t.id = m.old_id;

-- admin_vault_resets.id
UPDATE admin_vault_resets t SET id = m.new_id::TEXT
FROM _id_map_admin_vault_resets m WHERE t.id = m.old_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Update FK columns in every child table (including already-UUID
--         tables like password_entries, teams, attachments, etc.)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── tenants FK references (tenant_id columns) ──────────────────────────────

UPDATE accounts t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE sessions t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE users t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE extension_tokens t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE scim_tokens t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE scim_external_mappings t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE tags t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE vault_keys t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE password_entries t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE teams t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE tenant_members t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE scim_group_mappings t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_members t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_member_keys t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_password_entries t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_tags t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_password_favorites t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_invitations t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE password_shares t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE share_access_logs t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE audit_logs t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE attachments t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE emergency_access_grants t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE folders t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_folders t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE password_entry_histories t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_password_entry_histories t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE emergency_access_key_pairs t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE api_keys t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE webauthn_credentials t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE directory_sync_configs t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE directory_sync_logs t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE notifications t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_policies t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE team_webhooks t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE tenant_webhooks t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE admin_vault_resets t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

UPDATE personal_log_access_grants t SET tenant_id = m.new_id::TEXT
FROM _id_map_tenants m WHERE t.tenant_id = m.old_id;

-- ── users FK references ────────────────────────────────────────────────────

-- accounts.user_id
UPDATE accounts t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- sessions.user_id
UPDATE sessions t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- extension_tokens.user_id
UPDATE extension_tokens t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- scim_tokens.created_by_id (nullable)
UPDATE scim_tokens t SET created_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.created_by_id = m.old_id;

-- tags.user_id
UPDATE tags t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- vault_keys.user_id
UPDATE vault_keys t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- password_entries.user_id
UPDATE password_entries t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- tenant_members.user_id
UPDATE tenant_members t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- team_members.user_id
UPDATE team_members t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- team_member_keys.user_id
UPDATE team_member_keys t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- team_password_entries.created_by_id
UPDATE team_password_entries t SET created_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.created_by_id = m.old_id;

-- team_password_entries.updated_by_id
UPDATE team_password_entries t SET updated_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.updated_by_id = m.old_id;

-- team_password_favorites.user_id
UPDATE team_password_favorites t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- team_invitations.invited_by_id
UPDATE team_invitations t SET invited_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.invited_by_id = m.old_id;

-- password_shares.created_by_id
UPDATE password_shares t SET created_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.created_by_id = m.old_id;

-- audit_logs.user_id
UPDATE audit_logs t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- attachments.created_by_id
UPDATE attachments t SET created_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.created_by_id = m.old_id;

-- emergency_access_grants.owner_id
UPDATE emergency_access_grants t SET owner_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.owner_id = m.old_id;

-- emergency_access_grants.grantee_id (nullable)
UPDATE emergency_access_grants t SET grantee_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.grantee_id = m.old_id;

-- folders.user_id
UPDATE folders t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- team_password_entry_histories.changed_by_id
UPDATE team_password_entry_histories t SET changed_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.changed_by_id = m.old_id;

-- api_keys.user_id
UPDATE api_keys t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- webauthn_credentials.user_id
UPDATE webauthn_credentials t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- notifications.user_id
UPDATE notifications t SET user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.user_id = m.old_id;

-- admin_vault_resets.target_user_id
UPDATE admin_vault_resets t SET target_user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.target_user_id = m.old_id;

-- admin_vault_resets.initiated_by_id
UPDATE admin_vault_resets t SET initiated_by_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.initiated_by_id = m.old_id;

-- personal_log_access_grants.requester_id
UPDATE personal_log_access_grants t SET requester_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.requester_id = m.old_id;

-- personal_log_access_grants.target_user_id
UPDATE personal_log_access_grants t SET target_user_id = m.new_id::TEXT
FROM _id_map_users m WHERE t.target_user_id = m.old_id;

-- ── directory_sync_configs → directory_sync_logs ───────────────────────────

UPDATE directory_sync_logs t SET config_id = m.new_id::TEXT
FROM _id_map_directory_sync_configs m WHERE t.config_id = m.old_id;

-- ── emergency_access_grants → emergency_access_key_pairs ──────────────────

UPDATE emergency_access_key_pairs t SET grant_id = m.new_id::TEXT
FROM _id_map_emergency_access_grants m WHERE t.grant_id = m.old_id;

-- ── folders self-referential (parent_id, nullable) ────────────────────────

UPDATE folders t SET parent_id = m.new_id::TEXT
FROM _id_map_folders m WHERE t.parent_id = m.old_id;

-- ── password_entries.folder_id → folders (nullable) ──────────────────────

UPDATE password_entries t SET folder_id = m.new_id::TEXT
FROM _id_map_folders m WHERE t.folder_id = m.old_id;

-- ── password_shares → share_access_logs ───────────────────────────────────

UPDATE share_access_logs t SET share_id = m.new_id::TEXT
FROM _id_map_password_shares m WHERE t.share_id = m.old_id;

-- ── tags self-referential (parent_id, nullable) ───────────────────────────

UPDATE tags t SET parent_id = m.new_id::TEXT
FROM _id_map_tags m WHERE t.parent_id = m.old_id;

-- ── _PasswordEntryToTag.B → tags ─────────────────────────────────────────

UPDATE "_PasswordEntryToTag" t SET "B" = m.new_id::TEXT
FROM _id_map_tags m WHERE t."B" = m.old_id;

-- ── team_folders self-referential (parent_id, nullable) ───────────────────

UPDATE team_folders t SET parent_id = m.new_id::TEXT
FROM _id_map_team_folders m WHERE t.parent_id = m.old_id;

-- ── team_password_entries.team_folder_id → team_folders (nullable) ────────

UPDATE team_password_entries t SET team_folder_id = m.new_id::TEXT
FROM _id_map_team_folders m WHERE t.team_folder_id = m.old_id;

-- ── team_tags self-referential (parent_id, nullable) ─────────────────────

UPDATE team_tags t SET parent_id = m.new_id::TEXT
FROM _id_map_team_tags m WHERE t.parent_id = m.old_id;

-- ── _TeamPasswordEntryToTeamTag.B → team_tags ────────────────────────────

UPDATE "_TeamPasswordEntryToTeamTag" t SET "B" = m.new_id::TEXT
FROM _id_map_team_tags m WHERE t."B" = m.old_id;

-- ── teams.id is already UUID; teams has tenant_id (updated above) ─────────
--    scim_group_mappings.team_id → teams (already UUID PKs, no mapping needed)
--    team_members.team_id → teams
--    team_member_keys.team_id → teams
--    team_password_entries.team_id → teams
--    team_tags.team_id → teams
--    team_folders.team_id → teams
--    team_invitations.team_id → teams
--    team_policies.team_id → teams
--    team_webhooks.team_id → teams
--    admin_vault_resets.team_id → teams
--    audit_logs.team_id → teams
--    (all nullable or cascade, but teams PKs are already UUID — no update needed)

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Change DEFAULT to gen_random_uuid() for all tables
--
-- NOTE: Column type remains TEXT for now. Migration to native PostgreSQL uuid
-- type is deferred to a separate task (export → reset → import).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tenants                   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE users                     ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE accounts                  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE sessions                  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE api_keys                  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE audit_logs                ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE directory_sync_configs    ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE directory_sync_logs       ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE emergency_access_grants   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE emergency_access_key_pairs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE extension_tokens          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE folders                   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE notifications             ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE password_shares           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE personal_log_access_grants ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE scim_external_mappings    ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE scim_group_mappings       ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE scim_tokens               ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE share_access_logs         ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE tags                      ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_folders              ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_invitations          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_member_keys          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_members              ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_password_favorites   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_policies             ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_tags                 ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_webhooks             ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE tenant_members            ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE tenant_webhooks           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE vault_keys                ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE webauthn_credentials      ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE admin_vault_resets        ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE password_entries          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_password_entries     ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE teams                     ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE attachments               ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE password_entry_histories  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE team_password_entry_histories ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Drop temp mapping tables and restore FK enforcement
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE _id_map_tenants;
DROP TABLE _id_map_users;
DROP TABLE _id_map_accounts;
DROP TABLE _id_map_sessions;
DROP TABLE _id_map_api_keys;
DROP TABLE _id_map_audit_logs;
DROP TABLE _id_map_directory_sync_configs;
DROP TABLE _id_map_directory_sync_logs;
DROP TABLE _id_map_emergency_access_grants;
DROP TABLE _id_map_emergency_access_key_pairs;
DROP TABLE _id_map_extension_tokens;
DROP TABLE _id_map_folders;
DROP TABLE _id_map_notifications;
DROP TABLE _id_map_password_shares;
DROP TABLE _id_map_personal_log_access_grants;
DROP TABLE _id_map_scim_external_mappings;
DROP TABLE _id_map_scim_group_mappings;
DROP TABLE _id_map_scim_tokens;
DROP TABLE _id_map_share_access_logs;
DROP TABLE _id_map_tags;
DROP TABLE _id_map_team_folders;
DROP TABLE _id_map_team_invitations;
DROP TABLE _id_map_team_member_keys;
DROP TABLE _id_map_team_members;
DROP TABLE _id_map_team_password_favorites;
DROP TABLE _id_map_team_policies;
DROP TABLE _id_map_team_tags;
DROP TABLE _id_map_team_webhooks;
DROP TABLE _id_map_tenant_members;
DROP TABLE _id_map_tenant_webhooks;
DROP TABLE _id_map_vault_keys;
DROP TABLE _id_map_webauthn_credentials;
DROP TABLE _id_map_admin_vault_resets;

SET session_replication_role = 'origin';

COMMIT;
