-- AlterTable: Remove server-side org key columns from organizations
-- These columns are no longer needed because all orgs use E2E encryption (ECDH-P256).

ALTER TABLE "organizations" DROP COLUMN "e2e_enabled";
ALTER TABLE "organizations" DROP COLUMN "encrypted_org_key";
ALTER TABLE "organizations" DROP COLUMN "master_key_version";
ALTER TABLE "organizations" DROP COLUMN "org_key_auth_tag";
ALTER TABLE "organizations" DROP COLUMN "org_key_iv";

-- Change orgKeyVersion default from 0 to 1 (all E2E orgs start at version 1)
ALTER TABLE "organizations" ALTER COLUMN "org_key_version" SET DEFAULT 1;
