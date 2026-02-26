-- Validation pack for tenant/team migration Phase 2 backfill.
-- Expected: all result counts are 0.

-- 1) organizations without tenant_id
SELECT COUNT(*) AS organizations_without_tenant
FROM "organizations"
WHERE "tenant_id" IS NULL;

-- 2) SCIM tables without tenant_id
SELECT COUNT(*) AS scim_tokens_without_tenant
FROM "scim_tokens"
WHERE "tenant_id" IS NULL;

SELECT COUNT(*) AS scim_external_mappings_without_tenant
FROM "scim_external_mappings"
WHERE "tenant_id" IS NULL;

-- 3) orphan tenant_id references
SELECT COUNT(*) AS organizations_orphan_tenant
FROM "organizations" o
LEFT JOIN "tenants" t ON t."id" = o."tenant_id"
WHERE o."tenant_id" IS NOT NULL
  AND t."id" IS NULL;

SELECT COUNT(*) AS scim_tokens_orphan_tenant
FROM "scim_tokens" st
LEFT JOIN "tenants" t ON t."id" = st."tenant_id"
WHERE st."tenant_id" IS NOT NULL
  AND t."id" IS NULL;

SELECT COUNT(*) AS scim_external_mappings_orphan_tenant
FROM "scim_external_mappings" sem
LEFT JOIN "tenants" t ON t."id" = sem."tenant_id"
WHERE sem."tenant_id" IS NOT NULL
  AND t."id" IS NULL;

-- 4) duplicates under target tenant-scoped uniqueness
SELECT COUNT(*) AS dup_external_id_per_tenant
FROM (
  SELECT "tenant_id", "external_id", "resource_type", COUNT(*)
  FROM "scim_external_mappings"
  WHERE "tenant_id" IS NOT NULL
  GROUP BY 1, 2, 3
  HAVING COUNT(*) > 1
) x;

SELECT COUNT(*) AS dup_internal_id_per_tenant
FROM (
  SELECT "tenant_id", "internal_id", "resource_type", COUNT(*)
  FROM "scim_external_mappings"
  WHERE "tenant_id" IS NOT NULL
  GROUP BY 1, 2, 3
  HAVING COUNT(*) > 1
) x;
