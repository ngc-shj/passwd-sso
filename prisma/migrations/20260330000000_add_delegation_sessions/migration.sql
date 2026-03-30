-- Add AuditAction enum values for delegation operations
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_EXPIRE';
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_READ';
ALTER TYPE "AuditAction" ADD VALUE 'DELEGATION_CHECK';

-- Add tenant-level delegation TTL policy columns
ALTER TABLE "tenants"
  ADD COLUMN "delegation_default_ttl_sec" INTEGER,
  ADD COLUMN "delegation_max_ttl_sec" INTEGER;

-- CreateTable
CREATE TABLE "delegation_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mcp_token_id" UUID NOT NULL,
    "entry_ids" TEXT[],
    "note" VARCHAR(255),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delegation_sessions_user_id_revoked_at_expires_at_idx" ON "delegation_sessions"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "delegation_sessions_mcp_token_id_revoked_at_idx" ON "delegation_sessions"("mcp_token_id", "revoked_at");

-- CreateIndex
CREATE INDEX "delegation_sessions_tenant_id_idx" ON "delegation_sessions"("tenant_id");

-- AddForeignKey
ALTER TABLE "delegation_sessions" ADD CONSTRAINT "delegation_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_sessions" ADD CONSTRAINT "delegation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_sessions" ADD CONSTRAINT "delegation_sessions_mcp_token_id_fkey" FOREIGN KEY ("mcp_token_id") REFERENCES "mcp_access_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRLS (tenant isolation — same pattern as mcp_access_tokens)
ALTER TABLE "delegation_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delegation_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegation_sessions_tenant_isolation ON "delegation_sessions";
CREATE POLICY delegation_sessions_tenant_isolation ON "delegation_sessions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Fix: FORCE RLS on batch_f tables (created in 20260306000000 with ENABLE but missing FORCE)
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webauthn_credentials" FORCE ROW LEVEL SECURITY;
ALTER TABLE "directory_sync_configs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "directory_sync_logs" FORCE ROW LEVEL SECURITY;

-- Fix: Enable RLS on tenant_webhooks (policy already exists from 20260321110000 but RLS was never enabled)
ALTER TABLE "tenant_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_webhooks" FORCE ROW LEVEL SECURITY;

-- Fix: Enable RLS on mcp_refresh_tokens (created in 20260329100000 without RLS)
ALTER TABLE "mcp_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_refresh_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_refresh_tokens_tenant_isolation ON "mcp_refresh_tokens";
CREATE POLICY mcp_refresh_tokens_tenant_isolation ON "mcp_refresh_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
