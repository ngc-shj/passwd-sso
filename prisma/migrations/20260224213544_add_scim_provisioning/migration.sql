-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SCIM_TOKEN_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_TOKEN_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_USER_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_USER_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_USER_DEACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_USER_REACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_USER_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'SCIM_GROUP_UPDATE';

-- AlterTable
ALTER TABLE "org_members" ADD COLUMN     "deactivated_at" TIMESTAMP(3),
ADD COLUMN     "scim_managed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by_id" TEXT,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_external_mappings" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "resource_type" VARCHAR(20) NOT NULL,
    "internal_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_external_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_token_hash_key" ON "scim_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "scim_tokens_org_id_revoked_at_idx" ON "scim_tokens"("org_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "scim_external_mappings_org_id_external_id_resource_type_key" ON "scim_external_mappings"("org_id", "external_id", "resource_type");

-- CreateIndex
CREATE UNIQUE INDEX "scim_external_mappings_org_id_internal_id_resource_type_key" ON "scim_external_mappings"("org_id", "internal_id", "resource_type");

-- AddForeignKey
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_external_mappings" ADD CONSTRAINT "scim_external_mappings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
