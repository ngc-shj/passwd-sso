BEGIN;

-- containment-followups C1 (K5). Who created an audit delivery target, so
-- member containment can list and deactivate a member's targets. No FK: the
-- value outlives the user row. NULL means a target created before this column
-- (or one no audit record attributes); containment does not cover it. No
-- automatic pause on departure (owner decision): it would cut the tenant's
-- security monitoring.
ALTER TABLE "audit_delivery_targets" ADD COLUMN "created_by_id" UUID;

-- No new grant: passwd_app and passwd_outbox_worker hold table-level grants on
-- audit_delivery_targets.

-- Backfill: the creator is the latest AUDIT_DELIVERY_TARGET_CREATE (human
-- actor, TENANT scope, same tenant) naming the target in audit_logs, else a
-- not-yet-drained audit_outbox row. A target with neither stays NULL.
--
-- All three tables are under FORCE RLS and the RDS migrate role is NOSUPERUSER
-- NOBYPASSRLS, so without a bypass this sees no rows there. The block grants
-- itself exactly these tables, transaction-locally, and restores the previous
-- settings after (see 20261116300100). app.tenant_id is set to the nil UUID so
-- the policies' tenant arm casts cleanly. The outbox arm casts the payload's
-- userId only when it is a canonical uuid, so a malformed row leaves the
-- target NULL instead of aborting the migration.
-- BEGIN BACKFILL audit-delivery-target-creator
DO $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_from_logs integer;
  v_from_outbox integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables', 'audit_delivery_targets,audit_logs,audit_outbox', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  UPDATE audit_delivery_targets t
     SET created_by_id = (
           SELECT al.user_id
             FROM audit_logs al
            WHERE al.action = 'AUDIT_DELIVERY_TARGET_CREATE'
              AND al.scope = 'TENANT'
              AND al.actor_type = 'HUMAN'
              AND al.tenant_id = t.tenant_id
              AND al.metadata->>'targetId' = t.id::text
            ORDER BY al.created_at DESC
            LIMIT 1)
   WHERE t.created_by_id IS NULL
     AND EXISTS (
           SELECT 1
             FROM audit_logs al
            WHERE al.action = 'AUDIT_DELIVERY_TARGET_CREATE'
              AND al.scope = 'TENANT'
              AND al.actor_type = 'HUMAN'
              AND al.tenant_id = t.tenant_id
              AND al.metadata->>'targetId' = t.id::text);
  GET DIAGNOSTICS v_from_logs = ROW_COUNT;

  UPDATE audit_delivery_targets t
     SET created_by_id = (
           SELECT (o.payload->>'userId')::uuid
             FROM audit_outbox o
            WHERE o.status IN ('PENDING', 'PROCESSING', 'FAILED')
              AND o.tenant_id = t.tenant_id
              AND o.payload->>'action' = 'AUDIT_DELIVERY_TARGET_CREATE'
              AND o.payload->>'scope' = 'TENANT'
              AND o.payload->>'actorType' = 'HUMAN'
              AND o.payload->'metadata'->>'targetId' = t.id::text
              AND o.payload->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ORDER BY o.created_at DESC
            LIMIT 1)
   WHERE t.created_by_id IS NULL
     AND EXISTS (
           SELECT 1
             FROM audit_outbox o
            WHERE o.status IN ('PENDING', 'PROCESSING', 'FAILED')
              AND o.tenant_id = t.tenant_id
              AND o.payload->>'action' = 'AUDIT_DELIVERY_TARGET_CREATE'
              AND o.payload->>'scope' = 'TENANT'
              AND o.payload->>'actorType' = 'HUMAN'
              AND o.payload->'metadata'->>'targetId' = t.id::text
              AND o.payload->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  GET DIAGNOSTICS v_from_outbox = ROW_COUNT;
  RAISE NOTICE 'audit-delivery-target-creator backfill: % target(s) attributed from audit_logs, % from audit_outbox', v_from_logs, v_from_outbox;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$$;
-- END BACKFILL audit-delivery-target-creator

COMMIT;
