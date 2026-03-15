-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TEAM_MEMBER_ADD';
ALTER TYPE "AuditAction" ADD VALUE 'PERSONAL_LOG_ACCESS_REQUEST';
ALTER TYPE "AuditAction" ADD VALUE 'PERSONAL_LOG_ACCESS_VIEW';
ALTER TYPE "AuditAction" ADD VALUE 'PERSONAL_LOG_ACCESS_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE 'PERSONAL_LOG_ACCESS_EXPIRE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PERSONAL_LOG_ACCESSED';

-- CreateTable
CREATE TABLE "personal_log_access_grants" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "incident_ref" VARCHAR(500),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_log_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personal_log_access_grants_tenant_id_target_user_id_idx" ON "personal_log_access_grants"("tenant_id", "target_user_id");

-- CreateIndex
CREATE INDEX "personal_log_access_grants_requester_id_idx" ON "personal_log_access_grants"("requester_id");

-- CreateIndex
CREATE INDEX "personal_log_access_grants_expires_at_idx" ON "personal_log_access_grants"("expires_at");

-- CreateIndex
CREATE INDEX "personal_log_access_grants_requester_id_target_user_id_tena_idx" ON "personal_log_access_grants"("requester_id", "target_user_id", "tenant_id");

-- AddForeignKey
ALTER TABLE "personal_log_access_grants" ADD CONSTRAINT "personal_log_access_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_log_access_grants" ADD CONSTRAINT "personal_log_access_grants_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_log_access_grants" ADD CONSTRAINT "personal_log_access_grants_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS
ALTER TABLE "personal_log_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_log_access_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_log_access_grants_tenant_isolation ON "personal_log_access_grants"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
