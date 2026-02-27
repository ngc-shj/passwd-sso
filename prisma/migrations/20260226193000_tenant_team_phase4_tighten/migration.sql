-- Phase 4: tighten tenant constraints and switch SCIM uniqueness to tenant scope

-- Guard: fail fast if any required tenant_id is still null.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "organizations" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase4 precondition failed: organizations.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "scim_tokens" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase4 precondition failed: scim_tokens.tenant_id contains NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM "scim_external_mappings" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Phase4 precondition failed: scim_external_mappings.tenant_id contains NULL';
  END IF;
END $$;

-- 1) Drop old FK policies using ON DELETE SET NULL.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_tenant_id_fkey";
ALTER TABLE "scim_tokens" DROP CONSTRAINT IF EXISTS "scim_tokens_tenant_id_fkey";
ALTER TABLE "scim_external_mappings" DROP CONSTRAINT IF EXISTS "scim_external_mappings_tenant_id_fkey";

-- 2) Make tenant_id required.
ALTER TABLE "organizations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "scim_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "scim_external_mappings" ALTER COLUMN "tenant_id" SET NOT NULL;

-- 3) Recreate FK constraints with RESTRICT behavior.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "scim_tokens"
  ADD CONSTRAINT "scim_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "scim_external_mappings"
  ADD CONSTRAINT "scim_external_mappings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4) Replace org-scoped uniqueness with tenant-scoped uniqueness for SCIM mappings.
DROP INDEX IF EXISTS "scim_external_mappings_org_id_external_id_resource_type_key";
DROP INDEX IF EXISTS "scim_external_mappings_org_id_internal_id_resource_type_key";

CREATE UNIQUE INDEX "scim_external_mappings_tenant_id_external_id_resource_type_key"
  ON "scim_external_mappings"("tenant_id", "external_id", "resource_type");

CREATE UNIQUE INDEX "scim_external_mappings_tenant_id_internal_id_resource_type_key"
  ON "scim_external_mappings"("tenant_id", "internal_id", "resource_type");
