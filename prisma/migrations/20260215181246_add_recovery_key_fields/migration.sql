-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'RECOVERY_KEY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECOVERY_KEY_REGENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECOVERY_PASSPHRASE_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'VAULT_RESET_EXECUTED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "recovery_encrypted_secret_key" TEXT,
ADD COLUMN     "recovery_hkdf_salt" VARCHAR(64),
ADD COLUMN     "recovery_key_set_at" TIMESTAMP(3),
ADD COLUMN     "recovery_secret_key_auth_tag" VARCHAR(32),
ADD COLUMN     "recovery_secret_key_iv" VARCHAR(24),
ADD COLUMN     "recovery_verifier_hmac" VARCHAR(64);
