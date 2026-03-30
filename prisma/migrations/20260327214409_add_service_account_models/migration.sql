-- CreateEnum
CREATE TYPE "IdentityType" AS ENUM ('HUMAN', 'SERVICE_ACCOUNT', 'MCP_AGENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_TOKEN_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_TOKEN_REVOKE';

-- AlterTable
ALTER TABLE "accounts" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "admin_vault_resets" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "attachments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "directory_sync_configs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "directory_sync_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "emergency_access_grants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "emergency_access_key_pairs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "extension_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "folders" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "password_entries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "password_entry_histories" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "password_shares" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "personal_log_access_grants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scim_external_mappings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scim_group_mappings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scim_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "share_access_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tags" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_folders" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_invitations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_member_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_members" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_password_entries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_password_entry_histories" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_password_favorites" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_policies" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_tags" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "team_webhooks" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "teams" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenant_members" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenant_webhooks" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vault_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "webauthn_credentials" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "service_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "team_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "identity_type" "IdentityType" NOT NULL DEFAULT 'SERVICE_ACCOUNT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_account_tokens" (
    "id" UUID NOT NULL,
    "service_account_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "scope" VARCHAR(1024) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "service_account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_accounts_tenant_id_is_active_idx" ON "service_accounts"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "service_accounts_tenant_id_name_key" ON "service_accounts"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "service_account_tokens_token_hash_key" ON "service_account_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "service_account_tokens_service_account_id_revoked_at_idx" ON "service_account_tokens"("service_account_id", "revoked_at");

-- CreateIndex
CREATE INDEX "service_account_tokens_tenant_id_idx" ON "service_account_tokens"("tenant_id");

-- CreateIndex
CREATE INDEX "service_account_tokens_expires_at_idx" ON "service_account_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_service_account_id_fkey" FOREIGN KEY ("service_account_id") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
