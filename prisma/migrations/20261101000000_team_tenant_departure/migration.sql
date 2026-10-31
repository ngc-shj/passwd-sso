-- A user's departure from a tenant ends their memberships of that tenant's
-- teams (docs/archive/review/team-tenant-departure-plan.md).
--
--  * team_members.deactivated_by_tenant marks the memberships a departure
--    deactivated, so a return restores exactly those.
--  * team_invitations.created_at is filled by the database at insert time,
--    so it orders against a departure's clock_timestamp() stamp.
--  * tenant_member_departures records a SCIM DELETE, which removes the
--    tenant row the admission check would otherwise read.
--
-- Wrapped in BEGIN/COMMIT because this migration has more than one DDL
-- statement (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

ALTER TABLE "team_members" ADD COLUMN "deactivated_by_tenant" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_departure_marker_deactivated"
  CHECK (NOT "deactivated_by_tenant" OR "deactivated_at" IS NOT NULL);

ALTER TABLE "team_invitations" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();

CREATE TABLE "tenant_member_departures" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "departed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_member_departures_pkey" PRIMARY KEY ("tenant_id","user_id")
);

CREATE INDEX "tenant_member_departures_user_id_idx" ON "tenant_member_departures"("user_id");

ALTER TABLE "tenant_member_departures" ADD CONSTRAINT "tenant_member_departures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_member_departures" ADD CONSTRAINT "tenant_member_departures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-RLS isolation, as on tenant_members. No `DROP POLICY IF EXISTS`
-- prefix: the table is new in this migration.
ALTER TABLE "tenant_member_departures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_member_departures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_member_departures_tenant_isolation ON "tenant_member_departures"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );

-- The app reads and upserts records; nothing deletes one but FK cascade.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE tenant_member_departures TO passwd_app;
    -- The default ACL grants DELETE too; a record is removed only by FK
    -- cascade, which runs with the owner's privileges.
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE tenant_member_departures FROM passwd_app;
  END IF;
END $$;

-- BEGIN BACKFILL team-tenant-departure
-- Idempotent: every statement only moves rows still in the pre-departure
-- state. The predicate "departed at or after the invitation was issued" is
-- the one accept applies (`departed >= created_at`, equal refused).
DO $backfill$
DECLARE
  n_memberships integer;
  n_inviter integer;
  n_invitee integer;
  n_records integer;
  n_deleted_invitee integer;
  n_ownerless integer;
BEGIN
  -- 1. Active memberships of a tenant's teams whose user's row in that tenant
  --    is deactivated, created before the deactivation (a later one is a
  --    re-admission and stays).
  UPDATE team_members tm
     SET deactivated_at = tmb.deactivated_at,
         deactivated_by_tenant = true
    FROM tenant_members tmb
   WHERE tmb.tenant_id = tm.tenant_id
     AND tmb.user_id = tm.user_id
     AND tm.deactivated_at IS NULL
     AND tmb.deactivated_at IS NOT NULL
     AND tm.created_at < tmb.deactivated_at;
  GET DIAGNOSTICS n_memberships = ROW_COUNT;

  -- 2a. PENDING invitations issued by a user who departed at or after issue.
  UPDATE team_invitations ti
     SET status = 'EXPIRED'
    FROM tenant_members tmb
   WHERE ti.status = 'PENDING'
     AND tmb.tenant_id = ti.tenant_id
     AND tmb.user_id = ti.invited_by_id
     AND tmb.deactivated_at IS NOT NULL
     AND tmb.deactivated_at >= ti.created_at;
  GET DIAGNOSTICS n_inviter = ROW_COUNT;

  -- 2b. PENDING invitations addressed to a user who departed at or after issue.
  UPDATE team_invitations ti
     SET status = 'EXPIRED'
    FROM users u
    JOIN tenant_members tmb ON tmb.user_id = u.id
   WHERE ti.status = 'PENDING'
     AND lower(u.email) = lower(ti.email)
     AND tmb.tenant_id = ti.tenant_id
     AND tmb.deactivated_at IS NOT NULL
     AND tmb.deactivated_at >= ti.created_at;
  GET DIAGNOSTICS n_invitee = ROW_COUNT;

  -- 2c. SCIM DELETEs before this change left no row; seed their departure
  --     records from the latest SCIM_USER_DELETE audit row per (tenant, user)
  --     (best effort: retention may have purged it; the audit created_at is
  --     the outbox time, slightly after the delete, which fails closed), then
  --     expire the invitations those records void.
  INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at)
  SELECT a.tenant_id, a.target_id::uuid, max(a.created_at)
    FROM audit_logs a
    JOIN users u ON u.id::text = a.target_id
   WHERE a.action = 'SCIM_USER_DELETE'
   GROUP BY a.tenant_id, a.target_id
  ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET departed_at = EXCLUDED.departed_at
    WHERE EXCLUDED.departed_at > tenant_member_departures.departed_at;
  GET DIAGNOSTICS n_records = ROW_COUNT;

  UPDATE team_invitations ti
     SET status = 'EXPIRED'
    FROM users u
    JOIN tenant_member_departures d ON d.user_id = u.id
   WHERE ti.status = 'PENDING'
     AND lower(u.email) = lower(ti.email)
     AND d.tenant_id = ti.tenant_id
     AND d.departed_at >= ti.created_at;
  GET DIAGNOSTICS n_deleted_invitee = ROW_COUNT;

  SELECT count(*) INTO n_ownerless
    FROM teams t
   WHERE NOT EXISTS (
     SELECT 1 FROM team_members tm
      WHERE tm.team_id = t.id AND tm.role = 'OWNER' AND tm.deactivated_at IS NULL);

  RAISE NOTICE 'team-tenant-departure backfill: memberships=% invitations_inviter=% invitations_invitee=% departure_records=% invitations_deleted_invitee=% ownerless_teams=%',
    n_memberships, n_inviter, n_invitee, n_records, n_deleted_invitee, n_ownerless;
END
$backfill$;
-- END BACKFILL team-tenant-departure

COMMIT;
