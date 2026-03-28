-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('HUMAN', 'SERVICE_ACCOUNT', 'MCP_AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ACCESS_REQUEST_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCESS_REQUEST_APPROVE';
ALTER TYPE "AuditAction" ADD VALUE 'ACCESS_REQUEST_DENY';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_type" "ActorType" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "service_account_id" UUID;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "jit_token_default_ttl_sec" INTEGER,
ADD COLUMN     "jit_token_max_ttl_sec" INTEGER,
ADD COLUMN     "sa_token_max_expiry_days" INTEGER;

-- CreateTable
CREATE TABLE "access_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "service_account_id" UUID NOT NULL,
    "requested_scope" TEXT NOT NULL,
    "justification" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "granted_token_id" UUID,
    "granted_token_ttl_sec" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_requests_tenant_id_status_created_at_idx" ON "access_requests"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "access_requests_service_account_id_status_idx" ON "access_requests"("service_account_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_type_created_at_idx" ON "audit_logs"("tenant_id", "actor_type", "created_at" DESC);

-- CreateIndex (partial)
CREATE INDEX "audit_logs_service_account_id_idx" ON "audit_logs"("service_account_id") WHERE "service_account_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_service_account_id_fkey" FOREIGN KEY ("service_account_id") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_service_account_id_fkey" FOREIGN KEY ("service_account_id") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
