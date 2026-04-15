-- Audit path unification: sentinel UUID + ANONYMOUS actor type
-- See docs/archive/review/audit-path-unification-plan.md

-- 1. Add ANONYMOUS actor type.
-- Note: ALTER TYPE ADD VALUE works in a transaction block on PostgreSQL 12+,
-- which is our minimum. If this ever fails on an older engine, split into a
-- standalone migration file.
ALTER TYPE "ActorType" ADD VALUE 'ANONYMOUS';

-- 2. Pre-migration safety: abort if any non-SYSTEM NULL userId rows exist.
--    This compares against the pre-existing 'SYSTEM' enum value (not the
--    newly-added 'ANONYMOUS'), so it is safe in the same transaction.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM audit_logs
  WHERE user_id IS NULL AND actor_type != 'SYSTEM';
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % audit_logs rows have NULL user_id with non-SYSTEM actor_type. Manual cleanup required.', orphan_count;
  END IF;
END $$;

-- 3. Drop FK to users FIRST. The backfill in step 5 writes SYSTEM_ACTOR_ID
--    which is a sentinel UUID not present in the users table — so the FK
--    must be dropped before the UPDATE, or the UPDATE would fail with
--    foreign_key_violation (SQLSTATE 23503).
--    Note: audit_logs_outbox_id_actor_type_check is KEPT — it still
--    limits direct writes (outbox_id IS NULL) to SYSTEM actor only.
-- NOTE: dropping this FK decouples audit_logs from users.id, strengthening
-- audit trail preservation (SOC 2 / ISO 27001) but removing automatic
-- cleanup on user deletion. GDPR Art.17 right-to-be-forgotten requires a
-- separate PII redaction job; see docs/archive/review/audit-path-unification-plan.md
-- §Considerations ▸ GDPR for the follow-up commitment.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;

-- 4. Drop CHECK that allowed NULL userId for SYSTEM. Must happen before the
--    NOT NULL set (step 6), and is independent of the backfill.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_system_actor_user_id_check;

-- 5. Backfill all NULL userId rows with SYSTEM_ACTOR_ID sentinel.
--    FK already dropped (step 3), so the sentinel UUID is accepted despite
--    not existing in the users table.
UPDATE audit_logs
SET user_id = '00000000-0000-4000-8000-000000000001'::uuid
WHERE user_id IS NULL;

-- 6. Restore NOT NULL (sentinels fill the previously-NULL slot).
ALTER TABLE audit_logs ALTER COLUMN user_id SET NOT NULL;
