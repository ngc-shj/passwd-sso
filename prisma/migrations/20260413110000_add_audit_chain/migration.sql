-- Phase 4: Tamper-evidence hash chain for audit logs

-- AlterEnum: add AUDIT_CHAIN_VERIFY action
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_CHAIN_VERIFY';

-- AlterTable: add audit chain columns to audit_logs
ALTER TABLE "audit_logs" ADD COLUMN "chain_seq" BIGINT;
ALTER TABLE "audit_logs" ADD COLUMN "event_hash" BYTEA;
ALTER TABLE "audit_logs" ADD COLUMN "chain_prev_hash" BYTEA;

-- AlterTable: add audit_chain_enabled flag to tenants
ALTER TABLE "tenants" ADD COLUMN "audit_chain_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: audit_chain_anchors (one row per tenant)
CREATE TABLE "audit_chain_anchors" (
    "tenant_id" UUID NOT NULL,
    "chain_seq" BIGINT NOT NULL DEFAULT 0,
    "prev_hash" BYTEA NOT NULL DEFAULT '\x00'::bytea,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_chain_anchors_pkey" PRIMARY KEY ("tenant_id")
);

-- AddForeignKey
ALTER TABLE "audit_chain_anchors" ADD CONSTRAINT "audit_chain_anchors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable Row Level Security for tenant isolation
ALTER TABLE "audit_chain_anchors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_chain_anchors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_chain_anchors_tenant_isolation ON "audit_chain_anchors";
CREATE POLICY audit_chain_anchors_tenant_isolation ON "audit_chain_anchors"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Worker grants: passwd_outbox_worker needs SELECT (FOR UPDATE read), INSERT (anchor upsert), UPDATE (chain advancement)
GRANT SELECT, INSERT, UPDATE ON TABLE "audit_chain_anchors" TO passwd_outbox_worker;
