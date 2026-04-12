-- CreateEnum
CREATE TYPE "AuditDeliveryTargetKind" AS ENUM ('DB', 'WEBHOOK', 'SIEM_HEC', 'S3_OBJECT');

-- CreateEnum
CREATE TYPE "AuditDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "audit_delivery_targets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "AuditDeliveryTargetKind" NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "config_iv" TEXT NOT NULL,
    "config_auth_tag" TEXT NOT NULL,
    "master_key_version" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1024),
    "last_delivered_at" TIMESTAMP(3),

    CONSTRAINT "audit_delivery_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_deliveries" (
    "id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "AuditDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_retry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "last_error" VARCHAR(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_deliveries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "audit_delivery_targets" ADD CONSTRAINT "audit_delivery_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_deliveries" ADD CONSTRAINT "audit_deliveries_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "audit_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_deliveries" ADD CONSTRAINT "audit_deliveries_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "audit_delivery_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_deliveries" ADD CONSTRAINT "audit_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "audit_delivery_targets_tenant_id_is_active_idx" ON "audit_delivery_targets"("tenant_id", "is_active");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "audit_deliveries_outbox_id_target_id_key" ON "audit_deliveries"("outbox_id", "target_id");

-- CreateIndex
CREATE INDEX "audit_deliveries_tenant_id_status_next_retry_at_idx" ON "audit_deliveries"("tenant_id", "status", "next_retry_at");

-- CreateIndex
CREATE INDEX "audit_deliveries_status_next_retry_at_idx" ON "audit_deliveries"("status", "next_retry_at");

-- Enable Row Level Security for tenant isolation
ALTER TABLE "audit_delivery_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_delivery_targets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_delivery_targets_tenant_isolation ON "audit_delivery_targets";
CREATE POLICY audit_delivery_targets_tenant_isolation ON "audit_delivery_targets"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

ALTER TABLE "audit_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_deliveries_tenant_isolation ON "audit_deliveries";
CREATE POLICY audit_deliveries_tenant_isolation ON "audit_deliveries"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Worker grants (use current_database() to avoid hardcoding DB name)
-- Phase 3: delivery targets — worker needs to read target config and track delivery state
GRANT SELECT ON TABLE "audit_delivery_targets" TO passwd_outbox_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_deliveries" TO passwd_outbox_worker;

-- AlterEnum: add Phase 3 audit actions
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_DELIVERY_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_DELIVERY_DEAD_LETTER';
