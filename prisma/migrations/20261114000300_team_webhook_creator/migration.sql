BEGIN;

-- departed-member-leaked-authority C6. Who created a team webhook, so delivery
-- can require the creator's CURRENT authority in the webhook's team. No FK: the
-- value outlives the user row, and delivery checks live membership instead.
-- NULL means a webhook created before this column (legacy), which keeps
-- delivering. No database guard: a CHECK would also run on every UPDATE of a
-- legacy NULL row, including the worker's health updates.
ALTER TABLE "team_webhooks" ADD COLUMN "created_by_id" UUID;

-- The delivery worker reads the creator's team membership in
-- resolveWebhookSubscribers: exactly these columns, no table-level SELECT.
GRANT SELECT ("id", "team_id", "user_id", "role", "deactivated_at") ON TABLE "team_members" TO passwd_outbox_worker;

-- Backfill: the creator is the latest WEBHOOK_CREATE (human actor, TEAM scope,
-- same tenant and team) naming the webhook in audit_logs, else a not-yet-drained
-- audit_outbox row. A webhook with neither stays NULL (legacy).
--
-- All three tables are under FORCE RLS and the RDS migrate role is NOSUPERUSER
-- NOBYPASSRLS, so without a bypass this sees no rows there. The block grants
-- itself exactly these tables, transaction-locally, and restores the previous
-- settings after (see 20261109162613). app.tenant_id is set to the nil UUID so
-- the policies' tenant arm casts cleanly.
-- BEGIN BACKFILL team-webhook-creator
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
  PERFORM set_config('app.bypass_tables', 'team_webhooks,audit_logs,audit_outbox', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  UPDATE team_webhooks w
     SET created_by_id = (
           SELECT al.user_id
             FROM audit_logs al
            WHERE al.action = 'WEBHOOK_CREATE'
              AND al.scope = 'TEAM'
              AND al.actor_type = 'HUMAN'
              AND al.tenant_id = w.tenant_id
              AND al.team_id = w.team_id
              AND al.metadata->>'webhookId' = w.id::text
            ORDER BY al.created_at DESC
            LIMIT 1)
   WHERE w.created_by_id IS NULL
     AND EXISTS (
           SELECT 1
             FROM audit_logs al
            WHERE al.action = 'WEBHOOK_CREATE'
              AND al.scope = 'TEAM'
              AND al.actor_type = 'HUMAN'
              AND al.tenant_id = w.tenant_id
              AND al.team_id = w.team_id
              AND al.metadata->>'webhookId' = w.id::text);
  GET DIAGNOSTICS v_from_logs = ROW_COUNT;

  UPDATE team_webhooks w
     SET created_by_id = (
           SELECT (o.payload->>'userId')::uuid
             FROM audit_outbox o
            WHERE o.status IN ('PENDING', 'PROCESSING', 'FAILED')
              AND o.tenant_id = w.tenant_id
              AND o.payload->>'action' = 'WEBHOOK_CREATE'
              AND o.payload->>'scope' = 'TEAM'
              AND o.payload->>'actorType' = 'HUMAN'
              AND o.payload->>'teamId' = w.team_id::text
              AND o.payload->'metadata'->>'webhookId' = w.id::text
            ORDER BY o.created_at DESC
            LIMIT 1)
   WHERE w.created_by_id IS NULL
     AND EXISTS (
           SELECT 1
             FROM audit_outbox o
            WHERE o.status IN ('PENDING', 'PROCESSING', 'FAILED')
              AND o.tenant_id = w.tenant_id
              AND o.payload->>'action' = 'WEBHOOK_CREATE'
              AND o.payload->>'scope' = 'TEAM'
              AND o.payload->>'actorType' = 'HUMAN'
              AND o.payload->>'teamId' = w.team_id::text
              AND o.payload->'metadata'->>'webhookId' = w.id::text);
  GET DIAGNOSTICS v_from_outbox = ROW_COUNT;
  RAISE NOTICE 'team-webhook-creator backfill: % webhook(s) attributed from audit_logs, % from audit_outbox', v_from_logs, v_from_outbox;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$$;
-- END BACKFILL team-webhook-creator

COMMIT;
