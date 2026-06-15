-- Enforce tenant-boundary consistency between a service-account token and its
-- parent service account at the DB level. A token's (service_account_id,
-- tenant_id) pair must reference an existing service_accounts (id, tenant_id)
-- pair, making it impossible to persist a token whose tenant_id differs from
-- its SA's tenant_id.

-- DropForeignKey
ALTER TABLE "service_account_tokens" DROP CONSTRAINT "service_account_tokens_service_account_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "service_accounts_id_tenant_id_key" ON "service_accounts"("id", "tenant_id");

-- AddForeignKey
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_service_account_id_tenant_id_fkey" FOREIGN KEY ("service_account_id", "tenant_id") REFERENCES "service_accounts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
