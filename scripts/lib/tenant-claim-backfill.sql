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
-- Normalisation collisions exclude EVERY side, not just the losers (round-1
-- M3). Tenants whose external_id values fold to one claim are distinct today
-- — the pre-PR resolver matched external_id exactly — so letting one of them
-- win the claim row would silently place the others' NEW members into the
-- winner's tenant, a cross-tenant placement that raises no error. With no
-- claim row for any of them, the release-1 external_id fallback keeps
-- resolving each one exactly as it does today, and the pre-flight query (C12)
-- puts the operator decision before SC10 removes that fallback.
--
-- ON CONFLICT DO NOTHING rather than aborting the migration: the exclusion
-- above rules out collisions WITHIN this statement, so what remains is a
-- claim row that already exists (re-run, or registered by sign-in between
-- migration and a manual re-backfill). Skipping it is safer than aborting
-- prisma migrate deploy on a foreign deployment with no remediation guidance.
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
