# Coding Deviation Log: departed-member-share-links

## D1 A2 / A3: SCIM group removal and re-add are driven through SQL, not the group route

- Plan: A2 refuses after SCIM group removal; A3 serves again after SCIM group removal
  → invitation accept.
- Implemented: A3 deactivates and reactivates the creator's same membership row with
  `UPDATE team_members SET deactivated_at …` — the state SCIM group removal, re-add and
  invitation accept write — and A10 pins the `deactivated_at` term in all contexts.
- Why: the group route needs a mapped SCIM group fixture; the function reads only the
  row state those writers leave, which the cell sets directly. Team member DELETE, SCIM
  user DELETE and SCIM `active=false` run through their real routes.

## D2 A6: personal shares and Sends asserted through the function

- Plan: personal entry shares and Sends serve regardless (page and download).
- Implemented: a Send's `share_creator_admitted` is true after its creator left a team
  (A6), and A10 covers the version-1 no-entry case in three contexts.
- Why: rendering a server-encrypted share needs master-key encrypted fixtures the page
  then decrypts; the page's own admission branch is the same call, pinned by A1/A12.

## D3 Share dialog keeps its existing inactive labels

- Plan: the dialog shows the status through `shareLinkStatus`.
- Implemented: the dialog shows `creatorNotInTeam` when `shareLinkStatus` says so and
  otherwise keeps its existing revoked / expired labels (it has no maxViewsReached
  label today); the dashboard page uses every arm.
- Why: adding a maxViewsReached label to the dialog is a UI change outside `#990`.

## D4 `shareLinkStatus` takes no `expiresAt`

- Plan input listed `expiresAt`. The function does not read it: expiry is already in
  `isActive`, and the remaining arm is "expired" by elimination, as in the page's badge.

## D5 `share_admission` recorded as a comment

- Plan: recorded beside `BYPASS_PURPOSE` in `src/lib/tenant-rls-purpose.ts`.
- Implemented as a comment: an exported constant nothing imports would be dead code.

## D6 A10 sink positive control runs in the public-bypass context only

- The control proves the sink sees a report on this connection; the no-context and
  tenant contexts cannot raise one (no bypass is on), so a control there would not fire.

## D7 No integration cell for the absent verify-access audit row

- Plan: a refusal asserts audit absent among the effects.
- Implemented: `verify-access/route.test.ts` asserts `logAuditAsync` is not called on
  the refused path (the pre-check returns before the password check that writes it).
- Why: `logAuditAsync` enqueues to `audit_outbox` after the request returns, so a
  real-DB "no row" check would pass whether or not the write was merely late.

## Red-proofs (Phase 2)

Destructive ones ran in a scratch worktree against an isolated database
(`passwd_sso_redproof`, a schema-only copy of the dev database, dropped afterwards);
each mutation was undone before the next. Every one reddened:

- Serve code: page pre-check removed (A1, A2); page pre-check moved after the password
  gate (A1); verify-access pre-check after the password check (A1); content pre-check
  removed (A1); each of the four UPDATE calls removed (A12, per arm).
- Function: `deleted_at`, `deactivated_at`, the creator match, the team join each
  dropped; `<=` → `<`; the team-share test keyed on the version only; the
  `bypass_tables` setting not set; the settings not restored (A10 and the cells named
  by each run).
- C2 dropped (A9).
- Unit: helper admits on NULL; status precedence swapped; both list routes' wiring;
  the dialog never showing the label.
- `[E-RLS-BYPASS-ROUTINE]`: a body `set_config`, a body `SET SESSION`, a function `SET`
  clause, and the allowlisted function widened to a fourth table each fail it; the
  restored tree passes.
