-- AlterTable
ALTER TABLE "webauthn_credentials" ADD COLUMN     "last_used_device" VARCHAR(100),
ADD COLUMN     "registered_device" VARCHAR(100);
