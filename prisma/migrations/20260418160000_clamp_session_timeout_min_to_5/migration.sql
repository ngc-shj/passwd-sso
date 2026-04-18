-- Clamp any tenant row with a session/extension timeout field below the new
-- 5-minute minimum. The old minimum was 1; after the
-- unify-session-timeout-policy feedback, 1-min values proved impractical for
-- Chrome MV3 service workers (alarms miss, SW dormancy) and inflate audit
-- churn without security benefit.
--
-- This migration is idempotent and safe to run on tenants that already comply.

UPDATE "tenants"
   SET "session_idle_timeout_minutes" = 5
 WHERE "session_idle_timeout_minutes" < 5;

UPDATE "tenants"
   SET "session_absolute_timeout_minutes" = 5
 WHERE "session_absolute_timeout_minutes" < 5;

UPDATE "tenants"
   SET "extension_token_idle_timeout_minutes" = 5
 WHERE "extension_token_idle_timeout_minutes" < 5;

UPDATE "tenants"
   SET "extension_token_absolute_timeout_minutes" = 5
 WHERE "extension_token_absolute_timeout_minutes" < 5;

UPDATE "tenants"
   SET "vault_auto_lock_minutes" = 5
 WHERE "vault_auto_lock_minutes" IS NOT NULL AND "vault_auto_lock_minutes" < 5;

-- Team policy overrides (nullable — NULL means inherit tenant). Same floor.
UPDATE "team_policies"
   SET "session_idle_timeout_minutes" = 5
 WHERE "session_idle_timeout_minutes" IS NOT NULL AND "session_idle_timeout_minutes" < 5;

UPDATE "team_policies"
   SET "session_absolute_timeout_minutes" = 5
 WHERE "session_absolute_timeout_minutes" IS NOT NULL AND "session_absolute_timeout_minutes" < 5;
