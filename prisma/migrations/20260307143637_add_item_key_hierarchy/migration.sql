-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "encryption_mode" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "team_password_entries" ADD COLUMN     "encrypted_item_key" TEXT,
ADD COLUMN     "item_key_auth_tag" VARCHAR(32),
ADD COLUMN     "item_key_iv" VARCHAR(24),
ADD COLUMN     "item_key_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "team_password_entry_histories" ADD COLUMN     "encrypted_item_key" TEXT,
ADD COLUMN     "item_key_auth_tag" VARCHAR(32),
ADD COLUMN     "item_key_iv" VARCHAR(24),
ADD COLUMN     "item_key_version" INTEGER NOT NULL DEFAULT 0;
