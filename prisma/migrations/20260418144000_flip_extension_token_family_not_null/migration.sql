-- Flip extension_tokens.family_id and family_created_at to NOT NULL now that
-- issueExtensionToken + refresh route always populate these columns.
-- Pre-migration rows were backfilled (family_id = id, family_created_at = created_at)
-- in the additive 20260418042050_unify_session_timeout_policy migration.

-- Defensive backfill for any rows created between the two migrations
-- (e.g. in a running environment):
UPDATE "extension_tokens"
   SET "family_id" = "id"
 WHERE "family_id" IS NULL;
UPDATE "extension_tokens"
   SET "family_created_at" = "created_at"
 WHERE "family_created_at" IS NULL;

ALTER TABLE "extension_tokens"
  ALTER COLUMN "family_id" SET NOT NULL,
  ALTER COLUMN "family_created_at" SET NOT NULL,
  ALTER COLUMN "family_created_at" SET DEFAULT NOW();
