-- Phase 7: enforce tenant_id NOT NULL and broaden tenant RLS policies.

-- 0) Resolve orphan users (without tenant_members) into dedicated tenants,
--    then retry backfill for any remaining NULL tenant_id rows.
WITH orphan_users AS (
  SELECT u."id", u."email"
  FROM "users" u
  WHERE u."tenant_id" IS NULL
),
seed AS (
  SELECT
    ou."id" AS user_id,
    CONCAT('tenant_usr_', SUBSTRING(MD5(ou."id") FROM 1 FOR 20)) AS tenant_id,
    COALESCE(ou."email", CONCAT('user-', SUBSTRING(ou."id" FROM 1 FOR 8))) AS tenant_name
  FROM orphan_users ou
)
INSERT INTO "tenants" ("id", "name", "slug", "created_at", "updated_at")
SELECT
  s.tenant_id,
  s.tenant_name,
  CONCAT('u-', SUBSTRING(s.tenant_id FROM 1 FOR 24)),
  NOW(),
  NOW()
FROM seed s
ON CONFLICT ("id") DO NOTHING;

WITH seed AS (
  SELECT
    u."id" AS user_id,
    CONCAT('tenant_usr_', SUBSTRING(MD5(u."id") FROM 1 FOR 20)) AS tenant_id
  FROM "users" u
  WHERE u."tenant_id" IS NULL
)
UPDATE "users" u
SET "tenant_id" = s.tenant_id
FROM seed s
WHERE u."id" = s.user_id;

INSERT INTO "tenant_members" ("id", "tenant_id", "user_id", "role", "created_at", "updated_at")
SELECT
  CONCAT('tm_', SUBSTRING(MD5(s.tenant_id || ':' || s.user_id) FROM 1 FOR 24)),
  s.tenant_id,
  s.user_id,
  'OWNER'::"TenantRole",
  NOW(),
  NOW()
FROM (
  SELECT u."id" AS user_id, u."tenant_id" AS tenant_id
  FROM "users" u
  WHERE u."tenant_id" IS NOT NULL
) s
ON CONFLICT ("tenant_id", "user_id") DO NOTHING;

UPDATE "accounts" a
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE a."user_id" = u."id"
  AND a."tenant_id" IS NULL;

UPDATE "sessions" s
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE s."user_id" = u."id"
  AND s."tenant_id" IS NULL;

UPDATE "extension_tokens" et
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE et."user_id" = u."id"
  AND et."tenant_id" IS NULL;

UPDATE "tags" t
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE t."user_id" = u."id"
  AND t."tenant_id" IS NULL;

UPDATE "vault_keys" vk
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE vk."user_id" = u."id"
  AND vk."tenant_id" IS NULL;

UPDATE "password_entries" pe
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE pe."user_id" = u."id"
  AND pe."tenant_id" IS NULL;

UPDATE "folders" f
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE f."user_id" = u."id"
  AND f."tenant_id" IS NULL;

UPDATE "emergency_access_grants" eag
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE eag."owner_id" = u."id"
  AND eag."tenant_id" IS NULL;

UPDATE "password_entry_histories" peh
SET "tenant_id" = pe."tenant_id"
FROM "password_entries" pe
WHERE peh."entry_id" = pe."id"
  AND peh."tenant_id" IS NULL;

UPDATE "password_shares" ps
SET "tenant_id" = s."tenant_id"
FROM (
  SELECT
    ps2."id",
    COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id") AS "tenant_id"
  FROM "password_shares" ps2
  JOIN "users" u ON u."id" = ps2."created_by_id"
  LEFT JOIN "team_password_entries" tpe ON tpe."id" = ps2."team_password_entry_id"
  LEFT JOIN "password_entries" pe ON pe."id" = ps2."password_entry_id"
) s
WHERE ps."id" = s."id"
  AND ps."tenant_id" IS NULL;

UPDATE "share_access_logs" sal
SET "tenant_id" = ps."tenant_id"
FROM "password_shares" ps
WHERE sal."share_id" = ps."id"
  AND sal."tenant_id" IS NULL;

UPDATE "audit_logs" al
SET "tenant_id" = s."tenant_id"
FROM (
  SELECT
    al2."id",
    COALESCE(t."tenant_id", u."tenant_id") AS "tenant_id"
  FROM "audit_logs" al2
  JOIN "users" u ON u."id" = al2."user_id"
  LEFT JOIN "teams" t ON t."id" = al2."team_id"
) s
WHERE al."id" = s."id"
  AND al."tenant_id" IS NULL;

UPDATE "attachments" a
SET "tenant_id" = s."tenant_id"
FROM (
  SELECT
    a2."id",
    COALESCE(tpe."tenant_id", pe."tenant_id", u."tenant_id") AS "tenant_id"
  FROM "attachments" a2
  JOIN "users" u ON u."id" = a2."created_by_id"
  LEFT JOIN "team_password_entries" tpe ON tpe."id" = a2."team_password_entry_id"
  LEFT JOIN "password_entries" pe ON pe."id" = a2."password_entry_id"
) s
WHERE a."id" = s."id"
  AND a."tenant_id" IS NULL;

UPDATE "emergency_access_key_pairs" eakp
SET "tenant_id" = eag."tenant_id"
FROM "emergency_access_grants" eag
WHERE eakp."grant_id" = eag."id"
  AND eakp."tenant_id" IS NULL;

-- 1) Fail fast if any tenant_id remains NULL on tenant-scoped tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: users.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: accounts.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "sessions" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: sessions.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "extension_tokens" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: extension_tokens.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "tags" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: tags.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "vault_keys" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: vault_keys.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "password_entries" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: password_entries.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_members" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_members.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_member_keys" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_member_keys.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_password_entries" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_password_entries.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_tags" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_tags.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_password_favorites" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_password_favorites.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_invitations" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_invitations.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "password_shares" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: password_shares.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "share_access_logs" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: share_access_logs.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "audit_logs" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: audit_logs.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "attachments" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: attachments.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "emergency_access_grants" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: emergency_access_grants.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "folders" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: folders.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_folders" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_folders.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "password_entry_histories" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: password_entry_histories.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "team_password_entry_histories" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: team_password_entry_histories.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "emergency_access_key_pairs" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase7 precondition failed: emergency_access_key_pairs.tenant_id contains NULL';
  END IF;
END $$;

-- 2) Enforce NOT NULL tenant_id.
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "extension_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "tags" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "vault_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "password_entries" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_members" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_member_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_password_entries" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_tags" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_password_favorites" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_invitations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "password_shares" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "share_access_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "emergency_access_grants" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "folders" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_folders" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "password_entry_histories" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "team_password_entry_histories" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "emergency_access_key_pairs" ALTER COLUMN "tenant_id" SET NOT NULL;

-- 3) Tighten tenant foreign keys to RESTRICT.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_tenant_id_fkey";
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_tenant_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_tenant_id_fkey";
ALTER TABLE "extension_tokens" DROP CONSTRAINT IF EXISTS "extension_tokens_tenant_id_fkey";
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_tenant_id_fkey";
ALTER TABLE "vault_keys" DROP CONSTRAINT IF EXISTS "vault_keys_tenant_id_fkey";
ALTER TABLE "password_entries" DROP CONSTRAINT IF EXISTS "password_entries_tenant_id_fkey";
ALTER TABLE "team_members" DROP CONSTRAINT IF EXISTS "team_members_tenant_id_fkey";
ALTER TABLE "team_member_keys" DROP CONSTRAINT IF EXISTS "team_member_keys_tenant_id_fkey";
ALTER TABLE "team_password_entries" DROP CONSTRAINT IF EXISTS "team_password_entries_tenant_id_fkey";
ALTER TABLE "team_tags" DROP CONSTRAINT IF EXISTS "team_tags_tenant_id_fkey";
ALTER TABLE "team_password_favorites" DROP CONSTRAINT IF EXISTS "team_password_favorites_tenant_id_fkey";
ALTER TABLE "team_invitations" DROP CONSTRAINT IF EXISTS "team_invitations_tenant_id_fkey";
ALTER TABLE "password_shares" DROP CONSTRAINT IF EXISTS "password_shares_tenant_id_fkey";
ALTER TABLE "share_access_logs" DROP CONSTRAINT IF EXISTS "share_access_logs_tenant_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_tenant_id_fkey";
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_tenant_id_fkey";
ALTER TABLE "emergency_access_grants" DROP CONSTRAINT IF EXISTS "emergency_access_grants_tenant_id_fkey";
ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_tenant_id_fkey";
ALTER TABLE "team_folders" DROP CONSTRAINT IF EXISTS "team_folders_tenant_id_fkey";
ALTER TABLE "password_entry_histories" DROP CONSTRAINT IF EXISTS "password_entry_histories_tenant_id_fkey";
ALTER TABLE "team_password_entry_histories" DROP CONSTRAINT IF EXISTS "team_password_entry_histories_tenant_id_fkey";
ALTER TABLE "emergency_access_key_pairs" DROP CONSTRAINT IF EXISTS "emergency_access_key_pairs_tenant_id_fkey";

ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_tokens" ADD CONSTRAINT "extension_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "password_entries" ADD CONSTRAINT "password_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_member_keys" ADD CONSTRAINT "team_member_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_password_entries" ADD CONSTRAINT "team_password_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_password_favorites" ADD CONSTRAINT "team_password_favorites_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "password_shares" ADD CONSTRAINT "password_shares_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "share_access_logs" ADD CONSTRAINT "share_access_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emergency_access_grants" ADD CONSTRAINT "emergency_access_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "folders" ADD CONSTRAINT "folders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_folders" ADD CONSTRAINT "team_folders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "password_entry_histories" ADD CONSTRAINT "password_entry_histories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_password_entry_histories" ADD CONSTRAINT "team_password_entry_histories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emergency_access_key_pairs" ADD CONSTRAINT "emergency_access_key_pairs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4) Enable and enforce tenant RLS on tables that carry tenant_id.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extension_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vault_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_member_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_password_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_password_favorites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "share_access_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emergency_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_entry_histories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_password_entry_histories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emergency_access_key_pairs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_tenant_isolation ON "users";
CREATE POLICY users_tenant_isolation ON "users"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS accounts_tenant_isolation ON "accounts";
CREATE POLICY accounts_tenant_isolation ON "accounts"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS sessions_tenant_isolation ON "sessions";
CREATE POLICY sessions_tenant_isolation ON "sessions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS extension_tokens_tenant_isolation ON "extension_tokens";
CREATE POLICY extension_tokens_tenant_isolation ON "extension_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS tags_tenant_isolation ON "tags";
CREATE POLICY tags_tenant_isolation ON "tags"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS vault_keys_tenant_isolation ON "vault_keys";
CREATE POLICY vault_keys_tenant_isolation ON "vault_keys"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS password_entries_tenant_isolation ON "password_entries";
CREATE POLICY password_entries_tenant_isolation ON "password_entries"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_members_tenant_isolation ON "team_members";
CREATE POLICY team_members_tenant_isolation ON "team_members"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_member_keys_tenant_isolation ON "team_member_keys";
CREATE POLICY team_member_keys_tenant_isolation ON "team_member_keys"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_password_entries_tenant_isolation ON "team_password_entries";
CREATE POLICY team_password_entries_tenant_isolation ON "team_password_entries"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_tags_tenant_isolation ON "team_tags";
CREATE POLICY team_tags_tenant_isolation ON "team_tags"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_password_favorites_tenant_isolation ON "team_password_favorites";
CREATE POLICY team_password_favorites_tenant_isolation ON "team_password_favorites"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_invitations_tenant_isolation ON "team_invitations";
CREATE POLICY team_invitations_tenant_isolation ON "team_invitations"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS password_shares_tenant_isolation ON "password_shares";
CREATE POLICY password_shares_tenant_isolation ON "password_shares"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS share_access_logs_tenant_isolation ON "share_access_logs";
CREATE POLICY share_access_logs_tenant_isolation ON "share_access_logs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON "audit_logs";
CREATE POLICY audit_logs_tenant_isolation ON "audit_logs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS attachments_tenant_isolation ON "attachments";
CREATE POLICY attachments_tenant_isolation ON "attachments"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS emergency_access_grants_tenant_isolation ON "emergency_access_grants";
CREATE POLICY emergency_access_grants_tenant_isolation ON "emergency_access_grants"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS folders_tenant_isolation ON "folders";
CREATE POLICY folders_tenant_isolation ON "folders"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_folders_tenant_isolation ON "team_folders";
CREATE POLICY team_folders_tenant_isolation ON "team_folders"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS password_entry_histories_tenant_isolation ON "password_entry_histories";
CREATE POLICY password_entry_histories_tenant_isolation ON "password_entry_histories"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS team_password_entry_histories_tenant_isolation ON "team_password_entry_histories";
CREATE POLICY team_password_entry_histories_tenant_isolation ON "team_password_entry_histories"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

DROP POLICY IF EXISTS emergency_access_key_pairs_tenant_isolation ON "emergency_access_key_pairs";
CREATE POLICY emergency_access_key_pairs_tenant_isolation ON "emergency_access_key_pairs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
