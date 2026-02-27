-- Phase: rename physical table name from organizations to teams.
-- Keep Prisma model name Organization for compatibility in application code.

ALTER TABLE "organizations" RENAME TO "teams";

ALTER INDEX IF EXISTS "organizations_pkey" RENAME TO "teams_pkey";
ALTER INDEX IF EXISTS "organizations_slug_key" RENAME TO "teams_slug_key";
ALTER INDEX IF EXISTS "organizations_tenant_id_idx" RENAME TO "teams_tenant_id_idx";

ALTER TABLE "teams"
  RENAME CONSTRAINT "organizations_tenant_id_fkey" TO "teams_tenant_id_fkey";
