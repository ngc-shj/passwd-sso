# Plan: scim-team-role-raise-approval (#1004)

## Project context

- Type: web app (Next.js App Router + Prisma 7 + PostgreSQL 16 with RLS).
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none specific. Integration cells run on local Postgres
  with the compose workers stopped; CI runs the same job.

## Objective

A SCIM-admitted team membership waits for a key-holding team OWNER/ADMIN to approve it at the role
shown (`team_members.scim_approval_pending`, the SCIM team admission approval work). After that, a
later SCIM group add still changes an ACTIVE member's role at once (`applyAddOperations`,
`ACTIVE_ROLE_CHANGED`, `src/lib/services/scim-group-service.ts`). A tenant ADMIN holding
`SCIM_MANAGE` can be approved at a harmless role and then raise themselves to team ADMIN through a
group mapping (review finding S-F1 of that work).

**Design (user decision, 2026-11-09, after plan review round 1):** a SCIM raise of an active member
is a re-admission. The active membership ends and becomes a pending admission at the new role, which
the existing approve/reject flow decides. Demotions and same-role adds are unchanged.

The round-1 design (keep the member active with a separate requested-role column) is withdrawn; its
findings and the reasons are in the review log.

## Requirements

- R1: a SCIM add of an ACTIVE row to a group whose role is above the row's role ends the active
  membership and makes the row a pending admission at the group's role, in one CAS write: the same
  state `toBecomePending` produces for a deactivated row (`scimApprovalPending`, `scimManaged`,
  `keyDistributed: false`, `deactivatedByTenant: false`, the group's role), plus `deactivatedAt`
  set; the user's team member keys are deleted for the rows the CAS actually wrote (C1).
- R2: from then on the row is an ordinary pending admission: listed in the group of its (new) role,
  raised further by `higherRole` on another add, withdrawn by a removal, approved at the role shown
  (`expectedRole`) or rejected (row deleted) through the existing routes, with the existing locks,
  step-up and key requirement. Approval leaves `keyDistributed: false`; a key-holding admin's
  browser distributes the key as for any admission.
- R3: a SCIM add at or below the active row's role behaves as today (`ACTIVE_ROLE_CHANGED` for a
  demotion, no-op when equal).
- R4: the transition is audited in the SCIM write's transaction as a pending admission
  (`TEAM_MEMBER_SCIM_PENDING`) with `previousRole` and `previouslyActive: true` in its metadata, so
  the log and team webhooks show that an active member was taken out pending approval.

## Technical approach

One new arm in `applyAddOperations` and a new transition kind; everything after it is the existing
admission machinery. No schema change, no new audit action, no new route, no UI change beyond text.

### Concurrency

Unchanged locking: the add runs under `lockGroupWrite` (tenant-row share lock, per-user advisory
lock, team rotation lock). The write is a CAS on the state the locked pre-read saw
(`{id, teamId, role: previousRole, deactivatedAt: null, scimApprovalPending: false}`), returning the
rows written, as the existing arms do. Approve/reject keep their locks and CAS.

## Contracts

### C1 — The raise arm (`src/lib/services/scim-group-service.ts`)

- In `applyAddOperations`, an active row (`deactivatedAt === null`, not pending) whose role is below
  the group's role (by the existing `SCIM_ROLE_RANK`/`higherRole`) is collected separately from
  `toUpdateRoleByPreviousRole`, which keeps only demotions.
- For the collected rows, grouped by previous role: first `updateManyAndReturn` with
  `where: {id: {in}, teamId, role: previousRole, deactivatedAt: null, scimApprovalPending: false}`,
  `data: {deactivatedAt: new Date(), scimApprovalPending: true, scimManaged: true,
  deactivatedByTenant: false, keyDistributed: false, role}`.
- Then delete `teamMemberKey` rows for this team ONLY for the `userId`s the CAS returned (security
  review round 2, S1): a CAS that misses — a concurrent manual role PUT or team DELETE changed the
  row — must leave the member's keys alone, or an active member is left `keyDistributed: true` with
  no key and no admin browser ever redistributes it. Effects are derived from the rows written,
  never from the pre-read, as the service already does for transitions. The existing
  `toBecomePending` arm is reordered the same way for consistency (there it only touched deactivated
  rows, so it was benign).
- Each returned row yields a transition of the new kind `ACTIVE_RAISE_HELD`
  `{userId, role: <group role>, previousRole, memberId}`; the audit metadata's
  `previouslyActive: true` is keyed on this kind, not on `previousRole` (which `PENDING_ROLE_RAISED`
  also carries).
- `countAddedRemoved` counts `ACTIVE_RAISE_HELD` as added.
- An active row that is not `scim_managed` (added by invitation or the members API) is held the same
  way and becomes `scim_managed` — as `toBecomePending` already does for a deactivated non-managed
  row. Today such a row's role is changed by SCIM directly; holding it is the same rule applied to
  it, not a new exception.
- `ScimMemberTransition.role`'s doc stays true: the role the transition leaves the row at.
- Control class: enforceable boundary. The SCIM token holder's only effect on an active row's
  privileges is downward; any upward step goes through `scimApprovalPending`, which only the approve
  route clears (gate rule 7, `check-team-rotation-input-lock.mjs`). Adjudication authority: the CAS
  predicate and the existing pending-state CHECKs
  (`team_members_scim_pending_deactivated` / `_scim_managed` / `_not_owner` / `_not_departure`).

### C2 — Audit (`src/app/api/scim/v2/Groups/[id]/route.ts`)

- `SCIM_TRANSITION_ACTION[ACTIVE_RAISE_HELD] = TEAM_MEMBER_SCIM_PENDING` (the exhaustive `Record`
  makes a missing mapping a compile error).
- Its metadata: `{scimTokenId, role, previousRole, previouslyActive: true}`; the existing pending
  rows keep their metadata.
- `TEAM_MEMBER_SCIM_ROLE_UPDATE` now audits demotions only; `docs/operations/audit-log-reference.md`
  is corrected to the emitted metadata `{scimTokenId, role, previousRole}` (it documents
  `{newRole, previousRole}`) and says so; the `TEAM_MEMBER_SCIM_PENDING` row documents the new keys.

### C3 — Gate and docs

- `scripts/checks/check-team-rotation-input-lock.mjs`: the new write names `deactivatedAt` and
  `keyDistributed`, so it is a member write and must sit under a recognised lock (it does,
  `lockGroupWrite`). The gate's own `EXPECTED.memberWrites` default (19) rises by exactly the new
  call sites; the self-test pins no real-tree count. Rule 7 holds (`scimApprovalPending: false`
  appears only in `where`; `deactivatedAt` is set, not nulled). Phase 2 records the old and new
  counts.
- `docs/architecture/tenant-team-scim-spec.md`: the statement that the IdP can raise a role after
  admission is replaced by the re-admission rule; one role group per team per user is the supported
  IdP configuration (a user in two role groups is re-admitted on each full sync that raises them).
- The same spec's action list (the `TEAM_MEMBER_SCIM_PENDING` and `TEAM_MEMBER_SCIM_ROLE_UPDATE`
  descriptions) says a pending admission also arises from a held raise and ROLE_UPDATE is a demotion;
  the service docstrings (`applyAddOperations`, `ScimMemberTransition.previousRole`) follow.
- `messages/{en,ja}/Team.json` `approveRoleNote`: no longer says the IdP can raise a role after
  approval; says a raise takes the member out until approved.

## Forbidden patterns

- pattern: `ACTIVE_ROLE_CHANGED` produced for a row whose new role is above its previous role —
  reason: the raise must go through pending (checked by the unit and integration cells, not grep).
- pattern: `scimApprovalPending: false` in `scim-group-service.ts` data payloads — reason: only the
  approve route clears the pending marker (existing rule 7).

## Acceptance criteria

Integration (`src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`, new
cells next to the existing ones):

1. Active VIEWER, SCIM PATCH add to the ADMIN group → row deactivated, pending, `scim_managed`, role
   ADMIN, `key_distributed` false, the user's `team_member_keys` for the team gone; one
   `TEAM_MEMBER_SCIM_PENDING` audit row with `previousRole: VIEWER`, `previouslyActive: true`; no
   `TEAM_MEMBER_SCIM_ROLE_UPDATE`. The member's team permission check now refuses (positive control:
   it passed before the add).
2. The same through PUT of the ADMIN group (both verbs, as A10).
3. Approve with `expectedRole: ADMIN` by a key-holding team ADMIN → active ADMIN; a stale
   `expectedRole: VIEWER` → 409 `SCIM_APPROVAL_ROLE_CHANGED`.
4. Reject → row deleted; the member is no longer in the team.
5. Demotion (active ADMIN added to the MEMBER group) → immediate role change and
   `TEAM_MEMBER_SCIM_ROLE_UPDATE`, as today; equal-role add → no write, no audit.
6. Group reads after cell 1: the ADMIN group lists the member (as pending admission), the VIEWER group
   does not; a repeated PUT of the ADMIN group writes nothing (audit count stays 1, `added: 0`).
7. An active non-`scim_managed` member raised by SCIM → held the same way and `scim_managed`.
9. A SCIM raise whose CAS misses (the row's role changed after the pre-read, forced
   deterministically) leaves the member's keys and `key_distributed` untouched.
8. Active OWNER in a raise → `SCIM_OWNER_PROTECTED` as today (no OWNER group add raises an OWNER;
   kept as the existing cell).

Cell fixtures: cell 1 seeds `scim_managed: true`, `key_distributed: true` and a `team_member_keys`
row (otherwise "keys gone" is vacuous and cell 1 equals cell 7).

Existing tests to update (R19): A10 "every SCIM transition kind" (its VIEWER→MEMBER fixture becomes a
hold; it gains an active-ADMIN demotion fixture so ROLE_UPDATE stays covered, and the new kind), A7d
(seed a key for the transferee and assert it survives — the race red-proof for C1's ordering),
`src/lib/services/scim-group-service.test.ts` (MEMBER→ADMIN expectations become a hold; the
`countAddedRemoved` cell gets a demotion case, which needs a lower mapping role than ADMIN),
`src/app/api/scim/v2/Groups/[id]/route.test.ts` A7e (a lower mapping role for the demotion fixture;
its pinned call counts move), the gate's `EXPECTED.memberWrites`. Phase 2 re-derives the list by
running the suites.

Red-proof: the raise arm reverted to the old immediate role write → cells 1, 2, 7 red; the key
deletion removed → cell 1 red at the key count.

### Consumer-flow walkthrough

- SCIM IdP reads group members by role equality (unchanged): the held row has the new role and is
  pending, so it is listed in the new group and absent from the old one; an IdP move (add ADMIN,
  remove VIEWER) finds nothing to remove in VIEWER.
- Members list page: the held row shows as a pending admission at the new role with Approve/Reject
  (existing UI); Approve posts `expectedRole` = the shown role.
- Team webhooks / audit log: `TEAM_MEMBER_SCIM_PENDING` with `previousRole`, `previouslyActive`.

## Testing strategy

Integration cells above; unit tests for classification and `countAddedRemoved`; route test for the
action mapping; gate self-test counts.

## Considerations & constraints

- The member has no team access while the raise waits, and approval needs the team key distributed
  again. Accepted (user decision): it is the price of the raise being approved at all.
- Rejecting a raise removes the member from the team (existing reject deletes the row). To keep them
  at the old role, the IdP mapping is corrected and the next sync re-admits them at that role; or a
  team admin adds them back.
- The IdP reverting a raise before anyone decides (add back to VIEWER, remove from ADMIN): the
  VIEWER add leaves the pending row as is (a pending row is never lowered) and the ADMIN removal
  withdraws it (deletes the row); the next sync re-admits the member pending at VIEWER.
- The IdP's request order: remove-from-VIEWER first gives `TEAM_MEMBER_SCIM_REMOVE`, then the ADMIN
  add takes the deactivated-row path (`TEAM_MEMBER_SCIM_PENDING` without `previouslyActive`). The end
  state is the same; `previouslyActive` marks only the add-first order.
- A user in two role groups of one team: each full sync that adds them to the higher group after a
  lower-group demotion re-admits them. Documented as unsupported configuration (spec).
- Manual role PUT racing a SCIM add (finding F11 of round 1): the SCIM CAS misses and the add is
  dropped without a transition, as for `ACTIVE_ROLE_CHANGED` today; because the key deletion follows
  the CAS's returned rows, the miss has no side effect. Noted in the spec.
- The held member's team share links stop serving while the raise waits (`share_creator_admitted`
  requires an active membership created before the link), serve again on approval (same row), and
  stay dead after a reject (a later re-admission is a new row). They are not revoked.

### Scope contract

- SC1: notifications or a pending-count badge for admissions — not in this change.
- SC2: the tenant ownerless-team owner route (`TEAM_OWNER_ASSIGN`, a deliberate tenant-ADMIN power)
  sets any active member of an ownerless team to OWNER with no team-key requirement. A tenant ADMIN
  holding a SCIM token can make a team ownerless (SCIM Users `active=false`/`DELETE` of a team OWNER
  who is not tenant OWNER) and then grant OWNER to one approved second identity — a raise without a
  key-holder's approval, independent of this change. Both steps are audited in their transactions
  (`TEAM_MEMBER_TENANT_DEACTIVATE`, `TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN`). Recorded as a residual
  beside the admission work's S-F2; this change neither creates nor widens it.

## User operation scenarios

1. IdP moves Alice from VIEWER to ADMIN (add ADMIN, remove VIEWER): Alice is taken out pending at
   ADMIN; the VIEWER removal is a no-op; a team ADMIN with the key approves; Alice is ADMIN once a key
   holder's browser distributes the key.
2. A tenant ADMIN with `SCIM_MANAGE`, approved as VIEWER, maps themselves into the ADMIN group: they
   lose VIEWER access and wait for approval; they cannot approve (no `MEMBER_INVITE`).
3. IdP moves Bob from ADMIN down to MEMBER: applied at once, as today.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Raise of an active row becomes a pending admission | locked |
| C2 | Audit mapping and metadata; reference doc corrected | locked |
| C3 | Gate counts, spec and UI text | locked |
