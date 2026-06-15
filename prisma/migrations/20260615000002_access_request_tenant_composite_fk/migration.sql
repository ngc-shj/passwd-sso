-- Enforce tenant-boundary consistency between an access request and its parent
-- service account at the DB level. An access_requests (service_account_id,
-- tenant_id) pair must reference an existing service_accounts (id, tenant_id)
-- pair, making it impossible to persist a request whose tenant_id differs from
-- its SA's tenant_id. Mirrors the service_account_tokens composite FK.

-- DropForeignKey
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_service_account_id_fkey";

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_service_account_id_tenant_id_fkey" FOREIGN KEY ("service_account_id", "tenant_id") REFERENCES "service_accounts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
