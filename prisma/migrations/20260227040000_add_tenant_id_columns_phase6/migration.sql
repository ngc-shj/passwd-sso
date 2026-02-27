-- Phase 6: add tenant_id provenance columns across domain/auth tables.
-- This phase focuses on schema+backfill. RLS rollout can be tightened after app paths
-- consistently set tenant context for every query family.

-- 1) Add tenant_id columns (nullable for safe rollout).
ALTER TABLE "users" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "accounts" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sessions" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "extension_tokens" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "tags" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "vault_keys" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "password_entries" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_members" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_member_keys" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_password_entries" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_tags" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_password_favorites" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_invitations" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "password_shares" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "share_access_logs" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "attachments" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "emergency_access_grants" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "folders" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_folders" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "password_entry_histories" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "team_password_entry_histories" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "emergency_access_key_pairs" ADD COLUMN "tenant_id" TEXT;

-- 2) Backfill users from tenant_members.
UPDATE "users" u
SET "tenant_id" = s."tenant_id"
FROM (
  SELECT "user_id", MIN("tenant_id") AS "tenant_id"
  FROM "tenant_members"
  GROUP BY "user_id"
) s
WHERE u."id" = s."user_id"
  AND u."tenant_id" IS NULL;

-- 3) Backfill user-scoped tables from users.
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

-- 4) Backfill team-scoped tables from teams.
UPDATE "team_members" tm
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE tm."team_id" = t."id"
  AND tm."tenant_id" IS NULL;

UPDATE "team_member_keys" tmk
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE tmk."team_id" = t."id"
  AND tmk."tenant_id" IS NULL;

UPDATE "team_password_entries" tpe
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE tpe."team_id" = t."id"
  AND tpe."tenant_id" IS NULL;

UPDATE "team_tags" tt
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE tt."team_id" = t."id"
  AND tt."tenant_id" IS NULL;

UPDATE "team_invitations" ti
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE ti."team_id" = t."id"
  AND ti."tenant_id" IS NULL;

UPDATE "team_folders" tf
SET "tenant_id" = t."tenant_id"
FROM "teams" t
WHERE tf."team_id" = t."id"
  AND tf."tenant_id" IS NULL;

-- 5) Backfill dependent tables from parent records.
UPDATE "team_password_favorites" tpf
SET "tenant_id" = tpe."tenant_id"
FROM "team_password_entries" tpe
WHERE tpf."team_password_entry_id" = tpe."id"
  AND tpf."tenant_id" IS NULL;

UPDATE "password_entry_histories" peh
SET "tenant_id" = pe."tenant_id"
FROM "password_entries" pe
WHERE peh."entry_id" = pe."id"
  AND peh."tenant_id" IS NULL;

UPDATE "team_password_entry_histories" tpeh
SET "tenant_id" = tpe."tenant_id"
FROM "team_password_entries" tpe
WHERE tpeh."entry_id" = tpe."id"
  AND tpeh."tenant_id" IS NULL;

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

-- 6) Add foreign keys to tenants.
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extension_tokens" ADD CONSTRAINT "extension_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_entries" ADD CONSTRAINT "password_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_member_keys" ADD CONSTRAINT "team_member_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_password_entries" ADD CONSTRAINT "team_password_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_password_favorites" ADD CONSTRAINT "team_password_favorites_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_shares" ADD CONSTRAINT "password_shares_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "share_access_logs" ADD CONSTRAINT "share_access_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emergency_access_grants" ADD CONSTRAINT "emergency_access_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "folders" ADD CONSTRAINT "folders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_folders" ADD CONSTRAINT "team_folders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_entry_histories" ADD CONSTRAINT "password_entry_histories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_password_entry_histories" ADD CONSTRAINT "team_password_entry_histories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emergency_access_key_pairs" ADD CONSTRAINT "emergency_access_key_pairs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7) Tenant-oriented indexes.
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");
CREATE INDEX "accounts_tenant_id_idx" ON "accounts"("tenant_id");
CREATE INDEX "sessions_tenant_id_idx" ON "sessions"("tenant_id");
CREATE INDEX "extension_tokens_tenant_id_idx" ON "extension_tokens"("tenant_id");
CREATE INDEX "tags_tenant_id_idx" ON "tags"("tenant_id");
CREATE INDEX "vault_keys_tenant_id_idx" ON "vault_keys"("tenant_id");
CREATE INDEX "password_entries_tenant_id_idx" ON "password_entries"("tenant_id");
CREATE INDEX "team_members_tenant_id_idx" ON "team_members"("tenant_id");
CREATE INDEX "team_member_keys_tenant_id_idx" ON "team_member_keys"("tenant_id");
CREATE INDEX "team_password_entries_tenant_id_idx" ON "team_password_entries"("tenant_id");
CREATE INDEX "team_tags_tenant_id_idx" ON "team_tags"("tenant_id");
CREATE INDEX "team_password_favorites_tenant_id_idx" ON "team_password_favorites"("tenant_id");
CREATE INDEX "team_invitations_tenant_id_idx" ON "team_invitations"("tenant_id");
CREATE INDEX "password_shares_tenant_id_idx" ON "password_shares"("tenant_id");
CREATE INDEX "share_access_logs_tenant_id_idx" ON "share_access_logs"("tenant_id");
CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs"("tenant_id");
CREATE INDEX "attachments_tenant_id_idx" ON "attachments"("tenant_id");
CREATE INDEX "emergency_access_grants_tenant_id_idx" ON "emergency_access_grants"("tenant_id");
CREATE INDEX "folders_tenant_id_idx" ON "folders"("tenant_id");
CREATE INDEX "team_folders_tenant_id_idx" ON "team_folders"("tenant_id");
CREATE INDEX "password_entry_histories_tenant_id_idx" ON "password_entry_histories"("tenant_id");
CREATE INDEX "team_password_entry_histories_tenant_id_idx" ON "team_password_entry_histories"("tenant_id");
CREATE INDEX "emergency_access_key_pairs_tenant_id_idx" ON "emergency_access_key_pairs"("tenant_id");

-- 8) Visibility query for remaining NULLs (manual post-check).
-- SELECT
--   (SELECT COUNT(*) FROM "users" WHERE "tenant_id" IS NULL) AS users_null,
--   (SELECT COUNT(*) FROM "accounts" WHERE "tenant_id" IS NULL) AS accounts_null,
--   (SELECT COUNT(*) FROM "sessions" WHERE "tenant_id" IS NULL) AS sessions_null,
--   (SELECT COUNT(*) FROM "password_entries" WHERE "tenant_id" IS NULL) AS password_entries_null,
--   (SELECT COUNT(*) FROM "team_password_entries" WHERE "tenant_id" IS NULL) AS team_password_entries_null;
