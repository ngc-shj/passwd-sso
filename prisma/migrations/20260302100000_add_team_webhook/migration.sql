-- AlterEnum (add new AuditAction values)
ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_LOG_DOWNLOAD';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_DELIVERY_FAILED';

-- CreateTable
CREATE TABLE "team_webhooks" (
  "id"                TEXT NOT NULL,
  "team_id"           TEXT NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "url"               VARCHAR(2048) NOT NULL,
  "secret_encrypted"  TEXT NOT NULL,
  "secret_iv"         VARCHAR(24) NOT NULL,
  "secret_auth_tag"   VARCHAR(32) NOT NULL,
  "master_key_version" INTEGER NOT NULL DEFAULT 1,
  "events"            TEXT[],
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "last_error"        TEXT,
  "fail_count"        INTEGER NOT NULL DEFAULT 0,
  "last_delivered_at" TIMESTAMPTZ(3),
  "last_failed_at"    TIMESTAMPTZ(3),
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "team_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_webhooks_team_id_idx"
  ON "team_webhooks"("team_id");

CREATE INDEX "team_webhooks_tenant_id_idx"
  ON "team_webhooks"("tenant_id");

-- AddForeignKey
ALTER TABLE "team_webhooks"
  ADD CONSTRAINT "team_webhooks_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_webhooks"
  ADD CONSTRAINT "team_webhooks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- EnableRowLevelSecurity
ALTER TABLE "team_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_webhooks" FORCE ROW LEVEL SECURITY;

-- CreatePolicy
DROP POLICY IF EXISTS team_webhooks_tenant_isolation ON "team_webhooks";
CREATE POLICY team_webhooks_tenant_isolation ON "team_webhooks"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)
  );
