-- Tenant-level Vault Reset: schema + RLS + enum additions

-- 1. Add new enum values
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_VAULT_RESET_REVOKE';
ALTER TYPE "AuditScope" ADD VALUE 'TENANT';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_REVOKED';

-- 2. Make team_id optional on admin_vault_resets
ALTER TABLE "admin_vault_resets" ALTER COLUMN "team_id" DROP NOT NULL;

-- 3. Change FK from CASCADE to SET NULL (team deletion should not delete reset history)
ALTER TABLE "admin_vault_resets" DROP CONSTRAINT "admin_vault_resets_team_id_fkey";
ALTER TABLE "admin_vault_resets" ADD CONSTRAINT "admin_vault_resets_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Enable RLS on admin_vault_resets (was missing)
ALTER TABLE "admin_vault_resets" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_vault_resets_tenant_isolation ON "admin_vault_resets";
CREATE POLICY admin_vault_resets_tenant_isolation ON "admin_vault_resets"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );

-- 5. Revoke all existing pending tokens (clean slate for tenant migration)
UPDATE "admin_vault_resets"
SET "revoked_at" = NOW()
WHERE "executed_at" IS NULL AND "revoked_at" IS NULL;
