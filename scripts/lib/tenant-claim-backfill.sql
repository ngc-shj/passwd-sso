-- SSO tenant claim registry backfill.
--
-- Populates tenant_claims from every existing tenants.external_id so
-- deployments that already resolved sign-in through that column keep working
-- once resolveTenantByClaim starts reading tenant_claims. Extracted to this
-- standalone file (Prisma has no @import) and copied verbatim into
-- prisma/migrations/<ts>_add_tenant_claims/migration.sql; a drift test
-- (src/__tests__/db-integration/tenant-claim.integration.test.ts) asserts the
-- two have not diverged, and executes this file directly against seeded rows.
--
-- Fold with lower(x COLLATE "C") — locale-independent — matching the CHECK
-- constraint in the migration; lower() alone is LC_CTYPE-dependent and would
-- fold differently under some collations than the application's normaliser.
-- The ASCII filter runs against the RAW external_id, not the folded output:
-- the Postgres fold of a non-ASCII input can itself be ASCII (e.g. 'İ' under
-- some ctypes), which would let a value through that the JS normaliser folds
-- differently — silently unresolvable at sign-in. Filtering the raw column
-- puts everything non-ASCII uniformly into the excluded set.
--
-- ON CONFLICT DO NOTHING rather than aborting the migration: two tenants
-- whose external_id normalises identically collide, and skipping the second
-- is safer than aborting prisma migrate deploy on a foreign deployment with
-- no remediation guidance. The pre-flight query (C12) surfaces both skipped
-- classes — non-ASCII and normalisation collisions — for operator review
-- before the upgrade.
INSERT INTO tenant_claims (id, tenant_id, claim, created_by)
SELECT gen_random_uuid(), id, lower(btrim(external_id) COLLATE "C"), 'backfill'
FROM tenants
WHERE external_id IS NOT NULL
  AND btrim(external_id) <> ''
  AND external_id !~ '[^\x20-\x7E]'
ON CONFLICT (claim) DO NOTHING;
