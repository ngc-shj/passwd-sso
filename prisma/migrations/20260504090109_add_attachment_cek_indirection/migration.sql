-- AlterEnum
-- Phase B: ATTACHMENT_LEGACY_MIGRATION audit action emitted by PUT /migrate.
-- ALTER TYPE ADD VALUE is its own implicit transaction; PG >= 12 also forbids
-- using the new value in the same tx that creates it, so this must precede
-- any code path that emits the action.
ALTER TYPE "AuditAction" ADD VALUE 'ATTACHMENT_LEGACY_MIGRATION';

-- AlterTable
-- Phase B mode-2 (CEK indirection) columns on attachments.
-- Additive only: every column is nullable so existing mode-0 / mode-1 rows
-- continue to satisfy the schema. A future migration after the back-window
-- may flip these to NOT NULL once all rows have encryption_mode = 2.
ALTER TABLE "attachments" ADD COLUMN "cek_encrypted" BYTEA;
ALTER TABLE "attachments" ADD COLUMN "cek_iv" VARCHAR(24);
ALTER TABLE "attachments" ADD COLUMN "cek_auth_tag" VARCHAR(32);
ALTER TABLE "attachments" ADD COLUMN "cek_key_version" INTEGER;
ALTER TABLE "attachments" ADD COLUMN "cek_wrap_aad_version" INTEGER DEFAULT 1;
