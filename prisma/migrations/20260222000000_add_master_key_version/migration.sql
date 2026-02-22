-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'MASTER_KEY_ROTATION';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "master_key_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "password_shares" ADD COLUMN     "master_key_version" INTEGER NOT NULL DEFAULT 1;
