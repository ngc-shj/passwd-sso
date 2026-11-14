# Manual Test: scim-bulk-approve

Issue `#1005`. Plan: `scim-bulk-approve-plan.md`. A team OWNER/ADMIN approves or rejects
many SCIM-pending memberships in one step-up-gated request:
`POST /api/teams/<teamId>/members/bulk-approve` (body `{ members: [{ memberId,
expectedRole }] }`) and `POST /api/teams/<teamId>/members/bulk-reject` (body
`{ memberIds }`), from the "Approve all (N)" / "Reject all (N)" buttons on the members page.

## Pre-conditions

- The dev stack, tenant, SCIM token, team "core" and users of
  `scim-team-admission-approval-manual-test.md` (Pre-conditions): a key-holding team OWNER,
  a key-less team ADMIN, a team VIEWER, plus a plain team MEMBER (call them `member`).
- Pending rows, produced as in that document's step 1: map groups `core:MEMBER` and
  `core:ADMIN` (`POST /api/scim/v2/Groups`), then `PATCH /api/scim/v2/Groups/<id>` adding
  tenant users. To get 60 rows quickly, create the tenant users first (a SCIM `POST
  /api/scim/v2/Users` loop with `active: true`) and add them in one PATCH per group.
- A second team "other" owned by the OWNER, with one pending row of its own (for the
  cross-team case).
- Dev server running; the OWNER signed in with a recent sign-in so the step-up prompt can
  be satisfied or deliberately left stale.

## Steps

1. Add 58 users to `core:MEMBER` and 2 to `core:ADMIN` through SCIM. As the OWNER open
   `/admin/teams/<teamId>` members. Click "Approve all (60)".
2. Read the dialog, then confirm and complete the step-up prompt.
3. Add 5 new pending users, click "Reject all (5)", confirm.
4. With the OWNER's last sign-in older than the step-up window, click "Approve all (N)" and
   confirm.
5. Add 12 pending users whose names share a prefix `zeta`, plus 8 others. Type `zeta` in the
   search box.
6. Add 6 pending users to `core:MEMBER`, load the page, then (without reloading) raise 3 of
   them by adding them to `core:ADMIN` through SCIM. Click "Approve all (6)", confirm.
7. Add 4 pending users to `core:MEMBER` and 1 to `core:ADMIN`; open the approve dialog.
8. Add 150 pending users; open the approve dialog and confirm; reload and repeat.
9. As the key-less ADMIN, with 3 pending rows, click "Approve all (3)", confirm; then
   "Reject all (3)", confirm.
10. Open the members page as the OWNER and as a second key-holding OWNER/ADMIN in two
    browser profiles with the same 10 pending rows. Click "Approve all (10)" and confirm in
    both as close together as you can.
11. With exactly one pending row, open the page.

## Expected result

1. The dialog states "Approve 60 pending members? Each joins at the role shown in the
   list." with `Member: 58` and a separate line `Admin: 2. An admin can invite and manage
   members of this team.` No request is sent before confirm (browser Network tab: no
   `bulk-approve` call; Cancel also sends none).
2. One `POST …/bulk-approve` answers 200 with 60 `approved` results; toast "60 members
   approved"; the list refreshes with no pending rows; the team audit log has 60
   `TEAM_MEMBER_SCIM_APPROVE` rows whose metadata share one `batchId`. The approved members
   have no key yet (key distribution is a separate step); the OWNER's browser distributes
   it as for single approvals.
3. Toast "5 requests rejected"; the rows disappear; 5 `TEAM_MEMBER_SCIM_REJECT` rows share
   one `batchId` (a different one from step 2's). The confirmation reuses the single
   reject's explanation (the request returns if the IdP still lists the user).
4. The re-authentication dialog opens (403 `SESSION_STEP_UP_REQUIRED` underneath); after
   completing it the same request (same ids and roles as at confirm) is replayed and
   succeeds. Nothing was changed before the replay.
5. The button reads "Reject all (12)" / "Approve all (12)"; confirming rejects only those
   12 (the request body lists 12 ids); the 8 others stay pending.
6. The request carries the roles shown at page load. Toasts "3 members approved" and "3
   requests were not approved. The list has been refreshed."; the 3 raised rows are still
   pending, now shown at ADMIN; no audit row for them. Approve them again (dialog shows
   `Admin: 3`) to finish.
7. The dialog shows `Member: 4` and `Admin: 1. An admin can invite and manage members of
   this team.`; with no ADMIN row the admin line is absent.
8. The button reads "Approve all (100)" and the dialog adds "50 more pending requests are
   not included. Run this again afterwards to handle them." After the first pass the page
   shows 50 pending; the second pass handles them.
9. Approve: toast "Only an owner or admin who holds the current team key can approve.
   Another admin can approve it, or you can reject it." (403 `FORBIDDEN`), rows stay
   pending, no audit row. Reject: "3 requests rejected".
10. One profile shows "10 members approved". The other shows either "This request was
    already handled. The list has been refreshed." (every row `not_found`) or "Another
    change to this team is in progress. Try again in a moment." (409); the audit log holds
    exactly 10 approve rows, never more.
11. No "Approve all" / "Reject all" button; the row's own Approve / Reject buttons remain.

## Rollback

Revert the branch's commits and redeploy; the single approve/reject routes keep working
(they call the same adjudicator). Pending rows left over from the test can be rejected from
the member list or removed through SCIM (`PATCH … remove`). Delete the test users and the
"other" team if the dev database is shared.

## Adversarial scenarios

Use a signed-in session cookie and the app origin, e.g.
`curl -sS -X POST -H 'Content-Type: application/json' -H 'Origin: <APP_URL>' -b
'authjs.session-token=<cookie>' -d '<json>' <APP_URL>/api/teams/<teamId>/members/bulk-approve`.

- A plain team MEMBER or VIEWER posts a valid body to either bulk route: 403
  `FORBIDDEN`; a tenant user outside the team: 404; no cookie: 401. No row changes.
- The OWNER of team "core" posts the ids of team "other"'s pending rows to `core`'s bulk
  routes: 200, every result `not_found`; the rows in "other" stay pending; no audit row.
- 101 entries (`members` of 101, or `memberIds` of 101): 400 `VALIDATION_ERROR`; 0 entries:
  400; an unknown extra key in the body or an entry: 400; a `memberId` that is not a UUID:
  400.
- The same id twice in different case (`"AB…"` and `"ab…"`): 400 `VALIDATION_ERROR`
  (uniqueness is checked on the lowercased id); nothing is applied.
- Rate limit: 11 requests to one bulk route inside an hour by the same user: the 11th
  answers 429 `RATE_LIMIT_EXCEEDED`; a valid body is not read. The other bulk route has its
  own budget.
- No fresh step-up (do not complete the prompt): 403 `SESSION_STEP_UP_REQUIRED`, no change,
  and an invalid body gets the same step-up answer before validation.
- `expectedRole` that differs from the row's current role: that row answers `role_changed`
  and stays pending; the others in the request still commit.
- A pending row whose user was deactivated in the tenant (SCIM `PATCH /Users/<id>` with
  `active: false`): `tenant_inactive`, still pending.
- Ids of active members in a request: `not_found`, members untouched.
