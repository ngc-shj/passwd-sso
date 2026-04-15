-- Drop FK audit_deliveries.outbox_id -> audit_outbox.id to decouple delivery
-- history from outbox retention lifecycle. Delivery records (SIEM fan-out
-- attempts) should persist after the outbox row is purged, matching the
-- audit_logs.user_id FK drop pattern in the previous migration.
-- See docs/archive/review/audit-path-unification-plan.md (Considerations).

ALTER TABLE audit_deliveries DROP CONSTRAINT audit_deliveries_outbox_id_fkey;
