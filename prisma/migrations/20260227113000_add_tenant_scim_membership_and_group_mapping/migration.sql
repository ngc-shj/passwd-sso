-- Tenant-scoped SCIM foundation:
-- 1) Add lifecycle fields to tenant_members
-- 2) Add explicit group->(team,role) mapping table

-- 1) Tenant member lifecycle fields
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProvisioningSource') THEN
    CREATE TYPE "ProvisioningSource" AS ENUM ('MANUAL', 'SCIM');
  END IF;
END $$;

ALTER TABLE "tenant_members"
  ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "scim_managed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "provisioning_source" "ProvisioningSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "last_scim_synced_at" TIMESTAMP(3);

-- 2) Explicit tenant-scoped SCIM group mapping
CREATE TABLE IF NOT EXISTS "scim_group_mappings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "external_group_id" TEXT NOT NULL,
  "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scim_group_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_group_mappings_tenant_id_external_group_id_key"
  ON "scim_group_mappings"("tenant_id", "external_group_id");
CREATE INDEX IF NOT EXISTS "scim_group_mappings_tenant_id_idx"
  ON "scim_group_mappings"("tenant_id");
CREATE INDEX IF NOT EXISTS "scim_group_mappings_team_id_idx"
  ON "scim_group_mappings"("team_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scim_group_mappings_tenant_id_fkey'
  ) THEN
    ALTER TABLE "scim_group_mappings"
      ADD CONSTRAINT "scim_group_mappings_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scim_group_mappings_team_id_fkey'
  ) THEN
    ALTER TABLE "scim_group_mappings"
      ADD CONSTRAINT "scim_group_mappings_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS for new tenant-scoped table
ALTER TABLE "scim_group_mappings" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scim_group_mappings_tenant_isolation ON "scim_group_mappings";
CREATE POLICY scim_group_mappings_tenant_isolation ON "scim_group_mappings"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- Reuse existing tenant_id trigger guard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_tenant_id_from_context') THEN
    DROP TRIGGER IF EXISTS trg_enforce_tenant_id_scim_group_mappings ON "scim_group_mappings";
    CREATE TRIGGER trg_enforce_tenant_id_scim_group_mappings
    BEFORE INSERT OR UPDATE ON "scim_group_mappings"
    FOR EACH ROW EXECUTE FUNCTION enforce_tenant_id_from_context();
  ELSE
    RAISE NOTICE 'skip tenant trigger: enforce_tenant_id_from_context() is not available in this environment';
  END IF;
END $$;
