-- CreateEnum
CREATE TYPE "WebhookDeliveryScope" AS ENUM ('TENANT', 'TEAM');

-- CreateTable
-- Timestamp columns are TIMESTAMPTZ(3) (not TIMESTAMP(3)) to match the Prisma
-- @db.Timestamptz(3) model and every sibling table post-20260413120000; a bare
-- TIMESTAMP would reintroduce the local-timezone next_retry_at comparison bug.
-- No FK to audit_outbox: the queue survives outbox purge (like audit_deliveries).
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" "WebhookDeliveryScope" NOT NULL,
    "team_id" UUID,
    "action" TEXT NOT NULL,
    "status" "AuditDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_retry_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey (tenants only — deliberately no FK to audit_outbox, GT-4)
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateUniqueIndex (dedup key: <=1 work item per (outboxId, scope, teamId)).
-- NULLS NOT DISTINCT (PG15+) so the TENANT-scope rows (team_id IS NULL) also
-- dedup on (outbox_id, TENANT): with the default NULLS DISTINCT, two
-- (outbox_id, TENANT, NULL) tuples would be treated as distinct and the
-- ON CONFLICT defense-in-depth in enqueueWebhookDeliveryInTx would silently
-- insert a duplicate on a reaper re-enqueue. The audit_logs UNIQUE(outbox_id)
-- gate is the primary dedup (only the ON CONFLICT winner enqueues); this index
-- is the schema-enforced backstop (INV-W1) and must cover the NULL case too.
CREATE UNIQUE INDEX "webhook_deliveries_outbox_id_scope_team_id_key" ON "webhook_deliveries"("outbox_id", "scope", "team_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_status_next_retry_at_idx" ON "webhook_deliveries"("tenant_id", "status", "next_retry_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_retry_at_idx" ON "webhook_deliveries"("status", "next_retry_at");

-- Enable Row Level Security for tenant isolation (identical shape to audit_deliveries)
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON "webhook_deliveries";
CREATE POLICY webhook_deliveries_tenant_isolation ON "webhook_deliveries"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Worker grants (least privilege). The enqueue runs under passwd_outbox_worker
-- inside deliverRow/deliverRowWithChain, so the worker needs INSERT here; the
-- delivery loop needs SELECT/UPDATE/DELETE on the queue and SELECT/UPDATE on the
-- webhook tables (subscriber resolution + health fields). No app-role grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_deliveries" TO passwd_outbox_worker;
GRANT SELECT, UPDATE ON TABLE "tenant_webhooks" TO passwd_outbox_worker;
GRANT SELECT, UPDATE ON TABLE "team_webhooks" TO passwd_outbox_worker;

-- AlterEnum: new dead-letter action for the webhook delivery queue.
-- (Unchained: emitted via writeDirectAuditLog + OUTBOX_BYPASS_AUDIT_ACTIONS +
-- WEBHOOK_DISPATCH_SUPPRESS — never re-enters the outbox.)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER';
