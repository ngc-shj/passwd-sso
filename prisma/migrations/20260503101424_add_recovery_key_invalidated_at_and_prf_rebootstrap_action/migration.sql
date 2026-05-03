-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'WEBAUTHN_PRF_REBOOTSTRAP';

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;

-- AlterTable
ALTER TABLE "system_settings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "recovery_key_invalidated_at" TIMESTAMPTZ(3);

-- RenameIndex
ALTER INDEX "admin_vault_resets_target_user_id_approved_at_executed_at_revok" RENAME TO "admin_vault_resets_target_user_id_approved_at_executed_at_r_idx";
