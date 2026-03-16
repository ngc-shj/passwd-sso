-- AlterTable: WebAuthnCredential
ALTER TABLE "webauthn_credentials" ADD COLUMN "min_pin_length" INTEGER;
ALTER TABLE "webauthn_credentials" ADD COLUMN "large_blob_supported" BOOLEAN;

-- AlterTable: Tenant
ALTER TABLE "tenants" ADD COLUMN "require_min_pin_length" INTEGER;
