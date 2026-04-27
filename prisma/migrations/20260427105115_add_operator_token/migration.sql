-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_TOKEN_CREATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_TOKEN_REVOKE';

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;

-- CreateTable
CREATE TABLE "operator_tokens" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "scope" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_tokens_token_hash_key" ON "operator_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "operator_tokens_tenant_id_revoked_at_idx" ON "operator_tokens"("tenant_id", "revoked_at");

-- CreateIndex
CREATE INDEX "operator_tokens_subject_user_id_revoked_at_idx" ON "operator_tokens"("subject_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "operator_tokens_expires_at_idx" ON "operator_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "operator_tokens" ADD CONSTRAINT "operator_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_tokens" ADD CONSTRAINT "operator_tokens_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_tokens" ADD CONSTRAINT "operator_tokens_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant app role access (no DELETE — tokens are tombstoned, not removed).
-- Guarded with IF EXISTS because passwd_app is created by infra/initdb in dev
-- and by a post-migration bootstrap step in CI (ci-integration.yml). The
-- migration must not assume the role pre-exists.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE operator_tokens TO passwd_app;
  END IF;
END $$;

-- Tenant-RLS isolation: rows are visible to a tenant's app session only
-- (or when app.bypass_rls is 'on' for cross-tenant flows like token validation).
ALTER TABLE "operator_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_tokens_tenant_isolation ON "operator_tokens";
CREATE POLICY operator_tokens_tenant_isolation ON "operator_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
