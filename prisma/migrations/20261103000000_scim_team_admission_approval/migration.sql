-- A SCIM group add now creates or reactivates a membership PENDING team
-- approval instead of handing the key over immediately
-- (docs/archive/review/scim-team-admission-approval-plan.md, C1). The four
-- CHECKs below pin the states a pending row cannot be in, each guarding a
-- reader or writer this plan relies on:
--  * CHECK 1 (deactivated) — a pending row is never active, which is the
--    enforcement surface approval (C3) depends on: every reader of "active
--    member" already excludes deactivated rows, so a pending member has no
--    access until approved.
--  * CHECK 2 (not departure) — `returnToTenant` restores only
--    departure-marked rows, so a return must never also activate a pending
--    one.
--  * CHECK 3 (scim_managed) — the members POST and invitation refusals key
--    on `scim_managed` to reject a manual add/accept of a SCIM-held row; a
--    pending row must always trip that check.
--  * CHECK 4 (not OWNER) — approval reactivates the row as-is, so a pending
--    row must never carry the OWNER role (it would mint a second OWNER).
--
-- Wrapped in BEGIN/COMMIT because this migration has more than one DDL
-- statement (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

ALTER TABLE "team_members" ADD COLUMN "scim_approval_pending" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "team_members" ADD CONSTRAINT "team_members_scim_pending_deactivated"
  CHECK (NOT "scim_approval_pending" OR "deactivated_at" IS NOT NULL);
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_scim_pending_not_departure"
  CHECK (NOT ("scim_approval_pending" AND "deactivated_by_tenant"));
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_scim_pending_scim_managed"
  CHECK (NOT "scim_approval_pending" OR "scim_managed");
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_scim_pending_not_owner"
  CHECK (NOT ("scim_approval_pending" AND "role" = 'OWNER'));

COMMIT;
