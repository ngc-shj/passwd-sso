-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SESSION_EVICTED';
ALTER TYPE "AuditAction" ADD VALUE 'ENTRY_HISTORY_REENCRYPT';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SESSION_EVICTED';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "max_concurrent_sessions" INTEGER;
