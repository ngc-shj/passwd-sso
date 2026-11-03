# Manual Test: scim-team-admission-approval

Issue `#991`. Plan: `scim-team-admission-approval-plan.md`. A SCIM group add no longer
admits a user to a team: the membership waits until a team OWNER/ADMIN holding the
team key approves it, or the team rejects it.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied, dev server running.
- A tenant with a SCIM token (Tenant settings → SCIM). Users: a team OWNER (vault set
  up, holds the team key), a team ADMIN who has never unlocked the team (no key), a
  tenant ADMIN "joiner" who is not in the team, and a team VIEWER.
- A team "core" with those three team members.
- A second browser profile for the joiner.

## Steps and expected results

1. Map a group and add the joiner through SCIM:
   `POST /api/scim/v2/Groups` with `displayName: "core:ADMIN"`, then
   `PATCH /api/scim/v2/Groups/<id>` adding the joiner's user id.
   - Expected: 200. As the joiner, the team does not appear in the team list and
     opening `/admin/teams/<teamId>` shows no access. No key is distributed.
2. As the OWNER, open the team's member list.
   - Expected: the joiner shows "Awaiting approval (SCIM)" with role ADMIN and
     Approve / Reject buttons, no role select and no remove button. The team audit log
     shows the mapping creation and "pending" entries.
3. As the VIEWER, open the member list.
   - Expected: the joiner is not listed.
4. As the keyless ADMIN, click Approve (complete the step-up prompt).
   - Expected: "Only an owner or admin who holds the current team key can approve…";
     the row stays pending.
5. As the OWNER, click Approve (complete the step-up prompt).
   - Expected: "Member approved"; the row becomes an active ADMIN. After the OWNER's
     browser distributes the key, the joiner can open the team and its entries. The
     team audit log shows the approval and the key distribution.
6. Remove the joiner through SCIM (`PATCH … remove`), then add them again.
   - Expected: removal deactivates the member (team audit: SCIM removal); the re-add
     makes them pending again, not active.
7. As the OWNER, click Reject and confirm.
   - Expected: "Member rejected"; the row disappears. The confirmation says the
     request returns if the IdP still lists the user — send the same PATCH add again
     and confirm a new pending row appears.
8. As the OWNER, try to add the pending joiner from "Add from tenant".
   - Expected: "Awaiting approval — approve it in the member list".

## Adversarial scenarios

- The joiner (pending) calls `POST /api/teams/<teamId>/members/<theirRowId>/approve`
  with their own session → 404; the row stays pending.
- A tenant ADMIN outside the team calls approve or reject on the pending row → 404.
- Approve with a stale `expectedRole` (the row was raised to ADMIN by a second group
  add after the list loaded) → the list reloads with "This member's role changed…";
  the row stays pending.
- Reject targeting an active member's row id → 404; the member is unaffected.
- Approve without a fresh step-up → the re-authentication dialog, no change.

## Rollback

Revert the branch's commits and redeploy. The migration's column and CHECKs can stay
(a false marker is today's behaviour); rows left pending at rollback stay deactivated
and can be removed from the member list or re-added through SCIM.
