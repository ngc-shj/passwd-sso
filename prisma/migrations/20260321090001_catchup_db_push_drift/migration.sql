-- Catch-up migration: captures changes previously applied via `prisma db push`
-- that were not recorded in migration files.

-- 1. Add missing AuditAction enum variants
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TENANT_WEBHOOK_CREATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TENANT_WEBHOOK_DELETE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TENANT_WEBHOOK_DELIVERY_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VAULT_KEY_ROTATION';

-- 2. Create tenant_webhooks table
CREATE TABLE IF NOT EXISTS "tenant_webhooks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "secret_iv" VARCHAR(24) NOT NULL,
    "secret_auth_tag" VARCHAR(32) NOT NULL,
    "master_key_version" INTEGER NOT NULL DEFAULT 1,
    "events" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_error" TEXT,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_delivered_at" TIMESTAMP(3),
    "last_failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_webhooks_tenant_id_idx" ON "tenant_webhooks"("tenant_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_webhooks_tenant_id_fkey'
  ) THEN
    ALTER TABLE "tenant_webhooks" ADD CONSTRAINT "tenant_webhooks_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Replace single-column indexes with composite indexes

-- audit_logs: replace (team_id, created_at), (tenant_id), (user_id, created_at)
--   with (team_id, scope, created_at DESC), (tenant_id, scope, created_at DESC), (user_id, scope, created_at DESC)
DROP INDEX IF EXISTS "audit_logs_team_id_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_tenant_id_idx";
DROP INDEX IF EXISTS "audit_logs_user_id_created_at_idx";
CREATE INDEX IF NOT EXISTS "audit_logs_team_id_scope_created_at_idx" ON "audit_logs"("team_id", "scope", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_id_scope_created_at_idx" ON "audit_logs"("tenant_id", "scope", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_user_id_scope_created_at_idx" ON "audit_logs"("user_id", "scope", "created_at" DESC);

-- emergency_access_grants: replace (owner_id) + (status) with (owner_id, status)
DROP INDEX IF EXISTS "emergency_access_grants_owner_id_idx";
DROP INDEX IF EXISTS "emergency_access_grants_status_idx";
CREATE INDEX IF NOT EXISTS "emergency_access_grants_owner_id_status_idx" ON "emergency_access_grants"("owner_id", "status");

-- password_entries: replace (user_id) with (user_id, deleted_at, is_archived)
DROP INDEX IF EXISTS "password_entries_user_id_idx";
CREATE INDEX IF NOT EXISTS "password_entries_user_id_deleted_at_is_archived_idx" ON "password_entries"("user_id", "deleted_at", "is_archived");

-- password_shares: replace (created_by_id) + (share_type) with (created_by_id, created_at DESC)
DROP INDEX IF EXISTS "password_shares_created_by_id_idx";
DROP INDEX IF EXISTS "password_shares_share_type_idx";
CREATE INDEX IF NOT EXISTS "password_shares_created_by_id_created_at_idx" ON "password_shares"("created_by_id", "created_at" DESC);

-- sessions: replace (user_id) with (user_id, expires)
DROP INDEX IF EXISTS "sessions_user_id_idx";
CREATE INDEX IF NOT EXISTS "sessions_user_id_expires_idx" ON "sessions"("user_id", "expires");

-- team_password_entries: replace (team_id) with (team_id, deleted_at)
DROP INDEX IF EXISTS "team_password_entries_team_id_idx";
CREATE INDEX IF NOT EXISTS "team_password_entries_team_id_deleted_at_idx" ON "team_password_entries"("team_id", "deleted_at");
