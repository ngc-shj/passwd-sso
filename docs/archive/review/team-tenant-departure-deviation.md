# Coding Deviation Log: team-tenant-departure

## D1 Create-deactivated arms insert the row deactivated, then restamp

Plan (C2): "the row is created active and departed through `departFromTenant`".
Implemented: SCIM POST `active=false` and the directory-sync create arm insert
the row deactivated (an app-clock placeholder), after
`lockTenantMemberCreation`, and `departCreatedMembership` restamps it with
`clock_timestamp()` and runs departure steps 3–5.

Reason: `tenant_members_one_active_per_user` refuses an active row for a user
already active in another tenant — the case the directory-sync arm exists for
(`activeInAnother`). Creating active first would turn those provisions into a
P2002. The placeholder never reaches an admission comparison: it is replaced in
the same transaction, before any lock is released.

## D2 Backfill arm 2c seeds a departure record whether or not a row exists now

Plan (C1 2c): invitations "addressed to a user with no row in that tenant".
Implemented: the record is seeded from the latest `SCIM_USER_DELETE` audit row
for every (tenant, user), including a user whose membership was re-created
since; invitations to the tenant's teams issued at or before it expire.

Reason: one predicate with the runtime (R48). At runtime the record survives a
re-creation (C1: "never deleted by a re-create"); restricting the backfill to
row-less users would leave pre-delete invitations to a re-created user
acceptable after this change, which the runtime rule refuses.

## D3 Accept refuses a pre-departure invitation with 410, not 403

Plan (C5): "refuse (403 `INVITATION_EXPIRED`)". Implemented: the existing
`API_ERROR.INVITATION_EXPIRED`, whose status is 410 — the code the expiry path
of the same route already returns. A second status for the same error code
would make clients branch on status rather than code.

## D4 The create-deactivated vs guest-accept race has no admitting side through the routes

Plan (A10): "create-deactivated (SCIM POST `active=false`) vs a guest's accept".
A user with no `tenant_members` row in a tenant can accept an invitation only
while active in another tenant (accept resolves the user's tenant; a user active
nowhere is refused). An active membership elsewhere makes that tenant the
owner, and SCIM POST and directory sync then refuse to create the row here
(`SCIM_USER_NOT_PROVISIONABLE`, the declined-attachment arm). So no admission
writer can run concurrently with a create-deactivated for the same user, and
the advisory creation lock (N1) is a backstop for a future admission path. The
integration cell holds that lock directly and witnesses the create waiting on
it, instead of racing a route that cannot reach it.

## D5 Ownerless GET returns the candidates; an inactive target answers 404

Plan (C7): GET returns "id, name, active member count"; the POST refuses a
non-active target with 409. Implemented: GET returns each team's candidates
(user id, role, name, email) — a tenant admin is not necessarily a member of the
team, so no other endpoint lists them — limited to members active in the team
AND in the actor's tenant, the set the POST accepts (a guest from another tenant
has no row there and would always be refused). A non-active actor or target
answers `MEMBER_NOT_FOUND` (404), the code member PUT uses for the same state;
409 stays for "the team has an active OWNER" and lock conflicts.

## D6 Two A10 race cells are covered by other evidence

Plan (A10) also lists "confirm-key vs departure" and "a directory-sync run vs
owner assign". Neither has its own cell:

- confirm-key vs departure: the plan already labels it a regression pin of the
  conditional update #986 added (`deactivatedAt: null, keyDistributed: false` in
  confirm-key's final write), and #986's `team-key-version-guard` cells race
  confirm-key against rotation on the same team lock. The departure takes that
  lock FOR SHARE, which does not conflict with confirm-key's, so the outcome is
  decided by the conditional update alone — pinned by the confirm-key unit tests.
- directory sync vs owner assign: the run departs through the same
  `departFromTenant` as SCIM, after its one tenant-row lock call; the cells
  "owner assign vs departure" (SCIM) and "a run vs an accept in reverse order"
  (engine) cover the two halves — the assign side's lock order, and the run's
  one-call lock against a writer holding a row it needs.
