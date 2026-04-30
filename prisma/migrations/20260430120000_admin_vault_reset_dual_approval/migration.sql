-- Admin Vault Reset Dual-Approval: schema columns + index + AuditAction enum

-- 1. Add new audit action (transactional ALTER TYPE for AuditAction —
--    Postgres requires non-transactional only when the value is then used
--    in the same migration's INSERT, which we do not do here)
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_VAULT_RESET_APPROVE';

-- 2. Add columns to admin_vault_resets
ALTER TABLE "admin_vault_resets"
  ADD COLUMN "encrypted_token" TEXT,
  ADD COLUMN "target_email_at_initiate" VARCHAR(320),
  ADD COLUMN "approved_at" TIMESTAMPTZ(3),
  ADD COLUMN "approved_by_id" UUID;

-- 3. FK for approved_by_id (SetNull on user delete to preserve audit trail)
ALTER TABLE "admin_vault_resets"
  ADD CONSTRAINT "admin_vault_resets_approved_by_id_fkey"
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Composite index for approve-state queries (ADDS to existing index)
CREATE INDEX "admin_vault_resets_target_user_id_approved_at_executed_at_revoked_at_idx"
  ON "admin_vault_resets" ("target_user_id", "approved_at", "executed_at", "revoked_at");
