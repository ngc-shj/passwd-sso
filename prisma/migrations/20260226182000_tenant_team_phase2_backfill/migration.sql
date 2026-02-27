-- Phase 2: backfill tenant_id and seed tenant_members (1 org = 1 tenant)

-- 1) Seed tenants for organizations missing tenant_id.
-- Initial mapping strategy: tenant.id = organization.id (deterministic, idempotent).
INSERT INTO "tenants" (
  "id",
  "name",
  "slug",
  "description",
  "created_at",
  "updated_at"
)
SELECT
  o."id",
  o."name",
  CONCAT('tenant-', o."slug"),
  o."description",
  o."created_at",
  NOW()
FROM "organizations" o
LEFT JOIN "tenants" t
  ON t."id" = o."id"
WHERE o."tenant_id" IS NULL
  AND t."id" IS NULL;

-- 2) Backfill organizations.tenant_id.
UPDATE "organizations" o
SET
  "tenant_id" = o."id",
  "updated_at" = NOW()
WHERE o."tenant_id" IS NULL;

-- 3) Backfill SCIM tables tenant_id from organizations.
UPDATE "scim_tokens" st
SET "tenant_id" = o."tenant_id"
FROM "organizations" o
WHERE st."org_id" = o."id"
  AND st."tenant_id" IS NULL
  AND o."tenant_id" IS NOT NULL;

UPDATE "scim_external_mappings" sem
SET "tenant_id" = o."tenant_id"
FROM "organizations" o
WHERE sem."org_id" = o."id"
  AND sem."tenant_id" IS NULL
  AND o."tenant_id" IS NOT NULL;

-- 4) Seed tenant_members from active org_members.
-- If multiple roles exist for same (tenant,user), keep strongest role:
-- OWNER > ADMIN > MEMBER.
WITH ranked_members AS (
  SELECT
    o."tenant_id" AS tenant_id,
    om."user_id" AS user_id,
    CASE
      WHEN om."role" = 'OWNER' THEN 'OWNER'::"TenantRole"
      WHEN om."role" = 'ADMIN' THEN 'ADMIN'::"TenantRole"
      ELSE 'MEMBER'::"TenantRole"
    END AS role,
    ROW_NUMBER() OVER (
      PARTITION BY o."tenant_id", om."user_id"
      ORDER BY
        CASE
          WHEN om."role" = 'OWNER' THEN 3
          WHEN om."role" = 'ADMIN' THEN 2
          ELSE 1
        END DESC,
        om."created_at" ASC
    ) AS rn
  FROM "org_members" om
  INNER JOIN "organizations" o
    ON o."id" = om."org_id"
  WHERE o."tenant_id" IS NOT NULL
    AND om."deactivated_at" IS NULL
)
INSERT INTO "tenant_members" (
  "id",
  "tenant_id",
  "user_id",
  "role",
  "created_at",
  "updated_at"
)
SELECT
  CONCAT('tm_', MD5(rm.tenant_id || ':' || rm.user_id)),
  rm.tenant_id,
  rm.user_id,
  rm.role,
  NOW(),
  NOW()
FROM ranked_members rm
WHERE rm.rn = 1
ON CONFLICT ("tenant_id", "user_id")
DO UPDATE SET
  "role" = EXCLUDED."role",
  "updated_at" = NOW();
