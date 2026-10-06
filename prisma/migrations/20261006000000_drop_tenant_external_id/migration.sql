BEGIN;

-- The claim registry (tenant_claims) is the only SSO tenant key. external_id was
-- the pre-registry key and the release-1 fallback for it; nothing reads or
-- writes it after this change.
--
-- Contract without an expand phase: code from before this migration still
-- writes external_id and fails against the new schema until it is replaced.
-- Accepted because no production deployment exists (see
-- docs/archive/review/sso-drop-tenant-external-id-plan.md, VE1).
DROP INDEX IF EXISTS "tenants_external_id_key";
ALTER TABLE "tenants" DROP COLUMN "external_id";

COMMIT;
