-- AlterTable: add recovery verifier version to users
ALTER TABLE "users" ADD COLUMN "recovery_verifier_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: add access password hash version to password_shares
ALTER TABLE "password_shares" ADD COLUMN "access_password_hash_version" INTEGER NOT NULL DEFAULT 1;

-- AlterEnum: add verifier pepper audit actions
ALTER TYPE "AuditAction" ADD VALUE 'VERIFIER_PEPPER_ROTATE_BEGIN';
ALTER TYPE "AuditAction" ADD VALUE 'VERIFIER_PEPPER_ROTATE_COMPLETE';
ALTER TYPE "AuditAction" ADD VALUE 'VERIFIER_PEPPER_ROTATE_ROLLBACK';
ALTER TYPE "AuditAction" ADD VALUE 'VERIFIER_PEPPER_MISSING';
