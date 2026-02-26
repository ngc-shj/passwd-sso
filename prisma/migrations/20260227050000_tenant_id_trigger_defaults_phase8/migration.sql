-- Phase 8: tenant_id trigger enforcement.
--
-- Purpose:
-- - Auto-fill NEW.tenant_id from `SET LOCAL app.tenant_id` when omitted.
-- - Reject tenant_id mismatch against current tenant context.
-- - Allow trusted maintenance flows only when `app.bypass_rls = 'on'`.

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

  -- team-scoped tables
  IF p_table IN (
    'team_members', 'team_member_keys', 'team_password_entries', 'team_tags',
    'team_invitations', 'team_folders', 'scim_tokens', 'scim_external_mappings'
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

CREATE OR REPLACE FUNCTION enforce_tenant_id_from_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bypass_enabled boolean := COALESCE(current_setting('app.bypass_rls', true), '') = 'on';
  ctx_tenant_id text := NULLIF(current_setting('app.tenant_id', true), '');
  derived_tenant_id text;
BEGIN
  -- Trusted internal jobs can bypass this guard.
  IF bypass_enabled THEN
    RETURN NEW;
  END IF;

  -- INSERT: auto-fill tenant_id from context if omitted.
  IF TG_OP = 'INSERT' THEN
    IF NEW.tenant_id IS NULL THEN
      IF ctx_tenant_id IS NOT NULL THEN
        NEW.tenant_id := ctx_tenant_id;
      ELSE
        -- Special case: users can be created before tenant context is set.
        -- Assign a deterministic dedicated tenant and owner-membership.
        IF TG_TABLE_NAME = 'users' THEN
          NEW.tenant_id := CONCAT('tenant_usr_', SUBSTRING(MD5(NEW.id) FROM 1 FOR 20));

          INSERT INTO "tenants" ("id", "name", "slug", "created_at", "updated_at")
          VALUES (
            NEW.tenant_id,
            COALESCE(NEW.email, CONCAT('user-', SUBSTRING(NEW.id FROM 1 FOR 8))),
            CONCAT('u-', SUBSTRING(NEW.tenant_id FROM 1 FOR 24)),
            NOW(),
            NOW()
          )
          ON CONFLICT ("id") DO NOTHING;

          INSERT INTO "tenant_members" ("id", "tenant_id", "user_id", "role", "created_at", "updated_at")
          VALUES (
            CONCAT('tm_', SUBSTRING(MD5(NEW.tenant_id || ':' || NEW.id) FROM 1 FOR 24)),
            NEW.tenant_id,
            NEW.id,
            'OWNER'::"TenantRole",
            NOW(),
            NOW()
          )
          ON CONFLICT ("tenant_id", "user_id") DO NOTHING;
        ELSE
          derived_tenant_id := resolve_tenant_id_from_row(TG_TABLE_NAME, to_jsonb(NEW));
          IF derived_tenant_id IS NULL THEN
            RAISE EXCEPTION 'tenant_id missing and app.tenant_id is not set for %', TG_TABLE_NAME;
          END IF;
          NEW.tenant_id := derived_tenant_id;
        END IF;
      END IF;
    ELSIF ctx_tenant_id IS NOT NULL AND NEW.tenant_id <> ctx_tenant_id THEN
      RAISE EXCEPTION 'tenant_id mismatch on %: row tenant_id(%) != app.tenant_id(%)', TG_TABLE_NAME, NEW.tenant_id, ctx_tenant_id;
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: tenant_id mutation is forbidden unless it stays in current context.
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
$$;

-- Attach to all tenant-scoped tables.
DROP TRIGGER IF EXISTS trg_enforce_tenant_id_users ON "users";
CREATE TRIGGER trg_enforce_tenant_id_users
BEFORE INSERT OR UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_accounts ON "accounts";
CREATE TRIGGER trg_enforce_tenant_id_accounts
BEFORE INSERT OR UPDATE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_sessions ON "sessions";
CREATE TRIGGER trg_enforce_tenant_id_sessions
BEFORE INSERT OR UPDATE ON "sessions"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_extension_tokens ON "extension_tokens";
CREATE TRIGGER trg_enforce_tenant_id_extension_tokens
BEFORE INSERT OR UPDATE ON "extension_tokens"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_tags ON "tags";
CREATE TRIGGER trg_enforce_tenant_id_tags
BEFORE INSERT OR UPDATE ON "tags"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_vault_keys ON "vault_keys";
CREATE TRIGGER trg_enforce_tenant_id_vault_keys
BEFORE INSERT OR UPDATE ON "vault_keys"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_password_entries ON "password_entries";
CREATE TRIGGER trg_enforce_tenant_id_password_entries
BEFORE INSERT OR UPDATE ON "password_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_teams ON "teams";
CREATE TRIGGER trg_enforce_tenant_id_teams
BEFORE INSERT OR UPDATE ON "teams"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_tenant_members ON "tenant_members";
CREATE TRIGGER trg_enforce_tenant_id_tenant_members
BEFORE INSERT OR UPDATE ON "tenant_members"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_members ON "team_members";
CREATE TRIGGER trg_enforce_tenant_id_team_members
BEFORE INSERT OR UPDATE ON "team_members"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_member_keys ON "team_member_keys";
CREATE TRIGGER trg_enforce_tenant_id_team_member_keys
BEFORE INSERT OR UPDATE ON "team_member_keys"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_password_entries ON "team_password_entries";
CREATE TRIGGER trg_enforce_tenant_id_team_password_entries
BEFORE INSERT OR UPDATE ON "team_password_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_tags ON "team_tags";
CREATE TRIGGER trg_enforce_tenant_id_team_tags
BEFORE INSERT OR UPDATE ON "team_tags"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_password_favorites ON "team_password_favorites";
CREATE TRIGGER trg_enforce_tenant_id_team_password_favorites
BEFORE INSERT OR UPDATE ON "team_password_favorites"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_invitations ON "team_invitations";
CREATE TRIGGER trg_enforce_tenant_id_team_invitations
BEFORE INSERT OR UPDATE ON "team_invitations"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_password_shares ON "password_shares";
CREATE TRIGGER trg_enforce_tenant_id_password_shares
BEFORE INSERT OR UPDATE ON "password_shares"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_share_access_logs ON "share_access_logs";
CREATE TRIGGER trg_enforce_tenant_id_share_access_logs
BEFORE INSERT OR UPDATE ON "share_access_logs"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_audit_logs ON "audit_logs";
CREATE TRIGGER trg_enforce_tenant_id_audit_logs
BEFORE INSERT OR UPDATE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_attachments ON "attachments";
CREATE TRIGGER trg_enforce_tenant_id_attachments
BEFORE INSERT OR UPDATE ON "attachments"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_emergency_access_grants ON "emergency_access_grants";
CREATE TRIGGER trg_enforce_tenant_id_emergency_access_grants
BEFORE INSERT OR UPDATE ON "emergency_access_grants"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_folders ON "folders";
CREATE TRIGGER trg_enforce_tenant_id_folders
BEFORE INSERT OR UPDATE ON "folders"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_folders ON "team_folders";
CREATE TRIGGER trg_enforce_tenant_id_team_folders
BEFORE INSERT OR UPDATE ON "team_folders"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_password_entry_histories ON "password_entry_histories";
CREATE TRIGGER trg_enforce_tenant_id_password_entry_histories
BEFORE INSERT OR UPDATE ON "password_entry_histories"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_team_password_entry_histories ON "team_password_entry_histories";
CREATE TRIGGER trg_enforce_tenant_id_team_password_entry_histories
BEFORE INSERT OR UPDATE ON "team_password_entry_histories"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_emergency_access_key_pairs ON "emergency_access_key_pairs";
CREATE TRIGGER trg_enforce_tenant_id_emergency_access_key_pairs
BEFORE INSERT OR UPDATE ON "emergency_access_key_pairs"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_scim_tokens ON "scim_tokens";
CREATE TRIGGER trg_enforce_tenant_id_scim_tokens
BEFORE INSERT OR UPDATE ON "scim_tokens"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();

DROP TRIGGER IF EXISTS trg_enforce_tenant_id_scim_external_mappings ON "scim_external_mappings";
CREATE TRIGGER trg_enforce_tenant_id_scim_external_mappings
BEFORE INSERT OR UPDATE ON "scim_external_mappings"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();
