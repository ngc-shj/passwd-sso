-- AlterTable
ALTER TABLE "org_password_entries" ADD COLUMN     "expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "password_entries" ADD COLUMN     "expires_at" TIMESTAMP(3);
