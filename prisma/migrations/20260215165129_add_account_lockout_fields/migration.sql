-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'VAULT_UNLOCK_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'VAULT_LOCKOUT_TRIGGERED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "account_locked_until" TIMESTAMP(3),
ADD COLUMN     "failed_unlock_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_failed_unlock_at" TIMESTAMP(3);
