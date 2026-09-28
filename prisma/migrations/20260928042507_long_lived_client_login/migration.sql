BEGIN;

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;

-- AlterTable
ALTER TABLE "extension_tokens" ADD COLUMN     "last_presence_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "require_vault_timeout_logout" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
