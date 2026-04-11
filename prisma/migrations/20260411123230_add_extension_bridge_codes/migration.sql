-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EXTENSION_BRIDGE_CODE_ISSUE';
ALTER TYPE "AuditAction" ADD VALUE 'EXTENSION_TOKEN_EXCHANGE_SUCCESS';

-- CreateTable
CREATE TABLE "extension_bridge_codes" (
    "id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "extension_bridge_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "extension_bridge_codes_code_hash_key" ON "extension_bridge_codes"("code_hash");

-- CreateIndex
CREATE INDEX "extension_bridge_codes_user_id_used_at_idx" ON "extension_bridge_codes"("user_id", "used_at");

-- CreateIndex
CREATE INDEX "extension_bridge_codes_expires_at_idx" ON "extension_bridge_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "extension_bridge_codes" ADD CONSTRAINT "extension_bridge_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_bridge_codes" ADD CONSTRAINT "extension_bridge_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable Row Level Security for tenant isolation
ALTER TABLE "extension_bridge_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extension_bridge_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS extension_bridge_codes_tenant_isolation ON "extension_bridge_codes";
CREATE POLICY extension_bridge_codes_tenant_isolation ON "extension_bridge_codes"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
