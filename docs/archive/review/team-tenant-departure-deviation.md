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
