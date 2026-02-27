-- Migration A: Add external_id and is_bootstrap columns to tenants table.
--
-- S-3: Store IdP claim value in external_id instead of using it as primary key.
-- S-4: Add explicit is_bootstrap flag for bootstrap tenant detection.

-- Add external_id column (nullable, unique, varchar(255))
ALTER TABLE "tenants" ADD COLUMN "external_id" VARCHAR(255);
CREATE UNIQUE INDEX "tenants_external_id_key" ON "tenants"("external_id");

-- Add is_bootstrap column (non-null, default false)
ALTER TABLE "tenants" ADD COLUMN "is_bootstrap" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing non-bootstrap, non-orphan tenants had id = IdP claim value.
-- tenant_usr_* (slug: u-*) are Phase 7 orphan-resolution tenants — exclude them.
UPDATE "tenants" SET "external_id" = "id"
  WHERE "slug" NOT LIKE 'bootstrap-%'
    AND "slug" NOT LIKE 'u-%';

-- Backfill: mark existing bootstrap tenants
UPDATE "tenants" SET "is_bootstrap" = true
  WHERE "slug" LIKE 'bootstrap-%';
