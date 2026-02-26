-- Tenant/Team migration Phase 1 (additive only)
-- Safe to run before application cutover.

BEGIN;

-- 1) tenant role enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantRole') THEN
    CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
  END IF;
END
$$;

-- 2) tenants table
CREATE TABLE IF NOT EXISTS "tenants" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3) tenant_members table
CREATE TABLE IF NOT EXISTS "tenant_members" (
  "id"         TEXT PRIMARY KEY,
  "tenant_id"  TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "role"       "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_members_tenant_id_fkey') THEN
    ALTER TABLE "tenant_members"
      ADD CONSTRAINT "tenant_members_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_members_user_id_fkey') THEN
    ALTER TABLE "tenant_members"
      ADD CONSTRAINT "tenant_members_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_members_tenant_id_user_id_key"
  ON "tenant_members"("tenant_id", "user_id");

CREATE INDEX IF NOT EXISTS "tenant_members_user_id_idx"
  ON "tenant_members"("user_id");

-- 4) additive tenant_id columns
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;

ALTER TABLE "scim_tokens"
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;

ALTER TABLE "scim_external_mappings"
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;

-- 5) foreign keys (set null for additive compatibility)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_tenant_id_fkey') THEN
    ALTER TABLE "organizations"
      ADD CONSTRAINT "organizations_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_tokens_tenant_id_fkey') THEN
    ALTER TABLE "scim_tokens"
      ADD CONSTRAINT "scim_tokens_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_external_mappings_tenant_id_fkey') THEN
    ALTER TABLE "scim_external_mappings"
      ADD CONSTRAINT "scim_external_mappings_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- 6) indexes
CREATE INDEX IF NOT EXISTS "organizations_tenant_id_idx"
  ON "organizations"("tenant_id");

CREATE INDEX IF NOT EXISTS "scim_tokens_tenant_id_revoked_at_idx"
  ON "scim_tokens"("tenant_id", "revoked_at");

CREATE INDEX IF NOT EXISTS "scim_external_mappings_tenant_id_resource_type_idx"
  ON "scim_external_mappings"("tenant_id", "resource_type");

COMMIT;

-- Backfill is intentionally NOT included in this phase.
-- Run backfill in Phase 2 after application logic is prepared.
