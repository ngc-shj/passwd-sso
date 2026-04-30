-- Admin Vault Reset Dual-Approval: data backfill (S11 + S17 fixes).
-- This migration runs AFTER the schema columns and the NotificationType ALTER.
--
-- Strategy (NFR3 — option c, correct-by-construction):
--   1. Auto-revoke in-flight rows so their email-link tokens cannot be
--      redeemed post-deploy under the old single-admin policy.
--   2. Populate target_email_at_initiate for ALL rows so a future
--      ALTER TO NOT NULL can run without orphans.
--   3. Emit a SYSTEM-actor ADMIN_VAULT_RESET_REVOKE audit row per
--      auto-revoked legacy row (S17 fix — tenant observability).
--
-- The order matters: revoke first so step 3 sees the new revoked_at value.

-- 1. Auto-revoke in-flight legacy rows
UPDATE "admin_vault_resets"
   SET "revoked_at" = "created_at"
 WHERE "executed_at" IS NULL
   AND "revoked_at" IS NULL
   AND "expires_at" > now();

-- 2. Populate target_email_at_initiate for ALL existing rows
UPDATE "admin_vault_resets" r
   SET "target_email_at_initiate" = u."email"
  FROM "users" u
 WHERE r."target_user_id" = u."id"
   AND r."target_email_at_initiate" IS NULL;

-- 3. Emit SYSTEM-actor audit rows for the auto-revoked legacy rows
--    (only rows we just touched — distinguished by revoked_at = created_at).
INSERT INTO "audit_logs" (
  "id", "tenant_id", "scope", "actor_type", "user_id", "action",
  "target_type", "target_id", "metadata", "created_at"
)
SELECT
  gen_random_uuid(),
  r."tenant_id",
  'TENANT',
  'SYSTEM',
  r."initiated_by_id",
  'ADMIN_VAULT_RESET_REVOKE',
  'User',
  r."target_user_id",
  jsonb_build_object(
    'resetId', r."id",
    'reason', 'dual_approval_migration',
    'initiatedById', r."initiated_by_id"
  ),
  now()
FROM "admin_vault_resets" r
WHERE r."revoked_at" = r."created_at"
  AND r."executed_at" IS NULL;
