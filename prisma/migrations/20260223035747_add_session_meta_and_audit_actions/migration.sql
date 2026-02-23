-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REVOKE_ALL';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "ip_address" VARCHAR(45),
ADD COLUMN     "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "user_agent" VARCHAR(512);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
