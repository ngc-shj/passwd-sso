-- Add mcp_refresh_tokens.family_created_at (additive, nullable) and backfill.
-- Step 1 of 2 (the flip to NOT NULL is 20260629000100). Mirrors the
-- ExtensionToken.family_created_at precedent (20260418042050 + 20260418144000),
-- but the backfill anchors each family to its EARLIEST row's created_at
-- (MIN(created_at) per family_id) — MCP families already exist with multiple
-- rotated rows, unlike the per-token extension_tokens backfill.

ALTER TABLE "mcp_refresh_tokens"
  ADD COLUMN "family_created_at" TIMESTAMPTZ(3);

UPDATE "mcp_refresh_tokens" AS t
   SET "family_created_at" = sub.min_created
  FROM (
    SELECT "family_id", MIN("created_at") AS min_created
      FROM "mcp_refresh_tokens"
     GROUP BY "family_id"
  ) AS sub
 WHERE t."family_id" = sub."family_id"
   AND t."family_created_at" IS NULL;
