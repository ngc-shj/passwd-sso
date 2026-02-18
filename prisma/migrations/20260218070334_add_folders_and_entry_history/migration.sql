-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'FOLDER_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'FOLDER_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'FOLDER_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'ENTRY_HISTORY_RESTORE';
ALTER TYPE "AuditAction" ADD VALUE 'HISTORY_PURGE';

-- AlterTable
ALTER TABLE "org_password_entries" ADD COLUMN     "org_folder_id" TEXT;

-- AlterTable
ALTER TABLE "password_entries" ADD COLUMN     "folder_id" TEXT;

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "parent_id" TEXT,
    "user_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_folders" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "parent_id" TEXT,
    "org_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_entry_histories" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "encrypted_blob" TEXT NOT NULL,
    "blob_iv" VARCHAR(24) NOT NULL,
    "blob_auth_tag" VARCHAR(32) NOT NULL,
    "key_version" INTEGER NOT NULL,
    "aad_version" INTEGER NOT NULL DEFAULT 0,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_entry_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_password_entry_histories" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "encrypted_blob" TEXT NOT NULL,
    "blob_iv" VARCHAR(24) NOT NULL,
    "blob_auth_tag" VARCHAR(32) NOT NULL,
    "aad_version" INTEGER NOT NULL DEFAULT 0,
    "changed_by_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_password_entry_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "folders_user_id_idx" ON "folders"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "folders_name_parent_id_user_id_key" ON "folders"("name", "parent_id", "user_id");

-- CreateIndex
CREATE INDEX "org_folders_org_id_idx" ON "org_folders"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_folders_name_parent_id_org_id_key" ON "org_folders"("name", "parent_id", "org_id");

-- CreateIndex
CREATE INDEX "password_entry_histories_entry_id_changed_at_idx" ON "password_entry_histories"("entry_id", "changed_at");

-- CreateIndex
CREATE INDEX "org_password_entry_histories_entry_id_changed_at_idx" ON "org_password_entry_histories"("entry_id", "changed_at");

-- AddForeignKey
ALTER TABLE "password_entries" ADD CONSTRAINT "password_entries_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_password_entries" ADD CONSTRAINT "org_password_entries_org_folder_id_fkey" FOREIGN KEY ("org_folder_id") REFERENCES "org_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_folders" ADD CONSTRAINT "org_folders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_folders" ADD CONSTRAINT "org_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_entry_histories" ADD CONSTRAINT "password_entry_histories_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "password_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_password_entry_histories" ADD CONSTRAINT "org_password_entry_histories_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "org_password_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_password_entry_histories" ADD CONSTRAINT "org_password_entry_histories_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique indexes for root folders (parentId=NULL)
-- Prisma's @@unique does not prevent duplicates when parentId is NULL in PostgreSQL
-- because NULL != NULL in unique constraints. These indexes enforce uniqueness at the root level.
CREATE UNIQUE INDEX "folders_name_user_id_root" ON "folders" ("name", "user_id") WHERE "parent_id" IS NULL;
CREATE UNIQUE INDEX "org_folders_name_org_id_root" ON "org_folders" ("name", "org_id") WHERE "parent_id" IS NULL;
