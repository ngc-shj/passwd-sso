-- Reconcile pre-existing drift between the hand-written
-- 20260522000100_access_request_requester migration and schema.prisma.
--
-- That migration declared the requester foreign keys with custom constraint
-- names (..._requester_user_fk / ..._requester_sa_fk) and ON DELETE SET NULL but
-- omitted ON UPDATE CASCADE, and the audit_chain_anchors.prev_hash default was not
-- present in migration history. schema.prisma (the source of truth) expects the
-- Prisma default constraint/index names, ON DELETE SET NULL ON UPDATE CASCADE, and
-- a prev_hash default of '\x00'. As a result every database built from migrations
-- drifted permanently from schema.prisma. This aligns the three objects so
-- `prisma migrate dev` is clean without resetting existing data.

ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_requester_user_fk";
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_requester_sa_fk";
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_service_account_id_fkey"
  FOREIGN KEY ("requester_service_account_id") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER INDEX "access_requests_requester_sa_id_idx" RENAME TO "access_requests_requester_service_account_id_idx";

ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;
