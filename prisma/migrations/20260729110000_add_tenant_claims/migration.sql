-- SSO tenant claim registry (C1). tenant_claims becomes the single
-- claim->tenant resolution table; Tenant.externalId keeps its unique index
-- and keeps being written in this release (D1 — expand-and-contract release
-- 1). Wrapped in BEGIN/COMMIT because this migration has more than one DDL
-- statement (check-migration-transaction.mjs requires it once ddlCount > 1):
-- a partial apply here would leave a schema the old, still-live code cannot
-- read correctly.
BEGIN;

-- CreateTable
CREATE TABLE "tenant_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "claim" VARCHAR(255) NOT NULL,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_claims_claim_key" ON "tenant_claims"("claim");

-- CreateIndex
CREATE INDEX "tenant_claims_tenant_id_idx" ON "tenant_claims"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_claims" ADD CONSTRAINT "tenant_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Normalisation CHECK: the stored form must already be the output of
-- normalizeTenantClaim (trim + lowercase), restricted to printable ASCII.
-- Use lower(claim COLLATE "C"), not bare lower(claim) — lower() is
-- LC_CTYPE-dependent and would accept two spellings of one claim under some
-- ctypes (round-4 M23 / round-5 D3). Without the case fold, the UNIQUE index
-- is case-sensitive and "Alias.Example" / "alias.example" are two rows
-- resolving to two tenants.
ALTER TABLE "tenant_claims" ADD CONSTRAINT "tenant_claims_claim_normalized"
  CHECK (claim = lower(claim COLLATE "C") AND claim = btrim(claim) AND claim <> '' AND claim !~ '[^\x20-\x7E]');

-- Backfill: one row per existing tenants.external_id, so a deployment
-- resolving sign-in through that column keeps working once
-- resolveTenantByClaim starts reading tenant_claims. Copied verbatim from
-- scripts/lib/tenant-claim-backfill.sql (Prisma has no @import); a drift
-- test asserts the two have not diverged.
--
-- Every side of a normalisation collision is excluded, not just the losers
-- (round-1 M3): those tenants are distinct today, so handing the claim to one
-- of them would place the others' new members into the winner's tenant. With
-- no row for any of them, release 1's external_id fallback preserves today's
-- resolution for all sides.
INSERT INTO tenant_claims (id, tenant_id, claim, created_by)
SELECT gen_random_uuid(), id, lower(btrim(external_id) COLLATE "C"), 'backfill'
FROM tenants
WHERE external_id IS NOT NULL
  AND btrim(external_id) <> ''
  AND external_id !~ '[^\x20-\x7E]'
  AND lower(btrim(external_id) COLLATE "C") NOT IN (
    SELECT lower(btrim(external_id) COLLATE "C") FROM tenants
     WHERE external_id IS NOT NULL AND btrim(external_id) <> '' AND external_id !~ '[^\x20-\x7E]'
     GROUP BY 1 HAVING count(*) > 1)
ON CONFLICT (claim) DO NOTHING;

-- Tenant-RLS isolation: rows are visible to a tenant's app session only
-- (or when app.bypass_rls is 'on' for cross-tenant flows). No
-- `DROP POLICY IF EXISTS` prefix — the table is new in this migration, so
-- there is nothing to drop, and check-destructive-migration.mjs's DROP
-- matcher fires on any DROP outside {DEFAULT,NOT,IDENTITY,EXPRESSION} with
-- no baselinable route for a new migration.
ALTER TABLE "tenant_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_claims_tenant_isolation ON "tenant_claims"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- Grant app role access. Guarded with IF EXISTS because passwd_app is
-- created by infra/initdb in dev and by a post-migration bootstrap step in
-- CI (ci-integration.yml). Redundant given the default ACL
-- (DEFAULTACL:passwd_user public r passwd_app=arwd/passwd_user) and included
-- anyway because it is the convention followed by every other new-table
-- migration.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_claims TO passwd_app;
  END IF;
END $$;

COMMIT;
