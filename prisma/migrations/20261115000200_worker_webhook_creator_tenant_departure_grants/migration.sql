BEGIN;

-- leftover-team-actor-authority C4. resolveWebhookSubscribers also refuses a
-- creator who left the tenant after joining the team, so the delivery worker
-- reads the creator's tenant rows (readTenantRows) and the admission times on
-- team_members. Exactly the columns its statements issue, selected or
-- filtered on (Prisma adds "id" to the tenant_members select; the departures
-- table is keyed by (tenant_id, user_id)), no table-level SELECT.
GRANT SELECT ("admitted_at", "created_at") ON TABLE "team_members" TO passwd_outbox_worker;
GRANT SELECT ("id", "tenant_id", "user_id", "role", "deactivated_at") ON TABLE "tenant_members" TO passwd_outbox_worker;
GRANT SELECT ("tenant_id", "user_id", "departed_at") ON TABLE "tenant_member_departures" TO passwd_outbox_worker;

COMMIT;
