-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM (
  'SECURITY_ALERT',
  'NEW_DEVICE_LOGIN',
  'EMERGENCY_ACCESS',
  'SHARE_ACCESS',
  'TEAM_INVITE',
  'ENTRY_EXPIRING',
  'WATCHTOWER_ALERT',
  'POLICY_UPDATE'
);

-- AlterEnum (add POLICY_UPDATE to AuditAction)
ALTER TYPE "AuditAction" ADD VALUE 'POLICY_UPDATE';

-- CreateTable
CREATE TABLE "notifications" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "type"       "NotificationType" NOT NULL,
  "title"      VARCHAR(200) NOT NULL,
  "body"       TEXT NOT NULL,
  "metadata"   JSONB,
  "is_read"    BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_created_at_idx"
  ON "notifications"("user_id", "is_read", "created_at" DESC);

CREATE INDEX "notifications_tenant_id_idx"
  ON "notifications"("tenant_id");

-- AddForeignKey
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- EnableRowLevelSecurity
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;

-- CreatePolicy
DROP POLICY IF EXISTS notifications_tenant_isolation ON "notifications";
CREATE POLICY notifications_tenant_isolation ON "notifications"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
