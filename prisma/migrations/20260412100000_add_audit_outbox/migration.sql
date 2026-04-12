-- CreateEnum
CREATE TYPE "AuditOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "audit_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AuditOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_retry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "last_error" VARCHAR(1024),

    CONSTRAINT "audit_outbox_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "audit_outbox" ADD CONSTRAINT "audit_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "audit_outbox_status_next_retry_at_idx" ON "audit_outbox"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "audit_outbox_tenant_id_status_created_at_idx" ON "audit_outbox"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "audit_outbox_status_processing_started_at_idx" ON "audit_outbox"("status", "processing_started_at");

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "outbox_id" UUID;

-- CreateUniqueIndex
CREATE UNIQUE INDEX "audit_logs_outbox_id_key" ON "audit_logs"("outbox_id");

-- AddConstraint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_outbox_id_actor_type_check"
  CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM');

-- Enable Row Level Security for tenant isolation
ALTER TABLE "audit_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_outbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_outbox_tenant_isolation ON "audit_outbox";
CREATE POLICY audit_outbox_tenant_isolation ON "audit_outbox"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Prevent deletion of audit evidence: only SENT or FAILED rows may be deleted
CREATE OR REPLACE FUNCTION audit_outbox_before_delete_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status NOT IN ('SENT', 'FAILED') THEN
    RAISE EXCEPTION 'Cannot delete audit_outbox row with status=%', OLD.status;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_outbox_before_delete
  BEFORE DELETE ON audit_outbox FOR EACH ROW
  EXECUTE FUNCTION audit_outbox_before_delete_guard();
