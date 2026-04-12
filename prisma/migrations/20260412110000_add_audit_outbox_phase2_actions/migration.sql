-- Phase 2: Add audit outbox operational actions
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_OUTBOX_REAPED';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_OUTBOX_DEAD_LETTER';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_OUTBOX_RETENTION_PURGED';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_OUTBOX_METRICS_VIEW';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_OUTBOX_PURGE_EXECUTED';

-- Make user_id nullable for SYSTEM actor rows (worker meta-events have no user)
ALTER TABLE "audit_logs" ALTER COLUMN "user_id" DROP NOT NULL;

-- Ensure only SYSTEM actor rows may have NULL user_id
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_system_actor_user_id_check"
  CHECK (user_id IS NOT NULL OR actor_type = 'SYSTEM') NOT VALID;
