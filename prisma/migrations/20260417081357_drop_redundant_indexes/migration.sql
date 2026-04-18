-- DropIndex
DROP INDEX "personal_log_access_grants_requester_id_idx";

-- DropIndex
DROP INDEX "scim_external_mappings_tenant_id_resource_type_idx";

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;
