-- Convert all TIMESTAMP(3) WITHOUT TIME ZONE columns to TIMESTAMPTZ(3).
--
-- PostgreSQL recommends TIMESTAMPTZ over TIMESTAMP:
--   "We do not recommend using the type timestamp without time zone"
--   — https://www.postgresql.org/docs/current/datatype-datetime.html
--
-- The USING clause interprets existing values as UTC (matching the Docker
-- PostgreSQL server timezone). No data is lost or shifted.
--
-- This eliminates timezone-dependent behavior in the pg driver, which
-- interprets TIMESTAMP WITHOUT TZ values as the client's local timezone
-- when constructing JavaScript Date objects.

-- Guard: abort if DB timezone is not UTC — existing TIMESTAMP values were
-- stored as UTC and the USING clause assumes this.
DO $$
BEGIN
  IF current_setting('TimeZone') <> 'UTC' THEN
    RAISE EXCEPTION 'Migration requires database timezone=UTC, got: %. Set timezone=UTC before running.', current_setting('TimeZone');
  END IF;
END$$;

ALTER TABLE "access_requests" ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMPTZ(3) USING "approved_at" AT TIME ZONE 'UTC';
ALTER TABLE "access_requests" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "access_requests" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_vault_resets" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_vault_resets" ALTER COLUMN "executed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "executed_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_vault_resets" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_vault_resets" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "api_keys" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "api_keys" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';
ALTER TABLE "api_keys" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "attachments" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_deliveries" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_deliveries" ALTER COLUMN "next_retry_at" SET DATA TYPE TIMESTAMPTZ(3) USING "next_retry_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_deliveries" ALTER COLUMN "processing_started_at" SET DATA TYPE TIMESTAMPTZ(3) USING "processing_started_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_delivery_targets" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_delivery_targets" ALTER COLUMN "last_delivered_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_delivered_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_outbox" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_outbox" ALTER COLUMN "next_retry_at" SET DATA TYPE TIMESTAMPTZ(3) USING "next_retry_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_outbox" ALTER COLUMN "processing_started_at" SET DATA TYPE TIMESTAMPTZ(3) USING "processing_started_at" AT TIME ZONE 'UTC';
ALTER TABLE "audit_outbox" ALTER COLUMN "sent_at" SET DATA TYPE TIMESTAMPTZ(3) USING "sent_at" AT TIME ZONE 'UTC';
ALTER TABLE "delegation_sessions" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "delegation_sessions" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "delegation_sessions" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_configs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_configs" ALTER COLUMN "last_sync_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_sync_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_configs" ALTER COLUMN "next_sync_at" SET DATA TYPE TIMESTAMPTZ(3) USING "next_sync_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_configs" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_logs" ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "completed_at" AT TIME ZONE 'UTC';
ALTER TABLE "directory_sync_logs" ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMPTZ(3) USING "started_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "activated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "activated_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "requested_at" SET DATA TYPE TIMESTAMPTZ(3) USING "requested_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "token_expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "token_expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_grants" ALTER COLUMN "wait_expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "wait_expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "emergency_access_key_pairs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_bridge_codes" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_bridge_codes" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_bridge_codes" ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "used_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_tokens" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';
ALTER TABLE "extension_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "folders" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "folders" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_access_tokens" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_access_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_access_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_access_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_authorization_codes" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_authorization_codes" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_authorization_codes" ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "used_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_clients" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_clients" ALTER COLUMN "dcr_expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "dcr_expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_clients" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_refresh_tokens" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_refresh_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_refresh_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "mcp_refresh_tokens" ALTER COLUMN "rotated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "rotated_at" AT TIME ZONE 'UTC';
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_entries" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_entries" ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3) USING "deleted_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_entries" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_entries" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_entry_histories" ALTER COLUMN "changed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "changed_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_shares" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_shares" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_shares" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "personal_log_access_grants" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "personal_log_access_grants" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "personal_log_access_grants" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_external_mappings" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_external_mappings" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_group_mappings" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_group_mappings" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_tokens" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';
ALTER TABLE "scim_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_account_tokens" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_account_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_account_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_account_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3) USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_accounts" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "service_accounts" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3) USING "expires" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "last_active_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_active_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_access_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tags" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tags" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_folders" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_folders" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_invitations" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_invitations" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_invitations" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_member_keys" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_member_keys" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_members" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_members" ALTER COLUMN "deactivated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "deactivated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_members" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_entries" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_entries" ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3) USING "deleted_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_entries" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_entries" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_entry_histories" ALTER COLUMN "changed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "changed_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_password_favorites" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_policies" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_policies" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_tags" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_tags" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_webhooks" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_webhooks" ALTER COLUMN "last_delivered_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_delivered_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_webhooks" ALTER COLUMN "last_failed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_failed_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_webhooks" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "teams" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "teams" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_members" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_members" ALTER COLUMN "deactivated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "deactivated_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_members" ALTER COLUMN "last_scim_synced_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_scim_synced_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_members" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_webhooks" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_webhooks" ALTER COLUMN "last_delivered_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_delivered_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_webhooks" ALTER COLUMN "last_failed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_failed_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenant_webhooks" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenants" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenants" ALTER COLUMN "require_passkey_enabled_at" SET DATA TYPE TIMESTAMPTZ(3) USING "require_passkey_enabled_at" AT TIME ZONE 'UTC';
ALTER TABLE "tenants" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "account_locked_until" SET DATA TYPE TIMESTAMPTZ(3) USING "account_locked_until" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "email_verified" SET DATA TYPE TIMESTAMPTZ(3) USING "email_verified" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "last_failed_unlock_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_failed_unlock_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "recovery_key_set_at" SET DATA TYPE TIMESTAMPTZ(3) USING "recovery_key_set_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "travel_mode_activated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "travel_mode_activated_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "vault_setup_at" SET DATA TYPE TIMESTAMPTZ(3) USING "vault_setup_at" AT TIME ZONE 'UTC';
ALTER TABLE "vault_keys" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "verification_tokens" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3) USING "expires" AT TIME ZONE 'UTC';
ALTER TABLE "webauthn_credentials" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "webauthn_credentials" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_used_at" AT TIME ZONE 'UTC';

