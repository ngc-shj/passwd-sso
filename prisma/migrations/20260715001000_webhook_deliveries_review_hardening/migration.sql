-- Post-merge security-review hardening for the durable webhook delivery queue.

-- F3: schema-enforce the scope/team_id invariant so an inconsistent enqueue
-- (or an out-of-band write) cannot produce a TEAM row without a team_id or a
-- TENANT row carrying one. The delivery worker already filters TEAM subscribers
-- by (tenantId, teamId); this CHECK is the storage-layer backstop.
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_scope_team_id_ck"
  CHECK (
    (scope = 'TEAM'   AND team_id IS NOT NULL) OR
    (scope = 'TENANT' AND team_id IS NULL)
  );

-- F4: narrow the worker's UPDATE on the webhook config tables to the health
-- columns only. The prior table-wide UPDATE let passwd_outbox_worker rewrite the
-- destination url, events filter, encrypted secret, master_key_version, and
-- tenant_id/team_id. The worker only ever touches the delivery health fields
-- (fail_count, last_error, last_failed_at, last_delivered_at, is_active) plus the
-- Prisma-managed updated_at. REVOKE the broad grant, then GRANT column-scoped.
REVOKE UPDATE ON TABLE "tenant_webhooks" FROM passwd_outbox_worker;
REVOKE UPDATE ON TABLE "team_webhooks"   FROM passwd_outbox_worker;

GRANT UPDATE (fail_count, last_error, last_failed_at, last_delivered_at, is_active, updated_at)
  ON TABLE "tenant_webhooks" TO passwd_outbox_worker;
GRANT UPDATE (fail_count, last_error, last_failed_at, last_delivered_at, is_active, updated_at)
  ON TABLE "team_webhooks" TO passwd_outbox_worker;
