-- AlterTable: add permissions column to password_shares
ALTER TABLE "password_shares" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT '{}';
