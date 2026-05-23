-- A04-4: master-key rotation dual-approval
-- Adds the MasterKeyRotation table (state machine for initiate/approve/execute/revoke),
-- four new AuditAction enum values for the audit chain, and one NotificationType value
-- for the OWNER/ADMIN fan-out on initiate. Includes the GRANT block + RLS policy
-- per the operator_tokens migration template (passwd_app least-privilege + tenant_isolation).

-- AlterEnum — AuditAction
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MASTER_KEY_ROTATION_INITIATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MASTER_KEY_ROTATION_APPROVE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MASTER_KEY_ROTATION_EXECUTE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MASTER_KEY_ROTATION_REVOKE';

-- AlterEnum — NotificationType
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MASTER_KEY_ROTATION_PENDING_APPROVAL';

-- CreateTable
CREATE TABLE "master_key_rotations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "initiated_by_id" UUID,
    "initiated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_version" INTEGER NOT NULL,
    "revoke_shares" BOOLEAN NOT NULL DEFAULT true,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "executed_at" TIMESTAMPTZ(3),
    "executed_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "reason" VARCHAR(500),
    "revoked_shares" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_key_rotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_key_rotations_target_version_executed_at_revoked_at_idx"
  ON "master_key_rotations"("target_version", "executed_at", "revoked_at");
CREATE INDEX "master_key_rotations_initiated_by_id_approved_at_idx"
  ON "master_key_rotations"("initiated_by_id", "approved_at");
CREATE INDEX "master_key_rotations_tenant_id_idx"
  ON "master_key_rotations"("tenant_id");

-- AddForeignKey
ALTER TABLE "master_key_rotations" ADD CONSTRAINT "master_key_rotations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "master_key_rotations" ADD CONSTRAINT "master_key_rotations_initiated_by_id_fkey"
  FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "master_key_rotations" ADD CONSTRAINT "master_key_rotations_approved_by_id_fkey"
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "master_key_rotations" ADD CONSTRAINT "master_key_rotations_executed_by_id_fkey"
  FOREIGN KEY ("executed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "master_key_rotations" ADD CONSTRAINT "master_key_rotations_revoked_by_id_fkey"
  FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Grant app role access. Guarded with IF EXISTS because passwd_app is created by
-- infra/initdb in dev and by a post-migration bootstrap step in CI; the migration
-- must not assume the role pre-exists.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE master_key_rotations TO passwd_app;
  END IF;
END $$;

-- Tenant-RLS isolation: rows are visible to the binding tenant's app session only
-- (or when app.bypass_rls is 'on' for system-maintenance flows).
ALTER TABLE "master_key_rotations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "master_key_rotations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS master_key_rotations_tenant_isolation ON "master_key_rotations";
CREATE POLICY master_key_rotations_tenant_isolation ON "master_key_rotations"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
