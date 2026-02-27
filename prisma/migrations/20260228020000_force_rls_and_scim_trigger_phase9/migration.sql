-- Phase 9: FORCE RLS on all tenant-scoped tables + scim_group_mappings trigger fix.
--
-- F-1/S-1: FORCE ROW LEVEL SECURITY ensures RLS applies even to the table owner
--          (passwd_user), closing the bypass gap when Prisma connects as owner.
-- S-5:     Add scim_group_mappings to resolve_tenant_id_from_row so the
--          enforce_tenant_id trigger can auto-fill tenant_id from team_id.

-- ============================================================================
-- Guard: verify current_user owns the tables (FORCE RLS requires ownership)
-- ============================================================================
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT tableowner INTO v_owner
  FROM pg_tables WHERE tablename = 'users' AND schemaname = 'public';
  IF v_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION
      'FORCE RLS requires table owner = current_user. Owner="%", current_user="%"',
      v_owner, current_user;
  END IF;
END $$;

-- ============================================================================
-- FORCE ROW LEVEL SECURITY — Phase 5 tables
-- ============================================================================
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scim_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scim_external_mappings" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- FORCE ROW LEVEL SECURITY — Phase 7 tables
-- ============================================================================
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "extension_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vault_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "password_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_member_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_password_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_tags" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_password_favorites" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_invitations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "password_shares" FORCE ROW LEVEL SECURITY;
ALTER TABLE "share_access_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emergency_access_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "folders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_folders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "password_entry_histories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_password_entry_histories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emergency_access_key_pairs" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- FORCE ROW LEVEL SECURITY — SCIM group mappings
-- ============================================================================
ALTER TABLE "scim_group_mappings" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- S-5: Update resolve_tenant_id_from_row to include scim_group_mappings
-- ============================================================================
CREATE OR REPLACE FUNCTION resolve_tenant_id_from_row(
  p_table text,
  p_row jsonb
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id text;
BEGIN
  -- user-scoped tables
  IF p_table IN ('accounts', 'sessions', 'extension_tokens', 'tags', 'vault_keys', 'password_entries', 'folders') THEN
    SELECT u."tenant_id" INTO v_tenant_id
    FROM "users" u
    WHERE u."id" = (p_row->>'user_id');
    RETURN v_tenant_id;
  END IF;

  -- owner-based table
  IF p_table = 'emergency_access_grants' THEN
    SELECT u."tenant_id" INTO v_tenant_id
    FROM "users" u
    WHERE u."id" = (p_row->>'owner_id');
    RETURN v_tenant_id;
  END IF;

  -- team-scoped tables (S-5: added scim_group_mappings)
  IF p_table IN (
    'team_members', 'team_member_keys', 'team_password_entries', 'team_tags',
    'team_invitations', 'team_folders', 'scim_tokens', 'scim_external_mappings',
    'scim_group_mappings'
  ) THEN
    SELECT t."tenant_id" INTO v_tenant_id
    FROM "teams" t
    WHERE t."id" = (p_row->>'team_id');
    RETURN v_tenant_id;
  END IF;

  IF p_table = 'team_password_favorites' THEN
    SELECT tpe."tenant_id" INTO v_tenant_id
    FROM "team_password_entries" tpe
    WHERE tpe."id" = (p_row->>'team_password_entry_id');
    RETURN v_tenant_id;
  END IF;

  -- share/access/audit/attachment chain
  IF p_table = 'password_shares' THEN
    SELECT COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id") INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "team_password_entries" tpe ON tpe."id" = (p_row->>'team_password_entry_id')
    LEFT JOIN "password_entries" pe ON pe."id" = (p_row->>'password_entry_id')
    WHERE u."id" = (p_row->>'created_by_id');
    RETURN v_tenant_id;
  END IF;

  IF p_table = 'share_access_logs' THEN
    SELECT ps."tenant_id" INTO v_tenant_id
    FROM "password_shares" ps
    WHERE ps."id" = (p_row->>'share_id');
    RETURN v_tenant_id;
  END IF;

  IF p_table = 'audit_logs' THEN
    SELECT COALESCE(t."tenant_id", u."tenant_id") INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "teams" t ON t."id" = (p_row->>'team_id')
    WHERE u."id" = (p_row->>'user_id');
    RETURN v_tenant_id;
  END IF;

  IF p_table = 'attachments' THEN
    SELECT COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id") INTO v_tenant_id
    FROM "users" u
    LEFT JOIN "team_password_entries" tpe ON tpe."id" = (p_row->>'team_password_entry_id')
    LEFT JOIN "password_entries" pe ON pe."id" = (p_row->>'password_entry_id')
    WHERE u."id" = (p_row->>'created_by_id');
    RETURN v_tenant_id;
  END IF;

  -- history tables
  IF p_table = 'password_entry_histories' THEN
    SELECT pe."tenant_id" INTO v_tenant_id
    FROM "password_entries" pe
    WHERE pe."id" = (p_row->>'entry_id');
    RETURN v_tenant_id;
  END IF;

  IF p_table = 'team_password_entry_histories' THEN
    SELECT tpe."tenant_id" INTO v_tenant_id
    FROM "team_password_entries" tpe
    WHERE tpe."id" = (p_row->>'entry_id');
    RETURN v_tenant_id;
  END IF;

  -- emergency key pair
  IF p_table = 'emergency_access_key_pairs' THEN
    SELECT eag."tenant_id" INTO v_tenant_id
    FROM "emergency_access_grants" eag
    WHERE eag."id" = (p_row->>'grant_id');
    RETURN v_tenant_id;
  END IF;

  -- tenant_members fallback from user
  IF p_table = 'tenant_members' THEN
    SELECT u."tenant_id" INTO v_tenant_id
    FROM "users" u
    WHERE u."id" = (p_row->>'user_id');
    RETURN v_tenant_id;
  END IF;

  RETURN NULL;
END;
$$;
