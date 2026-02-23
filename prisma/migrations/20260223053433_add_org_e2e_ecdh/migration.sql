-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ORG_E2E_MIGRATION';
ALTER TYPE "AuditAction" ADD VALUE 'ORG_KEY_ROTATION';
ALTER TYPE "AuditAction" ADD VALUE 'ORG_MEMBER_KEY_DISTRIBUTE';

-- AlterTable
ALTER TABLE "org_members" ADD COLUMN     "key_distributed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_password_entries" ADD COLUMN     "org_key_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "org_password_entry_histories" ADD COLUMN     "org_key_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "e2e_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "org_key_version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "encrypted_org_key" DROP NOT NULL,
ALTER COLUMN "org_key_iv" DROP NOT NULL,
ALTER COLUMN "org_key_auth_tag" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ecdh_private_key_auth_tag" VARCHAR(32),
ADD COLUMN     "ecdh_private_key_iv" VARCHAR(24),
ADD COLUMN     "ecdh_public_key" TEXT,
ADD COLUMN     "encrypted_ecdh_private_key" TEXT;

-- CreateTable
CREATE TABLE "org_member_keys" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "encrypted_org_key" TEXT NOT NULL,
    "org_key_iv" VARCHAR(24) NOT NULL,
    "org_key_auth_tag" VARCHAR(32) NOT NULL,
    "ephemeral_public_key" TEXT NOT NULL,
    "hkdf_salt" VARCHAR(64) NOT NULL,
    "wrap_version" INTEGER NOT NULL DEFAULT 1,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_member_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_member_keys_user_id_idx" ON "org_member_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_member_keys_org_id_user_id_key_version_key" ON "org_member_keys"("org_id", "user_id", "key_version");

-- AddForeignKey
ALTER TABLE "org_member_keys" ADD CONSTRAINT "org_member_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_keys" ADD CONSTRAINT "org_member_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
