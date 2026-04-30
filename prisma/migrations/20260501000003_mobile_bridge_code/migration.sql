-- iOS AutoFill MVP (Batch D-1): bridge code carrying PKCE/state/device-pubkey
-- state from `/api/mobile/authorize` to `/api/mobile/token`.
--
-- Distinct from extension_bridge_codes because the iOS flow binds additional
-- cryptographic material (PKCE challenge, Secure-Enclave device pubkey) that
-- the browser-extension flow does not carry. Single-use, 60s TTL.

-- CreateTable
CREATE TABLE "mobile_bridge_codes" (
    "id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" VARCHAR(64) NOT NULL,
    "code_challenge" VARCHAR(64) NOT NULL,
    "device_pubkey" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "mobile_bridge_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mobile_bridge_codes_code_hash_key" ON "mobile_bridge_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mobile_bridge_codes_user_id_idx" ON "mobile_bridge_codes"("user_id");

-- CreateIndex
CREATE INDEX "mobile_bridge_codes_tenant_id_idx" ON "mobile_bridge_codes"("tenant_id");

-- CreateIndex
CREATE INDEX "mobile_bridge_codes_expires_at_idx" ON "mobile_bridge_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "mobile_bridge_codes" ADD CONSTRAINT "mobile_bridge_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_bridge_codes" ADD CONSTRAINT "mobile_bridge_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Grant app role access (no DELETE — codes are consumed via UPDATE used_at, not removed).
-- Guarded with IF EXISTS because passwd_app is created by infra/initdb in dev
-- and by a post-migration bootstrap step in CI; the migration must not assume
-- the role pre-exists.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE mobile_bridge_codes TO passwd_app;
  END IF;
END $$;

-- Tenant-RLS isolation: rows are visible to a tenant's app session only
-- (or when app.bypass_rls is 'on' for cross-tenant flows like token issuance).
ALTER TABLE "mobile_bridge_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mobile_bridge_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mobile_bridge_codes_tenant_isolation ON "mobile_bridge_codes";
CREATE POLICY mobile_bridge_codes_tenant_isolation ON "mobile_bridge_codes"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
