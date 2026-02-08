-- AlterTable
ALTER TABLE "password_entries" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "is_favorite" BOOLEAN NOT NULL DEFAULT false;
