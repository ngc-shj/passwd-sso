-- AlterTable
ALTER TABLE "org_password_entries" DROP COLUMN "is_favorite";

-- CreateTable
CREATE TABLE "org_password_favorites" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_password_entry_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_password_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_password_favorites_user_id_org_password_entry_id_key" ON "org_password_favorites"("user_id", "org_password_entry_id");

-- AddForeignKey
ALTER TABLE "org_password_favorites" ADD CONSTRAINT "org_password_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_password_favorites" ADD CONSTRAINT "org_password_favorites_org_password_entry_id_fkey" FOREIGN KEY ("org_password_entry_id") REFERENCES "org_password_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
