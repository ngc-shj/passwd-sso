-- Flip mcp_refresh_tokens.family_created_at to NOT NULL now that
-- createRefreshToken (initial issue) and exchangeRefreshToken (rotation,
-- carries the family birth time forward) always populate it.
-- Pre-migration rows were backfilled (family_created_at = MIN(created_at) per
-- family) in the additive 20260629000000 migration.

-- Defensive backfill for any rows created between the two migrations
-- (e.g. in a running environment):
UPDATE "mcp_refresh_tokens" AS t
   SET "family_created_at" = sub.min_created
  FROM (
    SELECT "family_id", MIN("created_at") AS min_created
      FROM "mcp_refresh_tokens"
     GROUP BY "family_id"
  ) AS sub
 WHERE t."family_id" = sub."family_id"
   AND t."family_created_at" IS NULL;

ALTER TABLE "mcp_refresh_tokens"
  ALTER COLUMN "family_created_at" SET NOT NULL,
  ALTER COLUMN "family_created_at" SET DEFAULT NOW();
