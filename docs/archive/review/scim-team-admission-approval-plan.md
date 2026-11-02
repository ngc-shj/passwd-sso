# Plan: scim-team-admission-approval (v10)

Branch: `fix/scim-team-admission-approval`. Issue `#991`. Policy chosen by the user:
team approval before key hand-off. Review record: `scim-team-admission-approval-review.md`.

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, RLS with FORCE).
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none blocking.

## Objective

A tenant OWNER/ADMIN holds `SCIM_MANAGE`: they can mint a SCIM token, map an IdP group
to any team (`displayName = "<slug>:<ROLE>"`), and add any active tenant member —
themselves included — to that team. Admins' browsers then hand the team key over
automatically, and team owners see none of it (mapping creation is not audited; the
group update is audited at tenant scope only).

After this change, a membership that SCIM admits (a new row, or a deactivated row
brought back) is pending until an active team OWNER/ADMIN holding the team key approves
it, or the team rejects it. A pending member has no team access and receives no key.
Team owners see SCIM's effect on their team in the team audit log and team webhooks.

Out of scope by design: SCIM role changes of members who are already active (they
already hold the key and the data). The residual risk this leaves:
- an active key-holding member colluding with a SCIM holder (raised to ADMIN through
  SCIM, then approving) — the same as a key-holding ADMIN adding someone through the
  members route today;
- an active VIEWER/MEMBER who also holds `SCIM_MANAGE` can raise themselves to ADMIN
  through SCIM. They gain team rights, not a key they did not already hold; the change
  is now audited at TEAM scope (C4).

## Design

Pending is a deactivated `team_members` row with a marker. Every reader of "active
member" already excludes deactivated rows: access (`requireTeamMember`), admin rights,
`GET /api/teams`, `member-key`, rotation recipients, `pending-key-distributions`,
confirm-key (pre-check and CAS), owner assignment candidates. Approval is an admission
and reactivates the row under the tenant-row and team locks (`#987` lock order).

The row's role is the requested role. SCIM group membership stays role-keyed: a user is
in group G when their row has `role = G.role` and is active, departed
(`deactivated_by_tenant`), or pending.

## Contracts

### C1 Schema

- `team_members.scim_approval_pending boolean NOT NULL DEFAULT false`.
- `CHECK (NOT scim_approval_pending OR deactivated_at IS NOT NULL)` — a pending row is
  never active.
- `CHECK (NOT (scim_approval_pending AND deactivated_by_tenant))` — `returnToTenant`
  restores only departure-marked rows, so a return never activates a pending row.
- `CHECK (NOT scim_approval_pending OR scim_managed)` — the members POST and invitation
  refusals key on `scim_managed`; a pending row always trips them.
- `CHECK (NOT (scim_approval_pending AND role = 'OWNER'))` — approval never mints a
  second OWNER.
- Writers that set `deactivated_at = NULL`: members POST (refuses a `scimManaged`,
  not departure-marked row inside its locked transaction), invitation accept (refuses
  it only in a pre-check today — C6 adds the in-transaction re-check), `returnToTenant`
  (CHECK 2), and the approve route. SCIM's reactivation is removed (C2).
- Table-level grants on `team_members` cover the new column; no grant change.
- No backfill (existing SCIM members stay active — SC1).

### C2 SCIM writes

`src/lib/services/scim-group-service.ts`, `applyAddOperations`:
- user active in the tenant:
  - no row → create deactivated (`deactivatedAt: new Date()`),
    `scimApprovalPending: true`, `scimManaged: true`, `keyDistributed: false`,
    `role` = mapping role;
  - a deactivated row that is not pending (departure-marked or not) → stays
    deactivated, becomes pending (`scimManaged: true`, `deactivatedByTenant: false`,
    role = mapping role, `keyDistributed: false`), stale keys deleted as today. A departure-marked row of a user
    active in the tenant is normally unreachable (`returnToTenant` restores those rows
    when the tenant row comes back); if reached, it is treated the same way;
  - a pending row → stays pending; role becomes the higher of its role and the mapping
    role (SCIM roles are ADMIN, MEMBER, VIEWER — never OWNER); a raise is a transition
    (C4);
  - an active row → unchanged behaviour (role set to the mapping role; OWNER protected),
    written as a CAS `updateManyAndReturn` per previous role
    (`where: { id: { in }, teamId, role: <pre-read role>, deactivatedAt: null }`), so a
    concurrent ownership transfer or removal is not overwritten; the role-change
    transition comes from the returned rows. A pending raise is likewise a CAS on
    `scimApprovalPending: true` and the pre-read role.
- user inactive in the tenant: a departure-marked row **or a pending row** is skipped
  (today only the former; without this a re-add of a departed pending user fails the
  whole PATCH with `SCIM_NO_SUCH_MEMBER`); anything else throws as today.

`applyRemoveOperations` — set-based CAS writes (one statement per kind, not per row);
transitions are derived from what each write returned, never from the pre-read:
- pending rows: `deleteMany` `where: { id: { in }, teamId, role: mapping.role,
  scimApprovalPending: true }` → withdraw (no keys, no history): a `findMany` of the same
  predicate under the candidates' advisory locks, then `deleteMany`; equal counts → one
  WITHDRAW per row found; a shortfall (only an unlocked writer, e.g. the Auth.js
  `deleteUser` cascade, can cause it) throws `ScimMembershipChangedError`, rolling the
  whole request back so the IdP's retry emits exact transitions. PUT and PATCH map it
  with their own arm (SCIM 409 "A member's membership changed during the update;
  retry"), not through the shared `isMembershipLockConflict` helpers;
- active rows: `updateManyAndReturn` `where: { id: { in }, teamId, role: mapping.role,
  deactivatedAt: null }` → active removed (returned rows);
- departure-marked rows: `updateManyAndReturn` over the ids the locked re-read classed
  as departed, `where: { …, deactivatedByTenant: true }`, setting it false → departed
  unmarked (a return no longer restores it).
- A remove of a user with no row in the team is a no-op (no write, no transition),
  whatever their tenant row looks like — after a reject, a withdraw, or SCIM
  DELETE /Users (which deletes the tenant and team rows). Today's `SCIM_NO_SUCH_MEMBER`
  would roll back the whole PATCH, including deactivations of active members, on every
  IdP retry; removing an absent member is idempotent.

Serialisation with approve/reject: the only exclusive lock they share with SCIM is the
target's tenant-row advisory lock (the team lock is `FOR SHARE` on both sides).
`lockGroupWrite` therefore locks, in its single `lockTenantRows` call, the add users and
every remove candidate: PATCH's remove users; PUT's requested users plus an unlocked
pre-read of the group's current members. Tenant departure also holds the user's
advisory lock, so a SCIM removal and a concurrent departure serialise and the removal
sees the post-departure row (unmarking it) — without this lock a departure could leave
the row marked and `returnToTenant` would restore a membership the IdP removed. A member
found by PUT's locked re-read whose user is outside the locked set (it joined after the
pre-read) is not removed by this PUT and is left for the next sync. Request limits are
unchanged (no new cap); the locks remain one sorted statement under one budget.

`replaceScimGroup`: its current-member set also contains pending rows with
`role = mapping.role`, so a PUT that omits a pending user removes it, and a repeated
PUT that lists it is a no-op.

Readers — fragments without team or role, in one module
(`src/lib/scim/scim-group-members.ts`), composed by every call site:
- `SCIM_GROUP_ROW_STATE`: the row is active, departed or pending. Used by
  `replaceScimGroup`'s current-member set (departed users must stay in it: a PUT
  listing a departed member is a no-op).
- `scimGroupResponseMemberWhere(tenantId)`: the above plus the user's active tenant
  membership (today's guard against a cross-tenant guest and an RLS-hidden user
  relation). Used by `loadGroupMembers` and by `src/app/api/scim/v2/Groups/route.ts`
  (POST response and the list GET batch query with `teamId/role: { in }`).

The service results carry per-user transitions: became pending, pending role raised,
pending withdrawn, active removed, departed unmarked, active role changed. `added` / `removed` counts in
`SCIM_GROUP_UPDATE` are counted from these transitions, not from the requested lists.

The service functions take a `Prisma.TransactionClient` only (their one caller,
`Groups/[id]/route.ts`, passes its `withTenantRls` transaction); the plain-client
`$transaction` branch is removed, so audits written by the route share the transaction.

### C3 Approve and reject

`POST /api/teams/[teamId]/members/[memberId]/approve` (body `{ expectedRole }`) and
`POST /api/teams/[teamId]/members/[memberId]/reject`:
- session; `requireTeamPermission(MEMBER_INVITE)` (a pending or non-member caller
  answers 404 here); step-up (`@stepup`, `stepup-route-paths.json`); rate limit; uuid
  params; Zod body;
- unlocked pre-read of the target by `id, team_id` for its `userId` → 404 when absent;
- one transaction: `lockTenantRows([approver, target], "share")` once, then the team
  lock (`lockTeamsAgainstRotation`);
- re-read the approver: active, OWNER or ADMIN — else 403. (Self-approval is ruled out
  structurally: `(team_id, user_id)` is unique and the approver's row is active while a
  pending row is deactivated — no cell, no extra check.) Approve
  also requires `key_distributed = true` (rotation wraps only active distributed members
  and resets the rest under the same team lock, so this means "holds the current key
  version"). Reject hands nothing over and does not require the key (a team without a
  key holder can still clear requests);
- locked re-read of the target by `id, team_id, user_id, scim_approval_pending = true`
  → 404 when absent (before any 409);
- approve: `expectedRole` is Zod-limited to ADMIN/MEMBER/VIEWER; target's role ≠
  `expectedRole` → 409 `SCIM_APPROVAL_ROLE_CHANGED`; target's tenant row inactive → 409;
  CAS as Prisma `teamMember.updateMany({ where: { id, teamId, role: expectedRole,
  scimApprovalPending: true, deactivatedAt: { not: null } }, data: { deactivatedAt:
  null, scimApprovalPending: false, keyDistributed: false } })` (literal `data`, so the
  gate counts it as an admission); count 0 → 409. The existing distribution flow then
  hands the key over;
- reject: CAS `teamMember.deleteMany({ where: { id, teamId, scimApprovalPending: true } })`;
  count 0 → 404;
- `logAuditInTx` in the same transaction: `TEAM_MEMBER_SCIM_APPROVE` /
  `TEAM_MEMBER_SCIM_REJECT` (TEAM scope; target = user id, metadata `memberId`, role).
- Control class: enforceable boundary — an admitted member reaches team data, rights or
  the key only after the approval, because every reader excludes deactivated rows.

### C4 Visibility (TEAM scope, in the SCIM transaction)

- `SCIM POST /Groups` creating a mapping: `SCIM_GROUP_MAPPING_CREATE`.
- Per user: `TEAM_MEMBER_SCIM_PENDING` (transition into pending, and a pending role
  raise with `previousRole`), `TEAM_MEMBER_SCIM_PENDING_WITHDRAW` (a pending row deleted
  by SCIM), `TEAM_MEMBER_SCIM_REMOVE` (an active member deactivated by SCIM),
  `TEAM_MEMBER_SCIM_ROLE_UPDATE` (an active member's role changed by SCIM); a departed
  membership unmarked is `TEAM_MEMBER_SCIM_REMOVE` with `departed: true`.
- Target of every SCIM transition audit is the user id (as the departure audits do;
  `createMany` returns no member ids).
- confirm-key: `TEAM_MEMBER_KEY_DISTRIBUTE` (already registered, never emitted), only on
  a successful CAS.
- Emitted by the route inside its `withTenantRls` callback from the service's
  transition lists (the route holds the actor fields), through a new
  `logAuditBulkInTx(tx, tenantId, params[])` — one scope check plus one
  `auditOutbox.createMany` (a 1000-user sync must fit `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`);
  metadata carries `scimTokenId`. Both PUT and PATCH emit through one route-module helper
  that maps the service result with an exhaustive `Record<TransitionKind, AuditAction>`
  (a new transition kind is a compile error), with literal `scope: AUDIT_SCOPE.TEAM` and
  `teamId`. Call shape: one call per action, its params a `.map`
  whose arrow callback returns an object literal with `action: AUDIT_ACTION.X`.
  `check-critical-audit-atomic.mjs` is extended to read `action` from array-literal
  elements and such `.map` callbacks, refusing a computed or conditional `action`
  there; self-tests: a fixture writing every critical action but one through
  `logAuditInTx` and the last only through a bulk call passes (parenthesised `.map`
  body and array-literal forms); the same fixture without the bulk call, and with the
  bulk call returning an already-present action instead, each exit 1 with the
  missing-action message (both forms); a fixture whose critical actions are all present through literal
  `logAuditInTx` plus a bulk `.map` with a ternary `action` over present actions exits 1
  with the refusal message; a spread of a `.map` inside an array literal is refused; a
  `logAuditBulkAsync` call does not count. The existing tenant-scope `SCIM_GROUP_UPDATE` stays.
- New actions in the TEAM audit group (not the SCIM group, which team webhooks exclude):
  Prisma enum (own `ALTER TYPE` migration), `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`,
  `AUDIT_ACTION_GROUPS_TEAM`, `audit-action-icons.tsx`, `messages/{en,ja}/AuditLog.json`,
  `docs/operations/audit-log-reference.md`. Every action above, and
  `logAuditBulkInTx` as an in-tx helper, is added to the critical-audit gate
  (`check-critical-audit-atomic.mjs`).

### C5 Team members UI

- `GET /api/teams/[teamId]/members` returns pending rows to `MEMBER_INVITE` holders only,
  with `pendingApproval: true`; `src/lib/team/team-member-display.ts` types gain it.
- `admin/teams/[teamId]/members/list/page.tsx`: a pending row shows "Awaiting approval
  (SCIM)" with its role, Approve (sends the shown role as `expectedRole`) and Reject
  (step-up), no role select or remove button; 409 `SCIM_APPROVAL_ROLE_CHANGED` reloads
  the list with a message.
- `transfer-ownership/page.tsx` and owner-assignment candidates exclude pending rows.
- en/ja strings in `messages/{en,ja}/Team.json`.
- `src/app/api/tenant/teams/[teamId]/owner/route.ts`: the comment saying a tenant ADMIN
  can join any team through SCIM is updated (a SCIM join is now pending).

### C6 Team-side add of a pending user

- A pending row answers a distinct 409 `SCIM_APPROVAL_PENDING` from members POST,
  invitation create and invitation accept (a SCIM-removed, non-pending row keeps
  `SCIM_MANAGED_MEMBER`). The add UI maps the new code to "Awaiting approval — approve
  it in the list"; en/ja strings and the error-code tables.
- Invitation accept re-checks `scimManaged && !deactivatedByTenant` (and pending)
  inside its locked transaction by throwing, so the invitation claim rolls back and the
  invitation stays PENDING (today a race reaches CHECK 1 → 500).

### C6b Docs

`docs/architecture/tenant-team-scim-spec.md`: the group member add/remove rules are
rewritten (add creates a pending row needing team approval; remove withdraws a pending
row, deactivates an active one, unmarks a departed one, ignores an absent user). The
SCIM 400 message for a missing member becomes "Referenced user is not an active member
of this tenant" (only the add path reaches it). Its Audit section: "SCIM token/user
operations and `SCIM_GROUP_UPDATE` are TENANT scope; per-member group transitions are
TEAM scope" (replacing "all SCIM operations … TENANT"), the TEAM-scope actions (C4) and
their team webhook delivery, and the SCIM group described as kept for showing old logs,
not delivered to team webhooks.

### C7 Existing SCIM memberships (SC1)

`docs/operations/` gains a read-only SQL listing of active `scim_managed` team
memberships (team, user, role, `created_at`) that have no `TEAM_MEMBER_SCIM_APPROVE`
audit row for (team, user), so operators can review memberships gained before this
change. It runs as the table owner (`MIGRATION_DATABASE_URL`; under `passwd_app` FORCE
RLS returns an empty set), and is run against the dev DB with a non-empty result before
it is documented. A UI listing is a follow-up issue.

## Forbidden patterns

Enforced by a new rule 7 in `scripts/checks/check-team-rotation-input-lock.mjs`:
- Method lists of every classifier (admission, member write, tenant-state write, rule 7)
  gain `createManyAndReturn` and `updateManyAndReturn`.
- In `scim-group-service.ts`: every `teamMember` write payload (`data`, an `upsert`'s
  `create`/`update`, nested member writes) is an object literal (for `createMany*`, a
  `.map` whose arrow callback returns an object literal); anything else is refused as
  unreadable. No payload names `deactivatedAt: null`. Every creating payload (`create`,
  `createMany*`, `upsert.create`, nested `create`/`createMany`/`connectOrCreate`) names
  `scimApprovalPending: true` and a non-null `deactivatedAt`. No raw template there
  writes `team_members`.
- Repo-wide (src, outside migrations): a `scimApprovalPending` property in a write
  payload (identifier, quoted or shorthand key) whose value is not the literal `true` is
  allowed only in the approve route; any string or template literal containing
  `scim_approval_pending` is refused (no code needs raw access to the column). This scan
  runs before the gate's `IMPLEMENTATIONS` skip, so `team-departure.ts` and the lock
  modules are covered.
- Known limit: a column name assembled from fragments at runtime.

Self-test cases: a raw INSERT and a raw UPDATE of `team_members` in the service; an
unreadable `data`; a `.map` with a block-body callback; a create, an `upsert.create` and
a nested `members.create` without the marker; a create with `deactivatedAt: null`; an
`upsert` `update` arm with `deactivatedAt: null`; `createManyAndReturn` without the
marker and `updateManyAndReturn` with `deactivatedAt: null`; `scimApprovalPending:
false`, a variable, a shorthand and a quoted key outside the approve route; a
parameterised raw `scim_approval_pending = ${v}` and a `Prisma.sql` fragment naming it;
the same raw template in `src/lib/team/team-departure.ts`; the approve route passing.

Expected count deltas, each explained in the deviation log: admissions −1 (SCIM
reactivation `updateMany`) +1 (approve CAS); member writes +3 (SCIM withdraw delete,
reject delete, approve CAS). The A1 integration red-proof remains the behavioural guard.

## Acceptance criteria

Denials assert the state unchanged (row still pending/deactivated, no approve audit).

- A1 SCIM PATCH adds a tenant ADMIN to a team: row deactivated and pending,
  `key_distributed = false`, and the user has an ECDH public key (preconditions asserted);
  the ADMIN gets 404 from `GET /api/teams/[teamId]` and the team passwords list; a
  key-holding team ADMIN's `pending-key-distributions` does not list them while it does
  list an active undistributed member (positive control).
- A2 A key-holding team ADMIN (and, separately, the OWNER) approves: the same user now
  appears in pending key distributions, confirm-key distributes and audits
  `TEAM_MEMBER_KEY_DISTRIBUTE`; the routes of A1 answer 200.
- A3 Approver checks: the pending member calling approve on their own row → 404; a
  tenant ADMIN outside the team → 404; an active team ADMIN without the key → 403
  (reject by the same caller → 200).
- A4 SCIM PUT omitting a pending user deletes the row (WITHDRAW audit); a repeated PUT
  listing it is a no-op (`added = 0`, one PENDING audit row in total); PATCH remove
  deletes it too; a PUT listing a departed member is a no-op.
- A5 Pending → removed → re-added ends pending again. Stale keys: an active member with
  seeded `team_member_keys` (count asserted > 0) → SCIM removed → re-added ends pending,
  `key_distributed = false`, key count 0.
- A5b Reject (and, separately, SCIM DELETE /Users of a user asserted to hold a pending
  row in T, with tenant and team rows asserted gone afterwards), then a PATCH removing
  that user plus an active member → 200; the active member is deactivated;
  `SCIM_GROUP_UPDATE.removed = 1`; no transition audit for the absent user.
- A5c Departure vs SCIM remove: U's departure parked at its team lock (blocker holding
  T's row `FOR NO KEY UPDATE`, departure asserted parked) while holding U's advisory
  lock; a SCIM PATCH removing U is `blocked-on-parked`; release → U's row is unmarked
  with `TEAM_MEMBER_SCIM_REMOVE` `departed: true`; U's return to the tenant transitions
  U (asserted) and does not restore T's row.
- A6 Approval refuses a target who left the tenant (409). Race: the target is also an
  active member of a second team T2; the departure (SCIM user deactivate) takes the
  target's advisory lock and parks on a blocker holding T2's row `FOR NO KEY UPDATE`
  (asserted parked); the approval of T's pending row is then `blocked-on-parked`;
  release → 409.
- A7 Concurrent approvals: approver 1 parked on a blocker holding T's row
  `FOR NO KEY UPDATE`; approver 2 is `blocked-on-parked` (target's advisory lock);
  release → one 200, one 404, one approve audit row.
- A7b Approve vs SCIM withdraw: approval parked at its team lock holding the target's
  advisory lock; a SCIM PATCH remove (and, separately, a PUT omitting the target) is
  `blocked-on-parked`; release → approve 200, then SCIM deactivates the now-active
  member with `TEAM_MEMBER_SCIM_REMOVE` and no WITHDRAW. Mirror with reject → reject 200,
  the SCIM PATCH/PUT 200, removes nothing and writes no WITHDRAW.
- A7c PUT vs a concurrent add: a blocker holds a requested user R's advisory lock so the
  PUT parks after its pre-read; a PATCH add of X (not in the PUT) commits; release →
  PUT 200, X's row still pending, no WITHDRAW.
- A7d A concurrent ownership transfer promoting X to OWNER, committed after SCIM's
  pre-read of X: SCIM's role CAS changes nothing, X stays OWNER, no ROLE_UPDATE audit.
- A7e Statement count is independent of N: in `Groups/[id]/route.test.ts`, with a
  partial audit mock keeping `logAuditBulkInTx` real and a fake tx counting
  `auditOutbox.create` / `createMany` / `$queryRaw`, a fixture where every transition
  (kind, write shape) group — became pending by create, by update, pending raised,
  withdrawn, active removed, departed unmarked, role changed — has one previous role
  (create: none; the create group contributes exactly one `createMany`) and 2 rows at N = 14 and 10 rows at N = 70 (asserted in the fixture builder), giving
  the same call counts: one `createMany` per action present (rows sum to N), zero `create`, one
  `teamMember` write per (kind, write shape, previous role), and an N-independent
  `teamMemberKey.deleteMany` count. Unit: `logAuditBulkInTx` does one scope
  read and one `createMany`; a tenant mismatch throws.
- A8 Reject deletes the pending row (audit); approve after reject → 404. Reject and
  approve of an active member and of a departure-marked row → 404, row intact, no audit;
  of a member of another team (same memberId, other teamId) → 404.
- A9 Direct SQL: a valid pending row inserts (positive control); a pending active row, a
  pending departure-marked row, a pending non-`scim_managed` row and a pending OWNER row
  each break exactly one CHECK and fail with `{ code: "23514", constraint: <name> }`. Tenant
  departure and return of a user holding a pending row in T and an active row in T2:
  T2's row is marked then restored (positive control), T's stays pending and unmarked.
- A10 TEAM-scope audit rows (exact scope, team, target, metadata incl. `scimTokenId`)
  for mapping creation, pending, pending role raise, withdraw, SCIM removal, departed
  unmarked, SCIM role change (each SCIM transition through PUT and through PATCH),
  approve, reject, key distribution — read from `audit_outbox` with the workers
  stopped. Confirm-key's refused branches (already distributed, CAS count 0, in-flight
  rotation) emit no `TEAM_MEMBER_KEY_DISTRIBUTE`. The new actions are in
  `TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS` and `AUDIT_ACTION_GROUPS_TEAM`.
- A11 Members GET (real DB) shows pending rows to an ADMIN, not to a MEMBER or VIEWER.
  Component tests: the list page renders Approve/Reject for a pending row, step-up
  denial on each, and the role-changed 409; transfer-ownership excludes a pending row.
- A12 Approve with a stale `expectedRole` (pending row raised MEMBER → ADMIN by a second
  group add) → 409, row still pending.
- A13 SCIM: `GET /Groups` (route level) and `GET /Groups/{id}` list a pending member and
  still exclude a cross-tenant guest; a pending row takes the higher role and a lower
  role add never lowers it; a PATCH add of a pending user who left the tenant is
  skipped (200, row unchanged).
- A14 Invitation accept of a user whose pending row SCIM created after the pre-check →
  409 `SCIM_APPROVAL_PENDING`, invitation still PENDING (unit, in-transaction branch);
  members POST and invitation create of a pending user → `SCIM_APPROVAL_PENDING`, of a
  SCIM-removed user → `SCIM_MANAGED_MEMBER`; the add UI renders each message.

## Testing strategy

- Real-DB integration `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`
  for A1-A10, A12, A13 and A11's GET half, through the SCIM routes (the `with-scim-auth`
  mock supplies the token id), approve/reject and confirm-key (opaque hex key material);
  races through `race-helpers.ts`; workers stopped.
- Existing tests whose meaning changes (to rewrite): the `#987` integration cell "a SCIM
  group add reactivates a deactivated membership in place";
  `scim-cross-tenant-users.integration.test.ts` (guest exclusion via the new reader);
  `team-key-version-guard.integration.test.ts` (confirm-key refusal emits no
  KEY_DISTRIBUTE; its direct `patchScimGroup` cell passes a transaction);
  `scim-group-service.test.ts` (create/reactivate/reader `where`, transaction-only, CAS
  removals; the cell "throws ScimNoSuchMemberError when removing a userId not in the
  team" inverts to a no-op); `Groups/[id]/route.test.ts` "returns 400 when removing a
  missing member" inverts to 200; `Groups/route.test.ts` and `Groups/[id]/route.test.ts` (audit mocks);
  members GET/POST route tests; `invitations/route.test.ts`; invitation accept route
  test; `confirm-key/route.test.ts`; `team-add-from-tenant-section.test.tsx`.
- Unit: approve/reject routes; the gate's rule 7 self-tests; audit group membership.
- Red-proofs on a scratch worktree (each drops the predicate from both the locked
  target read and the CAS): create back to active (A1); drop the approver key re-read
  (A3); drop the tenant-row re-check (A6); drop the pending condition (A7), and a variant
  also dropping `deactivatedAt: { not: null }` (two approve audit rows); drop reject's
  pending predicate (A8); drop the role pin (A12); drop the remove users from
  `lockGroupWrite` (A7b — red via `settledOrBlocked`'s "write waited on the blocker,
  not the parked transaction", which is the expected failure); remove the
  outside-the-lock-set skip (A7c); drop the role CAS predicate (A7d); drop the
  `teamMemberKey.deleteMany` (A5); replace `logAuditBulkInTx` with a per-user
  `logAuditInTx` loop, and split the withdraw `deleteMany` into a per-id loop (A7e);
  narrow `lockGroupWrite` back to add users only (A5c — red via `settledOrBlocked`'s
  "write waited on the blocker"); make a withdraw shortfall silent (cell in
  `Groups/[id]/route.test.ts`: `findMany` k rows, `deleteMany` k−1 → the
  `withTenantRls` callback rejects with the error, SCIM 409, no WITHDRAW `createMany`;
  positive control equal counts → 200 with one WITHDRAW `createMany` of k rows — run
  once through PUT and once through PATCH; red-proof per verb: move that verb's 409 arm
  inside the callback → "callback resolved"); drop the audit emitter call
  from PUT, and separately from PATCH (A10); drop the pending-OWNER CHECK (A9); make an absent
  remove throw again (A5b); leave the PUT current-member set unchanged (A4); revert
  `Groups/route.ts` to the active-only reader (A13); drop each audit call (A10).

## Considerations & constraints

- SC1 Existing SCIM-admitted members are not made pending retroactively; C7 gives
  operators a listing to review them.
- SC2 Who may mint SCIM tokens (`SCIM_MANAGE`) is unchanged.
- SC3 SCIM tokens are not re-checked against their creator's current role; a demoted or
  departed creator's token can still add (now pending), remove and change roles of team
  members — follow-up issue.
- SC4 A team's rejection or removal is undone by the next SCIM sync as a new pending
  request; the team rejects again or the IdP mapping changes.
- SC5 A team with no active key-holding OWNER/ADMIN cannot approve (it can reject); the
  tenant owner-assignment route (`#987`) is the way out for ownerless teams.
- SC6 A user listed in two groups of one team: active members keep today's behaviour
  (role follows the latest sync; now each flip also writes `TEAM_MEMBER_SCIM_ROLE_UPDATE`
  and a team webhook); a pending row takes the higher role; removal from the higher
  group deletes the pending row although the lower group still lists the user, and an
  IdP that sends only changes does not re-send it.
- Adjacent, not changed: `memberCount` counts deactivated rows; `members/search` lists
  pending users (the add then answers 409).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Schema: pending marker and CHECKs | locked |
| C2 | SCIM writes (CAS removals, add ∪ remove locked) and the readers | locked |
| C3 | Approve (role-pinned) and reject | locked |
| C4 | Visibility (TEAM scope, in-tx, route-emitted) | locked |
| C5 | Team members UI | locked |
| C6 | Team-side add, distinct pending code, invitation accept re-check | locked |
| C6b | SCIM spec doc and 400 message | locked |
| C7 | Operator listing of existing SCIM memberships | locked |
