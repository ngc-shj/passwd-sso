-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CLIENT_DELETE';

-- CreateTable
CREATE TABLE "mcp_clients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "client_secret_hash" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "redirect_uris" TEXT[],
    "allowed_scopes" VARCHAR(1024) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_authorization_codes" (
    "id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "service_account_id" UUID,
    "redirect_uri" TEXT NOT NULL,
    "scope" VARCHAR(1024) NOT NULL,
    "code_challenge" VARCHAR(128) NOT NULL,
    "code_challenge_method" VARCHAR(10) NOT NULL DEFAULT 'S256',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_access_tokens" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "service_account_id" UUID,
    "scope" VARCHAR(1024) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_clients_client_id_key" ON "mcp_clients"("client_id");

-- CreateIndex
CREATE INDEX "mcp_clients_tenant_id_idx" ON "mcp_clients"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_clients_tenant_id_name_key" ON "mcp_clients"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_authorization_codes_code_hash_key" ON "mcp_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mcp_authorization_codes_expires_at_idx" ON "mcp_authorization_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_access_tokens_token_hash_key" ON "mcp_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_access_tokens_tenant_id_idx" ON "mcp_access_tokens"("tenant_id");

-- CreateIndex
CREATE INDEX "mcp_access_tokens_expires_at_idx" ON "mcp_access_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_authorization_codes" ADD CONSTRAINT "mcp_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add CHECK constraint: at least one of user_id or service_account_id must be set
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_actor_check"
  CHECK (("user_id" IS NOT NULL) OR ("service_account_id" IS NOT NULL));
