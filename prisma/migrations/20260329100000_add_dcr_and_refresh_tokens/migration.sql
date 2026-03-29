-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_DCR_REGISTER';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_DCR_CLAIM';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_DCR_CLEANUP';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CONSENT_GRANT';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CONSENT_DENY';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_REFRESH_TOKEN_ROTATE';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_REFRESH_TOKEN_REPLAY';

-- AlterTable
ALTER TABLE "mcp_clients" ADD COLUMN     "dcr_expires_at" TIMESTAMP(3),
ADD COLUMN     "is_dcr" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "tenant_id" DROP NOT NULL,
ALTER COLUMN "created_by_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "mcp_refresh_tokens" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "access_token_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "service_account_id" UUID,
    "scope" VARCHAR(1024) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "replaced_by_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_refresh_tokens_token_hash_key" ON "mcp_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_refresh_tokens_family_id_revoked_at_idx" ON "mcp_refresh_tokens"("family_id", "revoked_at");

-- CreateIndex
CREATE INDEX "mcp_refresh_tokens_tenant_id_idx" ON "mcp_refresh_tokens"("tenant_id");

-- CreateIndex
CREATE INDEX "mcp_refresh_tokens_expires_at_idx" ON "mcp_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_access_token_id_fkey" FOREIGN KEY ("access_token_id") REFERENCES "mcp_access_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
