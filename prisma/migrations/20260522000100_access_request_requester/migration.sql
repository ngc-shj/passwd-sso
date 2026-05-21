-- C8 / OWASP A01-1: track who created each access request so approve
-- can reject self-approval. Partitioned by actor type (human vs SA)
-- because SA tokens don't have a userId.
ALTER TABLE "access_requests"
  ADD COLUMN "requester_user_id" UUID,
  ADD COLUMN "requester_service_account_id" UUID,
  ADD CONSTRAINT "access_requests_requester_user_fk"
    FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "access_requests_requester_sa_fk"
    FOREIGN KEY ("requester_service_account_id") REFERENCES "service_accounts"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "access_requests_requester_xor"
    CHECK (
      ("requester_user_id" IS NOT NULL)::int +
      ("requester_service_account_id" IS NOT NULL)::int <= 1
    );

-- Pre-1.0 cleanup: existing PENDING rows lacking requester metadata
-- transition to EXPIRED (no CANCELLED in the AccessRequestStatus enum;
-- EXPIRED is the closest semantic match — request can no longer be
-- acted on because it lacks the requester provenance the new approve
-- gate requires). Approved/denied rows are historical; leave them.
UPDATE "access_requests"
  SET "status" = 'EXPIRED'
  WHERE "status" = 'PENDING'
    AND "requester_user_id" IS NULL
    AND "requester_service_account_id" IS NULL;

CREATE INDEX "access_requests_requester_user_id_idx"
  ON "access_requests"("requester_user_id")
  WHERE "requester_user_id" IS NOT NULL;
CREATE INDEX "access_requests_requester_sa_id_idx"
  ON "access_requests"("requester_service_account_id")
  WHERE "requester_service_account_id" IS NOT NULL;
