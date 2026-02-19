-- CreateEnum
CREATE TYPE "ShareType" AS ENUM ('ENTRY_SHARE', 'TEXT', 'FILE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SEND_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'SEND_REVOKE';

-- AlterTable
ALTER TABLE "password_shares" ADD COLUMN     "encrypted_file" BYTEA,
ADD COLUMN     "file_auth_tag" VARCHAR(32),
ADD COLUMN     "file_iv" VARCHAR(24),
ADD COLUMN     "send_content_type" VARCHAR(100),
ADD COLUMN     "send_filename" VARCHAR(255),
ADD COLUMN     "send_name" VARCHAR(200),
ADD COLUMN     "send_size_bytes" INTEGER,
ADD COLUMN     "share_type" "ShareType" NOT NULL DEFAULT 'ENTRY_SHARE',
ALTER COLUMN "entry_type" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "password_shares_share_type_idx" ON "password_shares"("share_type");

-- CreateIndex
CREATE INDEX "password_shares_created_by_id_idx" ON "password_shares"("created_by_id");
