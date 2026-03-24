-- DropIndex
DROP INDEX IF EXISTS "teams_slug_key";

-- CreateIndex: team slug is unique within a tenant, not globally
CREATE UNIQUE INDEX "teams_tenant_id_slug_key" ON "teams"("tenant_id", "slug");
