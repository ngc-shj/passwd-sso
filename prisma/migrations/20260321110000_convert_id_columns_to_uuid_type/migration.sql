-- =============================================================================
-- Migration: Convert all ID/FK columns from TEXT to native UUID type
--
-- Strategy:
--   1. Save all FK constraint definitions to a temp table
--   2. Drop all FK constraints (required for ALTER TYPE on referenced columns)
--   3. ALTER COLUMN ... TYPE uuid USING column::uuid for all ID/FK columns
--   4. Update column defaults to gen_random_uuid() (now uuid-typed)
--   5. Recreate all FK constraints from saved definitions
--
-- Prerequisites:
--   - All data must already be in UUID v4 text format (done by migration
--     20260321100000_unify_all_ids_to_uuid)
--   - Works on both empty and data-containing databases
-- =============================================================================

-- NOTE: No explicit BEGIN/COMMIT — Prisma wraps each migration in a transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Save FK constraint definitions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _saved_fks (
  table_name TEXT NOT NULL,
  constraint_name TEXT NOT NULL,
  definition TEXT NOT NULL
);

INSERT INTO _saved_fks (table_name, constraint_name, definition)
SELECT tc.table_name, tc.constraint_name, pg_get_constraintdef(c.oid)
FROM information_schema.table_constraints tc
JOIN pg_constraint c
  ON c.conname = tc.constraint_name
  AND c.connamespace = 'public'::regnamespace
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public';

-- STEP 1b: RLS policies are handled statically (no save needed).
-- They are dropped in STEP 2 and recreated in STEP 5 with explicit ::uuid casts.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1c: Save trigger definitions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _saved_triggers (
  table_name TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  definition TEXT NOT NULL
);

INSERT INTO _saved_triggers (table_name, trigger_name, definition)
SELECT
  tgrelid::regclass::TEXT,
  tgname,
  pg_get_triggerdef(oid)
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgrelid::regclass::TEXT NOT LIKE 'pg_%';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1d: Save CHECK constraint definitions that reference ID columns
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _saved_checks (
  table_name TEXT NOT NULL,
  constraint_name TEXT NOT NULL,
  definition TEXT NOT NULL
);

INSERT INTO _saved_checks (table_name, constraint_name, definition)
SELECT conrelid::regclass::TEXT, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'c'
  AND connamespace = 'public'::regnamespace
  AND (pg_get_constraintdef(oid) LIKE '%_id%' OR pg_get_constraintdef(oid) LIKE '% id)%');

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Drop all FK constraints, CHECK constraints, RLS policies, and triggers
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _saved_fks LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
  FOR r IN SELECT * FROM _saved_checks LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
  -- RLS policies: drop statically (37 policies)
  EXECUTE 'DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts';
  EXECUTE 'DROP POLICY IF EXISTS admin_vault_resets_tenant_isolation ON admin_vault_resets';
  EXECUTE 'DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys';
  EXECUTE 'DROP POLICY IF EXISTS attachments_tenant_isolation ON attachments';
  EXECUTE 'DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs';
  EXECUTE 'DROP POLICY IF EXISTS directory_sync_configs_tenant_isolation ON directory_sync_configs';
  EXECUTE 'DROP POLICY IF EXISTS directory_sync_logs_tenant_isolation ON directory_sync_logs';
  EXECUTE 'DROP POLICY IF EXISTS emergency_access_grants_tenant_isolation ON emergency_access_grants';
  EXECUTE 'DROP POLICY IF EXISTS emergency_access_key_pairs_tenant_isolation ON emergency_access_key_pairs';
  EXECUTE 'DROP POLICY IF EXISTS extension_tokens_tenant_isolation ON extension_tokens';
  EXECUTE 'DROP POLICY IF EXISTS folders_tenant_isolation ON folders';
  EXECUTE 'DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications';
  EXECUTE 'DROP POLICY IF EXISTS password_entries_tenant_isolation ON password_entries';
  EXECUTE 'DROP POLICY IF EXISTS password_entry_histories_tenant_isolation ON password_entry_histories';
  EXECUTE 'DROP POLICY IF EXISTS password_shares_tenant_isolation ON password_shares';
  EXECUTE 'DROP POLICY IF EXISTS personal_log_access_grants_tenant_isolation ON personal_log_access_grants';
  EXECUTE 'DROP POLICY IF EXISTS scim_external_mappings_tenant_isolation ON scim_external_mappings';
  EXECUTE 'DROP POLICY IF EXISTS scim_group_mappings_tenant_isolation ON scim_group_mappings';
  EXECUTE 'DROP POLICY IF EXISTS scim_tokens_tenant_isolation ON scim_tokens';
  EXECUTE 'DROP POLICY IF EXISTS sessions_tenant_isolation ON sessions';
  EXECUTE 'DROP POLICY IF EXISTS share_access_logs_tenant_isolation ON share_access_logs';
  EXECUTE 'DROP POLICY IF EXISTS tags_tenant_isolation ON tags';
  EXECUTE 'DROP POLICY IF EXISTS team_folders_tenant_isolation ON team_folders';
  EXECUTE 'DROP POLICY IF EXISTS team_invitations_tenant_isolation ON team_invitations';
  EXECUTE 'DROP POLICY IF EXISTS team_member_keys_tenant_isolation ON team_member_keys';
  EXECUTE 'DROP POLICY IF EXISTS team_members_tenant_isolation ON team_members';
  EXECUTE 'DROP POLICY IF EXISTS team_password_entries_tenant_isolation ON team_password_entries';
  EXECUTE 'DROP POLICY IF EXISTS team_password_entry_histories_tenant_isolation ON team_password_entry_histories';
  EXECUTE 'DROP POLICY IF EXISTS team_password_favorites_tenant_isolation ON team_password_favorites';
  EXECUTE 'DROP POLICY IF EXISTS team_tags_tenant_isolation ON team_tags';
  EXECUTE 'DROP POLICY IF EXISTS team_webhooks_tenant_isolation ON team_webhooks';
  EXECUTE 'DROP POLICY IF EXISTS teams_tenant_isolation ON teams';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON team_policies';  -- renamed below to team_policies_tenant_isolation
  EXECUTE 'DROP POLICY IF EXISTS tenant_members_tenant_isolation ON tenant_members';
  EXECUTE 'DROP POLICY IF EXISTS tenant_webhooks_tenant_isolation ON tenant_webhooks';
  EXECUTE 'DROP POLICY IF EXISTS users_tenant_isolation ON users';
  EXECUTE 'DROP POLICY IF EXISTS vault_keys_tenant_isolation ON vault_keys';
  EXECUTE 'DROP POLICY IF EXISTS webauthn_credentials_tenant_isolation ON webauthn_credentials';
  FOR r IN SELECT * FROM _saved_triggers LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', r.trigger_name, r.table_name);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Convert all ID/FK columns from TEXT to UUID
--
-- Excludes non-UUID text columns:
--   accounts.provider_account_id (OAuth provider ID)
--   audit_logs.target_id (polymorphic, mixed formats)
--   scim_external_mappings.external_id (external system ID)
--   scim_external_mappings.internal_id (may not be UUID)
--   scim_group_mappings.external_group_id (external system ID)
--   webauthn_credentials.credential_id (base64url WebAuthn ID)
-- ─────────────────────────────────────────────────────────────────────────────

-- Implicit join tables
ALTER TABLE "_PasswordEntryToTag"         ALTER COLUMN "A" TYPE uuid USING "A"::uuid;
ALTER TABLE "_PasswordEntryToTag"         ALTER COLUMN "B" TYPE uuid USING "B"::uuid;
ALTER TABLE "_TeamPasswordEntryToTeamTag" ALTER COLUMN "A" TYPE uuid USING "A"::uuid;
ALTER TABLE "_TeamPasswordEntryToTeamTag" ALTER COLUMN "B" TYPE uuid USING "B"::uuid;

-- accounts
ALTER TABLE accounts ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE accounts ALTER COLUMN tenant_id  TYPE uuid USING tenant_id::uuid;
ALTER TABLE accounts ALTER COLUMN user_id    TYPE uuid USING user_id::uuid;

-- admin_vault_resets
ALTER TABLE admin_vault_resets ALTER COLUMN id              TYPE uuid USING id::uuid;
ALTER TABLE admin_vault_resets ALTER COLUMN initiated_by_id TYPE uuid USING initiated_by_id::uuid;
ALTER TABLE admin_vault_resets ALTER COLUMN target_user_id  TYPE uuid USING target_user_id::uuid;
ALTER TABLE admin_vault_resets ALTER COLUMN team_id         TYPE uuid USING team_id::uuid;
ALTER TABLE admin_vault_resets ALTER COLUMN tenant_id       TYPE uuid USING tenant_id::uuid;

-- api_keys
ALTER TABLE api_keys ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE api_keys ALTER COLUMN tenant_id  TYPE uuid USING tenant_id::uuid;
ALTER TABLE api_keys ALTER COLUMN user_id    TYPE uuid USING user_id::uuid;

-- attachments
ALTER TABLE attachments ALTER COLUMN id                     TYPE uuid USING id::uuid;
ALTER TABLE attachments ALTER COLUMN created_by_id          TYPE uuid USING created_by_id::uuid;
ALTER TABLE attachments ALTER COLUMN password_entry_id      TYPE uuid USING password_entry_id::uuid;
ALTER TABLE attachments ALTER COLUMN team_password_entry_id TYPE uuid USING team_password_entry_id::uuid;
ALTER TABLE attachments ALTER COLUMN tenant_id              TYPE uuid USING tenant_id::uuid;

-- audit_logs (target_id excluded — polymorphic)
ALTER TABLE audit_logs ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE audit_logs ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE audit_logs ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE audit_logs ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- directory_sync_configs
ALTER TABLE directory_sync_configs ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE directory_sync_configs ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- directory_sync_logs
ALTER TABLE directory_sync_logs ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE directory_sync_logs ALTER COLUMN config_id TYPE uuid USING config_id::uuid;
ALTER TABLE directory_sync_logs ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- emergency_access_grants
ALTER TABLE emergency_access_grants ALTER COLUMN id         TYPE uuid USING id::uuid;
ALTER TABLE emergency_access_grants ALTER COLUMN grantee_id TYPE uuid USING grantee_id::uuid;
ALTER TABLE emergency_access_grants ALTER COLUMN owner_id   TYPE uuid USING owner_id::uuid;
ALTER TABLE emergency_access_grants ALTER COLUMN tenant_id  TYPE uuid USING tenant_id::uuid;

-- emergency_access_key_pairs
ALTER TABLE emergency_access_key_pairs ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE emergency_access_key_pairs ALTER COLUMN grant_id  TYPE uuid USING grant_id::uuid;
ALTER TABLE emergency_access_key_pairs ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- extension_tokens
ALTER TABLE extension_tokens ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE extension_tokens ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE extension_tokens ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- folders
ALTER TABLE folders ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE folders ALTER COLUMN parent_id TYPE uuid USING parent_id::uuid;
ALTER TABLE folders ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE folders ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- notifications
ALTER TABLE notifications ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE notifications ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE notifications ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- password_entries
ALTER TABLE password_entries ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE password_entries ALTER COLUMN folder_id TYPE uuid USING folder_id::uuid;
ALTER TABLE password_entries ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE password_entries ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- password_entry_histories
ALTER TABLE password_entry_histories ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE password_entry_histories ALTER COLUMN entry_id  TYPE uuid USING entry_id::uuid;
ALTER TABLE password_entry_histories ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- password_shares
ALTER TABLE password_shares ALTER COLUMN id                     TYPE uuid USING id::uuid;
ALTER TABLE password_shares ALTER COLUMN created_by_id          TYPE uuid USING created_by_id::uuid;
ALTER TABLE password_shares ALTER COLUMN password_entry_id      TYPE uuid USING password_entry_id::uuid;
ALTER TABLE password_shares ALTER COLUMN team_password_entry_id TYPE uuid USING team_password_entry_id::uuid;
ALTER TABLE password_shares ALTER COLUMN tenant_id              TYPE uuid USING tenant_id::uuid;

-- personal_log_access_grants
ALTER TABLE personal_log_access_grants ALTER COLUMN id             TYPE uuid USING id::uuid;
ALTER TABLE personal_log_access_grants ALTER COLUMN requester_id   TYPE uuid USING requester_id::uuid;
ALTER TABLE personal_log_access_grants ALTER COLUMN target_user_id TYPE uuid USING target_user_id::uuid;
ALTER TABLE personal_log_access_grants ALTER COLUMN tenant_id      TYPE uuid USING tenant_id::uuid;

-- scim_external_mappings (external_id, internal_id excluded)
ALTER TABLE scim_external_mappings ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE scim_external_mappings ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- scim_group_mappings (external_group_id excluded)
ALTER TABLE scim_group_mappings ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE scim_group_mappings ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE scim_group_mappings ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- scim_tokens
ALTER TABLE scim_tokens ALTER COLUMN id            TYPE uuid USING id::uuid;
ALTER TABLE scim_tokens ALTER COLUMN created_by_id TYPE uuid USING created_by_id::uuid;
ALTER TABLE scim_tokens ALTER COLUMN tenant_id     TYPE uuid USING tenant_id::uuid;

-- sessions
ALTER TABLE sessions ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE sessions ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE sessions ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- share_access_logs
ALTER TABLE share_access_logs ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE share_access_logs ALTER COLUMN share_id  TYPE uuid USING share_id::uuid;
ALTER TABLE share_access_logs ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- tags
ALTER TABLE tags ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE tags ALTER COLUMN parent_id TYPE uuid USING parent_id::uuid;
ALTER TABLE tags ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE tags ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- team_folders
ALTER TABLE team_folders ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_folders ALTER COLUMN parent_id TYPE uuid USING parent_id::uuid;
ALTER TABLE team_folders ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_folders ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- team_invitations
ALTER TABLE team_invitations ALTER COLUMN id            TYPE uuid USING id::uuid;
ALTER TABLE team_invitations ALTER COLUMN invited_by_id TYPE uuid USING invited_by_id::uuid;
ALTER TABLE team_invitations ALTER COLUMN team_id       TYPE uuid USING team_id::uuid;
ALTER TABLE team_invitations ALTER COLUMN tenant_id     TYPE uuid USING tenant_id::uuid;

-- team_member_keys
ALTER TABLE team_member_keys ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_member_keys ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_member_keys ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE team_member_keys ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- team_members
ALTER TABLE team_members ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_members ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_members ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE team_members ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- team_password_entries
ALTER TABLE team_password_entries ALTER COLUMN id             TYPE uuid USING id::uuid;
ALTER TABLE team_password_entries ALTER COLUMN created_by_id  TYPE uuid USING created_by_id::uuid;
ALTER TABLE team_password_entries ALTER COLUMN team_folder_id TYPE uuid USING team_folder_id::uuid;
ALTER TABLE team_password_entries ALTER COLUMN team_id        TYPE uuid USING team_id::uuid;
ALTER TABLE team_password_entries ALTER COLUMN tenant_id      TYPE uuid USING tenant_id::uuid;
ALTER TABLE team_password_entries ALTER COLUMN updated_by_id  TYPE uuid USING updated_by_id::uuid;

-- team_password_entry_histories
ALTER TABLE team_password_entry_histories ALTER COLUMN id            TYPE uuid USING id::uuid;
ALTER TABLE team_password_entry_histories ALTER COLUMN changed_by_id TYPE uuid USING changed_by_id::uuid;
ALTER TABLE team_password_entry_histories ALTER COLUMN entry_id      TYPE uuid USING entry_id::uuid;
ALTER TABLE team_password_entry_histories ALTER COLUMN tenant_id     TYPE uuid USING tenant_id::uuid;

-- team_password_favorites
ALTER TABLE team_password_favorites ALTER COLUMN id                     TYPE uuid USING id::uuid;
ALTER TABLE team_password_favorites ALTER COLUMN team_password_entry_id TYPE uuid USING team_password_entry_id::uuid;
ALTER TABLE team_password_favorites ALTER COLUMN tenant_id              TYPE uuid USING tenant_id::uuid;
ALTER TABLE team_password_favorites ALTER COLUMN user_id                TYPE uuid USING user_id::uuid;

-- team_policies
ALTER TABLE team_policies ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_policies ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_policies ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- team_tags
ALTER TABLE team_tags ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_tags ALTER COLUMN parent_id TYPE uuid USING parent_id::uuid;
ALTER TABLE team_tags ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_tags ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- team_webhooks
ALTER TABLE team_webhooks ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE team_webhooks ALTER COLUMN team_id   TYPE uuid USING team_id::uuid;
ALTER TABLE team_webhooks ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- teams
ALTER TABLE teams ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE teams ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- tenant_members
ALTER TABLE tenant_members ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE tenant_members ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE tenant_members ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- tenant_webhooks
ALTER TABLE tenant_webhooks ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE tenant_webhooks ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- tenants
ALTER TABLE tenants ALTER COLUMN id TYPE uuid USING id::uuid;

-- users
ALTER TABLE users ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE users ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- vault_keys
ALTER TABLE vault_keys ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE vault_keys ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE vault_keys ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- webauthn_credentials (credential_id excluded — base64url WebAuthn ID)
ALTER TABLE webauthn_credentials ALTER COLUMN id        TYPE uuid USING id::uuid;
ALTER TABLE webauthn_credentials ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE webauthn_credentials ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Recreate all FK constraints
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _saved_fks LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', r.table_name, r.constraint_name, r.definition);
  END LOOP;
END $$;

DROP TABLE _saved_fks;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4b: Recreate all CHECK constraints
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _saved_checks LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', r.table_name, r.constraint_name, r.definition);
  END LOOP;
END $$;

DROP TABLE _saved_checks;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Recreate all RLS policies (static definitions)
--
-- All 37 policies follow the same pattern: bypass_rls OR tenant_id match.
-- Static listing avoids dependence on pg_policies internal representation
-- (e.g. roles format, ::text casts) which varies across PostgreSQL versions.
-- The only change from the original definitions is the ::uuid cast on
-- current_setting('app.tenant_id', true) to match the new uuid column type.
-- ─────────────────────────────────────────────────────────────────────────────

-- Macro: standard bypass_rls + tenant isolation policy
-- All policies use: USING (...) WITH CHECK (...)

CREATE POLICY accounts_tenant_isolation ON accounts
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY admin_vault_resets_tenant_isolation ON admin_vault_resets
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY attachments_tenant_isolation ON attachments
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY directory_sync_configs_tenant_isolation ON directory_sync_configs
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY directory_sync_logs_tenant_isolation ON directory_sync_logs
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY emergency_access_grants_tenant_isolation ON emergency_access_grants
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY emergency_access_key_pairs_tenant_isolation ON emergency_access_key_pairs
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY extension_tokens_tenant_isolation ON extension_tokens
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY folders_tenant_isolation ON folders
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY notifications_tenant_isolation ON notifications
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY password_entries_tenant_isolation ON password_entries
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY password_entry_histories_tenant_isolation ON password_entry_histories
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY password_shares_tenant_isolation ON password_shares
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY personal_log_access_grants_tenant_isolation ON personal_log_access_grants
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY scim_external_mappings_tenant_isolation ON scim_external_mappings
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY scim_group_mappings_tenant_isolation ON scim_group_mappings
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY scim_tokens_tenant_isolation ON scim_tokens
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY sessions_tenant_isolation ON sessions
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY share_access_logs_tenant_isolation ON share_access_logs
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tags_tenant_isolation ON tags
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_folders_tenant_isolation ON team_folders
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_invitations_tenant_isolation ON team_invitations
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_member_keys_tenant_isolation ON team_member_keys
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_members_tenant_isolation ON team_members
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_password_entries_tenant_isolation ON team_password_entries
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_password_entry_histories_tenant_isolation ON team_password_entry_histories
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_password_favorites_tenant_isolation ON team_password_favorites
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_tags_tenant_isolation ON team_tags
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_webhooks_tenant_isolation ON team_webhooks
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY teams_tenant_isolation ON teams
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY team_policies_tenant_isolation ON team_policies
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_members_tenant_isolation ON tenant_members
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY users_tenant_isolation ON users
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY vault_keys_tenant_isolation ON vault_keys
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY webauthn_credentials_tenant_isolation ON webauthn_credentials
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_webhooks_tenant_isolation ON tenant_webhooks
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: Update trigger functions for UUID-typed columns
--
-- These functions previously used TEXT comparisons for tenant_id and other IDs.
-- Now that all ID columns are native UUID, the functions must cast
-- current_setting() results and JSONB extractions to uuid.
-- ─────────────────────────────────────────────────────────────────────────────

-- 6a: resolve_tenant_id_from_row — returns text (unchanged), but WHERE clauses
--     now compare uuid columns with jsonb-extracted text; add explicit casts.
CREATE OR REPLACE FUNCTION resolve_tenant_id_from_row(p_table text, p_row jsonb)
RETURNS text LANGUAGE plpgsql AS $function$
DECLARE
  v_tenant_id text;
BEGIN
  IF p_table IN ('accounts', 'sessions', 'extension_tokens', 'tags', 'vault_keys', 'password_entries', 'folders') THEN
    SELECT u."tenant_id"::text INTO v_tenant_id
    FROM "users" u WHERE u."id" = (p_row->>'user_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'emergency_access_grants' THEN
    SELECT u."tenant_id"::text INTO v_tenant_id
    FROM "users" u WHERE u."id" = (p_row->>'owner_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table IN (
    'team_members', 'team_member_keys', 'team_password_entries', 'team_tags',
    'team_invitations', 'team_folders', 'scim_tokens', 'scim_external_mappings',
    'scim_group_mappings'
  ) THEN
    SELECT t."tenant_id"::text INTO v_tenant_id
    FROM "teams" t WHERE t."id" = (p_row->>'team_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'team_password_favorites' THEN
    SELECT tpe."tenant_id"::text INTO v_tenant_id
    FROM "team_password_entries" tpe WHERE tpe."id" = (p_row->>'team_password_entry_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'password_shares' THEN
    SELECT COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id")::text INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "team_password_entries" tpe ON tpe."id" = (p_row->>'team_password_entry_id')::uuid
    LEFT JOIN "password_entries" pe ON pe."id" = (p_row->>'password_entry_id')::uuid
    WHERE u."id" = (p_row->>'created_by_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'share_access_logs' THEN
    SELECT ps."tenant_id"::text INTO v_tenant_id
    FROM "password_shares" ps WHERE ps."id" = (p_row->>'share_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'audit_logs' THEN
    SELECT COALESCE(t."tenant_id", u."tenant_id")::text INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "teams" t ON t."id" = (p_row->>'team_id')::uuid
    WHERE u."id" = (p_row->>'user_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'attachments' THEN
    SELECT COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id")::text INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "team_password_entries" tpe ON tpe."id" = (p_row->>'team_password_entry_id')::uuid
    LEFT JOIN "password_entries" pe ON pe."id" = (p_row->>'password_entry_id')::uuid
    WHERE u."id" = (p_row->>'created_by_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'password_entry_histories' THEN
    SELECT pe."tenant_id"::text INTO v_tenant_id
    FROM "password_entries" pe WHERE pe."id" = (p_row->>'entry_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'team_password_entry_histories' THEN
    SELECT tpe."tenant_id"::text INTO v_tenant_id
    FROM "team_password_entries" tpe WHERE tpe."id" = (p_row->>'entry_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'emergency_access_key_pairs' THEN
    SELECT eag."tenant_id"::text INTO v_tenant_id
    FROM "emergency_access_grants" eag WHERE eag."id" = (p_row->>'grant_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  IF p_table = 'tenant_members' THEN
    SELECT u."tenant_id"::text INTO v_tenant_id
    FROM "users" u WHERE u."id" = (p_row->>'user_id')::uuid;
    RETURN v_tenant_id;
  END IF;
  RETURN NULL;
END;
$function$;

-- 6b: enforce_tenant_id_from_context — use uuid for tenant_id comparisons,
--     generate deterministic UUID for bootstrap tenants via md5()::uuid.
CREATE OR REPLACE FUNCTION enforce_tenant_id_from_context()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  bypass_enabled boolean := COALESCE(current_setting('app.bypass_rls', true), '') = 'on';
  ctx_tenant_id uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  derived_tenant_id text;
BEGIN
  IF bypass_enabled THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.tenant_id IS NULL THEN
      IF ctx_tenant_id IS NOT NULL THEN
        NEW.tenant_id := ctx_tenant_id;
      ELSE
        IF TG_TABLE_NAME = 'users' THEN
          -- Deterministic bootstrap tenant: MD5 of user id formatted as UUID
          NEW.tenant_id := md5(NEW.id::text)::uuid;

          INSERT INTO "tenants" ("id", "name", "slug", "created_at", "updated_at")
          VALUES (
            NEW.tenant_id,
            COALESCE(NEW.email, CONCAT('user-', SUBSTRING(NEW.id::text FROM 1 FOR 8))),
            CONCAT('u-', SUBSTRING(NEW.tenant_id::text FROM 1 FOR 24)),
            NOW(),
            NOW()
          )
          ON CONFLICT ("id") DO NOTHING;
        ELSE
          derived_tenant_id := resolve_tenant_id_from_row(TG_TABLE_NAME, to_jsonb(NEW));
          IF derived_tenant_id IS NULL THEN
            RAISE EXCEPTION 'tenant_id missing and app.tenant_id is not set for %', TG_TABLE_NAME;
          END IF;
          NEW.tenant_id := derived_tenant_id::uuid;
        END IF;
      END IF;
    ELSIF ctx_tenant_id IS NOT NULL AND NEW.tenant_id <> ctx_tenant_id THEN
      RAISE EXCEPTION 'tenant_id mismatch on %: row tenant_id(%) != app.tenant_id(%)', TG_TABLE_NAME, NEW.tenant_id, ctx_tenant_id;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS NULL THEN
      IF ctx_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id cannot be NULL on %', TG_TABLE_NAME;
      END IF;
      NEW.tenant_id := ctx_tenant_id;
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      IF ctx_tenant_id IS NULL OR NEW.tenant_id <> ctx_tenant_id THEN
        RAISE EXCEPTION 'tenant_id mutation denied on %', TG_TABLE_NAME;
      END IF;
    END IF;

    IF ctx_tenant_id IS NOT NULL AND NEW.tenant_id <> ctx_tenant_id THEN
      RAISE EXCEPTION 'tenant_id context violation on %: row tenant_id(%) != app.tenant_id(%)', TG_TABLE_NAME, NEW.tenant_id, ctx_tenant_id;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

-- 6c: ensure_tenant_owner_membership_after_user_insert — use md5()::uuid
--     for deterministic bootstrap IDs instead of CONCAT().
CREATE OR REPLACE FUNCTION ensure_tenant_owner_membership_after_user_insert()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.tenant_id = md5(NEW.id::text)::uuid THEN
    INSERT INTO "tenant_members" ("id", "tenant_id", "user_id", "role", "created_at", "updated_at")
    VALUES (
      md5(NEW.tenant_id::text || ':' || NEW.id::text)::uuid,
      NEW.tenant_id,
      NEW.id,
      'OWNER'::"TenantRole",
      NOW(),
      NOW()
    )
    ON CONFLICT ("tenant_id", "user_id") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 7: Recreate all triggers
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _saved_triggers LOOP
    EXECUTE r.definition;
  END LOOP;
END $$;

DROP TABLE _saved_triggers;
