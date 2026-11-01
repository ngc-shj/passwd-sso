# Manual Test: team-tenant-departure

Covers the tenant-departure redesign (`docs/archive/review/team-tenant-departure-plan.md`):
a user who leaves a tenant leaves its teams, admission back needs a post-departure
invitation, and the admin UI for departed members and ownerless teams.

## Pre-conditions
- Dev stack up (`npm run docker:up`), migrations applied (`npm run db:migrate`), app on its
  usual port.
- Tenant T with a SCIM token (Settings → SCIM), and a second tenant U.
- In T:
  - Admin A (tenant ADMIN) with an unlocked vault.
  - Member M (tenant MEMBER) with an unlocked vault, SCIM-provisioned (note M's SCIM id).
  - Team X: A is OWNER, M is ADMIN, both holding the team key.
  - Team Y: M is OWNER, A is MEMBER.
- A team member of X with the VIEWER role (V).

## Steps and expected results
1. **Departure.** `PATCH /api/scim/v2/Users/<M>` with `active: false` (curl, SCIM token).
   - As A, Team X → Members: M is listed with the "Left the organization" badge, and only
     the remove control (no role selector).
   - As V, Team X → Members: M is not listed.
   - As A, Team X → Transfer ownership: M is not offered.
   - Team key rotation of X (as A) succeeds and does not ask for M's key.
2. **Ownerless team.** As A, Tenant → Teams: an "Teams without an owner" card lists Team Y
   with A as a candidate.
   - Choosing A is refused for a tenant ADMIN (self-assignment); have the tenant OWNER assign
     A instead, or assign another active member. After the step-up prompt, Team Y leaves
     the card, and the audit log shows "Owner assigned by organization admin".
3. **Re-admission.**
   - An invitation to M's email issued BEFORE step 1, accepted by M after moving to U:
     refused ("invitation expired"); the invitation shows as expired.
   - A new invitation issued now: accepted; M becomes a member awaiting key distribution, and
     A's browser distributes the key.
4. **Return.** `PATCH /api/scim/v2/Users/<M>` with `active: true` (with M not active in U).
   - M's Team X membership is back with the same role and key (no rotation happened between).
   - If X was rotated between steps 1 and 4: M is listed for key distribution of the new
     version instead.
5. **Removal of a departed member.** Repeat step 1, then as A remove M from Team X. Reactivate
   M: Team X does not come back.

## Adversarial scenarios
- **Old invitation after an IdP delete.** Issue an invitation to M, then
  `DELETE /api/scim/v2/Users/<M>`, then let M sign in again through SSO (row re-created).
  Accepting the old invitation is refused; only an invitation issued after the delete admits.
- **Departing inviter.** As M, invite an outside address; then deactivate M through SCIM.
  The invitation is expired, and accepting it (if obtained before) is refused.
- **Tenant admin taking a team.** As a tenant ADMIN, try to assign yourself OWNER of an
  ownerless team through `POST /api/tenant/teams/<id>/owner`: 403. A tenant ADMIN of U
  calling the same for a team of T: 404.
- **Concurrent rotation.** Start a key rotation of X and, while it runs, deactivate M through
  SCIM: either completes first; afterwards M holds no key to the new version.

## Rollback
- Revert the PR commit range on `main` and redeploy.
- The migrations are additive (a column with a CHECK, a column default, a new table with
  RLS, three audit enum values). A rollback leaves them in place; the old code ignores the
  marker column and the departure table. Memberships the backfill deactivated stay
  deactivated after a rollback — re-invite or reactivate them by SCIM as needed.
