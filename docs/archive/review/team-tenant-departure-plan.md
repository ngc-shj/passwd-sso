# Plan: team-tenant-departure (v6)

Branch: `fix/team-tenant-departure`, stacked on `fix/team-key-rotation-write-race`
(PR #986), whose rotation locks it uses. Follow-up to #979.
Background: `docs/archive/review/team-key-rotation-write-race-code-review.md`
rounds 3–4. Plan review record: `docs/archive/review/team-tenant-departure-review.md`
(written at the end of Phase 1).

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, RLS); web, extension
  and iOS clients consume the team APIs.
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none blocking.

## Objective

When a user's membership of a tenant is deactivated or deleted, their
memberships of that tenant's teams end with it: they are not served,
distributed or wrapped a team key and do not act in those teams; admission
back needs an invitation issued after the departure. When the tenant
membership is reactivated, exactly the team memberships the departure ended
come back. Keys a client already cached are not revoked (SC1).

## Design

Departure is written onto the team memberships with the state every reader
already honours, `team_members.deactivated_at`, plus a marker
`deactivated_by_tenant` so a tenant reactivation restores exactly those rows.
Earlier designs (keyDistributed=false; a live predicate; admission snapshots)
failed review — see the background docs. No reader of membership, admin rights,
pending distribution, rotation, member-key or team lists changes.

Admission back is decided where it is written, against the invitee's and the
inviter's tenant rows read under the team tenant's RLS (where they are visible)
and locked — not by finding invitations by email at departure time, which
tenant RLS can hide (S1). SCIM DELETE removes the row the decision reads, so it
leaves a departure record keyed by user id (`tenant_member_departures`, C1);
admission reads the row's `deactivated_at` and that record alike. No step
matches invitations by email.

### Lock order (every transaction in this plan)

`tenant_members` rows → `teams` rows → `team_invitations` rows →
`team_members` / `team_member_keys` rows. Within a level, rows are locked in
one statement ordered by primary key (`ORDER BY user_id` / `ORDER BY id`).
A transaction locks its `tenant_members` rows in ONE `lockTenantRows` call,
covering every user it will admit, depart or return, before any team lock —
including a directory-sync run, which decides all transitions first and then
calls the C2/C3 helpers once each with the batch, in an already-locked mode.
Every wait on a `tenant_members` or `teams` row goes through
`withBoundedLockWait` (exported); the waits of one transaction share ONE
deadline of `TEAM_KEY_LOCK_TIMEOUT_MS` (a spent deadline fails before the
wait; the remaining time is never passed as `lock_timeout = 0`, which
PostgreSQL reads as "no limit"), and a transaction that waits on both
levels passes an explicit Prisma timeout above that deadline plus its work.
Lock timeout (55P03), deadlock (40P01) and transaction expiry (P2028) map to a
409 (routes) or a failed run (directory sync); a tenant-row timeout has its
own error and message, distinct from "rotation in progress".

Why this order holds against the existing writers:
- Rotation (#986) locks teams FOR NO KEY UPDATE and no tenant row; it never
  waits on a transaction of this plan that holds a tenant row.
- Admission writers lock the tenant rows FOR SHARE before the team row; a
  departure holding a tenant row FOR UPDATE and waiting on a team row FOR
  SHARE never conflicts with an admission writer's team FOR SHARE.
- #986's SCIM DELETE locks teams first; it is reordered to lock the tenant row
  first (C2). Member DELETE and vault reset take no tenant row; unchanged.

`src/lib/team/tenant-row-lock.ts`
`lockTenantRows(tx, tenantId, userIds, mode: "share" | "update")`: one
`SELECT user_id, deactivated_at FROM tenant_members WHERE tenant_id = $t AND
user_id = ANY($u) ORDER BY user_id FOR SHARE|FOR UPDATE` under the bounded
wait. Before the row lock it takes `pg_advisory_xact_lock` on (tenant, user)
for every requested user, in the same order, so a user with NO row is
serialised too: the create-deactivated arms (C2) take the same advisory lock
before inserting the row, and an admission of a guest therefore either
commits first (and is departed by step 3–5) or waits and reads the new
deactivated row. Returns, per user, the row's `deactivatedAt` (or "no row") and the
departure record's `departedAt` (read in the same transaction; the record is
written only under the row's FOR UPDATE, so the row lock serialises it).

### Clock

- Departure stamps `deactivated_at = clock_timestamp()`, evaluated in the
  UPDATE that runs after the tenant row lock (not `now()`, the transaction
  start, which precedes the lock wait and, in a directory-sync run, the whole
  run).
- `team_invitations.created_at` becomes
  `@default(dbgenerated("clock_timestamp()"))`, so the database fills it at
  insert time, after the POST's tenant row locks. The Prisma client then omits
  the column; no client clock reaches the comparison.
- Every writer that stamps a departure uses the database clock, including the
  create-deactivated arms (C2).
- "Departure after issue" is `departed >= created_at`, where `departed` is the
  user's row `deactivated_at` or their departure record's `departed_at`; equal
  is a refusal. One predicate, for invitee and inviter alike, used by accept,
  invitation POST and the backfill.

## Contracts

### C1 Schema and backfill

- Migration A (additive):
  - `team_members.deactivated_by_tenant boolean NOT NULL DEFAULT false`
    (Prisma `deactivatedByTenant`), with
    `CHECK (NOT deactivated_by_tenant OR deactivated_at IS NOT NULL)`.
  - `team_invitations.created_at DEFAULT clock_timestamp()`.
  - `tenant_member_departures (tenant_id, user_id, departed_at)`, primary key
    `(tenant_id, user_id)`, tenant RLS like `tenant_members`; written
    (upsert, `departed_at = clock_timestamp()`) by SCIM DELETE only. It is
    never deleted by a re-create: a later row does not erase the fact that
    invitations issued before the deletion are void. FKs to `tenants` and
    `users` with `ON DELETE CASCADE`; registered wherever a tenant table is
    (RLS cross-tenant manifest, the model→table map in
    `tenant-rls-grants.ts`, the DB grants manifest and audit, RDS role
    bootstrap).
  - Deactivation and deletion differ on purpose: a return (C3) restores the
    status quo ante, so invitations issued before a deactivation become
    acceptable again with the row; a deletion is not reversible by the IdP
    (a re-create is a new provisioning), so the record keeps them void.
- Backfill (marker-delimited block in `migration.sql`, idempotent):
  1. active memberships whose user's row in the team's tenant is deactivated
     AND whose `team_members.created_at` precedes that `deactivated_at` →
     `deactivated_at = tenant row's value`, `deactivated_by_tenant = true`;
  2. PENDING invitations of a tenant's teams
     a. issued by a user whose row in that tenant is deactivated, with
        `deactivated_at >= created_at` → `EXPIRED`;
     b. addressed (lower(email)) to a user whose row in that tenant is
        deactivated, with `deactivated_at >= created_at` → `EXPIRED`;
     c. addressed to a user with no row in that tenant and a `SCIM_USER_DELETE`
        audit row of that tenant targeting them created at or after the
        invitation → `EXPIRED`, and a departure record seeded from the
        latest such audit row (best effort: audit retention may have purged
        the row; the residual is a documented one-time constraint; the audit
        `created_at` is the outbox time, slightly after the delete, which
        fails closed for an invitation issued in between);
  3. `RAISE NOTICE` the counts (memberships, invitations per arm, teams left
     with no active OWNER). The ownerless-team query is also in the runbook.
- Known effect: a user re-invited before this change by an upsert-update over
  an old row is indistinguishable from a departed member and is deactivated;
  remedy: re-invite. Directory sync used to re-stamp `deactivated_at`, so the
  `created_at` condition fails closed for legacy rows.

### C2 Departure (tenant row active → inactive, or deleted)

`src/lib/team/team-departure.ts`
`departFromTenant(tx, tenantId, userIds): Promise<string[]>` returns the users
that transitioned. In one transaction, in this order:
1. `lockTenantRows(tx, tenantId, userIds, "update")` — skipped in the
   already-locked mode, where the caller has locked a superset in its one
   call.
2. `UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE
   tenant_id = $t AND user_id = ANY($u) AND deactivated_at IS NULL AND
   role <> 'OWNER' RETURNING user_id` — the statement decides both "is this a
   departure" and "is it allowed" (stamp-once; tenant OWNER never departed).
3. Read the transitioned users' ACTIVE memberships of the tenant's teams and
   lock those teams (`lockTeamsAgainstRotation`, one call). Every admission
   writer holds the user's tenant row before inserting a membership (C5), so
   after step 1 the set cannot grow; step 5's `assertTeamsLocked` is an
   invariant check, not an expected refusal.
4. Expire PENDING invitations of the tenant's teams issued by transitioned
   users. Any invitation POST by them committed before step 1 got its lock
   (POST holds the inviter's row FOR SHARE until commit) or is refused by POST.
5. Deactivate those memberships (`deactivated_by_tenant = true`)
   `RETURNING team_id` → `assertTeamsLocked`; emit
   `TEAM_MEMBER_TENANT_DEACTIVATE` per row (C9).
- Invitations addressed TO the departed user stay PENDING; accept refuses them
  (C5) and invitation POST expires them when it meets one (C5).
- Callers derive audit action, session invalidation, `activated`/counters from
  the returned ids, not from a pre-read.
- SCIM DELETE (`deactivateScimUser`), reordered: `lockTenantRows(…, "update")`
  → upsert the departure record → team locks of their memberships of the
  tenant's teams → expire PENDING invitations of the tenant's teams issued by
  the user → delete memberships (`assertTeamsLocked`, as in #986) → delete the
  tenant row. A re-created row (SCIM POST, SSO sign-in) does not make a
  pre-delete invitation acceptable: accept compares it with the record (C5).
- Create-deactivated (SCIM POST `active=false`, directory-sync create of a
  deactivated user): the user may already hold memberships of the tenant's
  teams as a guest, so the row is created active and departed through
  `departFromTenant` in the same transaction (database-clock stamp, steps
  3–5).
- Member set, derived with
  `rg -n 'tenantMember\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\(' src scripts`
  and `rg -n -i '(update|insert into|delete from)\s+"?tenant_members' src scripts`:
  departures = SCIM PUT (`active === false`), SCIM PATCH (`active: false`),
  directory-sync per-user update and batch deactivation, SCIM DELETE,
  create-deactivated (SCIM POST, directory sync).
  Not departures (C8 exemptions, each with its reason):
  - directory-sync refusal arm: no state change;
  - `auth-adapter` `deleteUser` (cascade): Auth.js core never calls it; C8
    fails on any new caller;
  - bootstrap move delete+create (`src/auth.ts`): deletes the user's
    bootstrap-tenant row, which is role OWNER (never departed), and creates a
    target row only when none exists;
  - sign-in upserts (`update: {}`), `auth-adapter` create (active), tenant
    member role updates.
- Refusals: SCIM PUT/PATCH/DELETE map `isTeamRotationConflict` and the tenant
  row timeout to 409; directory sync records the run as failed and retries
  next run.

### C3 Return (tenant row inactive → active)

`returnToTenant(tx, tenantId, userIds): Promise<string[]>`:
1. `lockTenantRows(…, "update")` (skipped in the already-locked mode);
2. `UPDATE tenant_members SET deactivated_at = NULL WHERE … AND deactivated_at
   IS NOT NULL RETURNING user_id`;
3. team locks (one call, marker rows' teams of the transitioned users);
4. restore marker memberships (`deactivated_at = NULL`, marker false)
   `RETURNING team_id` → `assertTeamsLocked`; emit `TEAM_MEMBER_TENANT_RESTORE`.
- Member set: SCIM PUT with `active !== false`, SCIM PATCH `active: true`,
  directory-sync reactivation arms. Refused reactivations
  (`ACTIVE_IN_ANOTHER_TENANT`) do not call it.

### C4 Rotation leaves deactivated members pending

In #986's rotation transaction: memberships with `deactivated_at IS NOT NULL
AND key_distributed` → `key_distributed = false`. A return after a rotation is
listed for distribution of the new key; with no rotation between, the member
returns with their key.

### C5 Admission

Admission writers, derived with
`rg -n 'teamMember\.(create|createMany|upsert)\(|members:\s*\{' src`,
`rg -n 'teamInvitation\.(create|createMany)\(' src`, and reactivations
(`teamMember.update`/`updateMany` setting `deactivatedAt: null`):
invitation accept, members POST, SCIM group add (PUT replace and PATCH add),
team create (`POST /api/teams`, nested OWNER membership), invitation POST.
Each runs in one transaction that calls `lockTenantRows(…, "share")` for the
users it admits (and, for accept and POST, the inviter) before any team lock
or membership/invitation write, and refuses on the read values:

- Invitation accept: the invitation, invitee and inviter ids come from the
  pre-transaction read. `lockTenantRows([invitee, inviter])` →
  `lockTeamsAgainstRotation` → conditional claim (`status = PENDING`, same id
  and inviter) — a claim that matches 0 rows is "invitation no longer valid"
  (covers departure step 4's expiry) → if the invitee or the inviter departed
  at or after `invitation.created_at` (row `deactivated_at` or departure
  record), write the invitation `EXPIRED` and refuse (403
  `INVITATION_EXPIRED`) — the refusal is returned from the transaction, not
  thrown, so the `EXPIRED` write commits → else re-admit (upsert-update:
  `deactivatedAt: null`, `deactivatedByTenant: false`, `keyDistributed:
  false`, `scimManaged: false`, delete the membership's member keys).
  The inviter check is defence in depth behind C2 step 4 (legacy rows, backfill
  residue). The SCIM-managed refusal follows C6's rule.
- Members POST: the target's locked row must be active; a reactivated row sets
  `deactivatedByTenant: false` and deletes stale member keys.
- SCIM group add: locked rows; a user whose row is inactive and who holds a
  marker row is "already present" (no-op, marker kept); reactivating a
  deactivated non-marker row needs an active tenant row, sets marker false,
  deletes stale keys (fixes the P2002 500).
- Team create: the creator's locked row must be active (403 otherwise),
  checked after `requireTenantPermission` and before the create.
- Invitation POST: resolve the invitee through the existing bypass lookup
  (`CROSS_TENANT_USER_LOOKUP`), case-insensitively, and lock the inviter's row
  and every matched invitee's row in the one call. The inviter's authority is
  their active team membership (departure step 5 ends it); the lock only
  serialises POST with the inviter's departure (step 4 then sees the row).
  Refuse an ACTIVE membership; a PENDING invitation for the same lower(email)
  whose invitee departed at or after `existing.created_at` is written
  `EXPIRED` and the new invitation proceeds; any other PENDING one →
  `INVITATION_ALREADY_SENT` as today. Lookups of pending invitations are
  case-insensitive.

### C6 Team-level control of departed rows

- Members GET returns marker rows with `departed: true` only to callers with
  team member-management permission; other members do not see them.
  `TeamMemberDisplayRow`/`Item`, `buildTeamMemberDisplayItems` and
  `buildMemberRoleResponse` carry `departed`. The admin members list shows a
  badge and only the remove control for departed rows (no role Select);
  `transfer-ownership` excludes them.
- Members DELETE accepts a marker row: inside the transaction, after the team
  lock, the row is re-read (marker or active), hard-deleted with its member
  keys; session invalidation and `TEAM_MEMBER_REMOVE` audit as for any row.
  A later return does not restore it.
- SCIM group PUT replace includes marker rows in its diff; an absent marker
  row gets marker false and keeps its `deactivated_at`; PATCH remove
  (`applyRemoveOperations`) likewise clears only the marker for marker rows.
- Re-inviting a deactivated SCIM-managed row is allowed only for a marker row
  (the IdP group removal keeps refusing).
- Member PUT (role change, ownership transfer): inside the transaction, team
  lock, then conditional updates requiring the actor's and the target's rows
  to be active (`deactivatedAt: null`); a count ≠ 1 refuses (404/409), so a
  concurrent departure of either is not acted on.

### C7 Ownerless team

- Permission: new `TENANT_PERMISSION.TEAM_OWNER_ASSIGN`, granted to tenant
  OWNER and ADMIN, resolved for the actor's session tenant via
  `requireTenantPermission`.
- `GET /api/tenant/teams/ownerless` (requires `TEAM_OWNER_ASSIGN`): teams of
  the actor's tenant (tenant RLS) with no active OWNER: id, name, active
  member count.
- `POST /api/tenant/teams/[teamId]/owner` `{ userId }`:
  - rate limiter keyed by actor (`createRateLimiter`);
  - step-up (`requireRecentCurrentAuthMethod`) with the repo's
    `@stepup id:… method:POST` annotation paired with the client;
  - team read under the actor's tenant RLS; another tenant's team → 404;
  - one transaction: `lockTenantRows([actor, target], "share")` (both active
    in the tenant, else 409) → `teams … FOR NO KEY UPDATE` through the bounded
    wait (409) → re-check "no active OWNER" and target active team member →
    demote every other `role = OWNER` row to ADMIN → promote target → audit
    `TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN` in-tx, metadata `{ targetUserId,
    demotedUserIds, selfAssigned }`;
  - self-assignment (actor = target) is refused unless the actor is tenant
    OWNER. This is a guard against mistakes, not an authorization boundary: a
    tenant ADMIN holds `SCIM_MANAGE` and can already add itself to a team
    through a SCIM group mapping (follow-up, see Considerations).
- UI: the tenant admin teams page lists the ownerless teams and offers the
  action with a picker of active members.
- A team with no active member cannot be recovered except by a return
  (documented).

### C8 CI gate

Restore `scripts/checks/check-team-rotation-input-lock.mjs` (AST, Program-free)
and its self-test, wired as a `run_step` in `scripts/pre-pr.sh`:
- member-set writes need a rotation lock before them;
- `tenantMember` writes that may set `deactivatedAt` (object literal key,
  shorthand, spread, identifier `data`) are only in `team-departure.ts`, except
  C2's named exemptions; raw `tenant_members … deactivated_at` writes outside
  it fail;
- every C5 admission writer calls `lockTenantRows` before its first
  `teamMember`/`teamInvitation` write and before `lockTeamsAgainstRotation`;
- at most one `lockTenantRows` call per transaction callback (helpers in
  already-locked mode excepted); no call inside a loop;
- no caller of the adapter's `deleteUser`;
- `tenantMemberDeparture` / `tenant_member_departures` is written only by
  `deactivateScimUser` (and the backfill) and deleted by nothing but FK
  cascade;
- a create-deactivated arm takes the advisory lock before its insert;
- counts measured on this branch and pinned; the gate is run against the base
  tree and must flag exactly the derived writers; header: presence check.

### C9 Audit

New actions `TEAM_MEMBER_TENANT_DEACTIVATE`, `TEAM_MEMBER_TENANT_RESTORE`,
`TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN` (team-scoped), registered in action
groups, i18n, and the team webhook subscriptions (team-scoped rows reach the
tenant audit log and tenant webhooks through the existing team-scope routing),
with tests (R12). Metadata of the tenant actions is `{ source:
"TENANT_DEACTIVATION" | "TENANT_REACTIVATION" }` only — no IdP, SCIM or
directory detail, since guest team admins of another tenant read team-scoped
rows.

## Forbidden patterns

- pattern: `keyDistributed: false` in `scim-user-service.ts` or
  `directory-sync/engine.ts` — reason: departure is deactivation.
- pattern: `deactivatedAt` assigned on a `tenantMember` write outside
  `team-departure.ts` and C2's exemptions — reason: a departure without its
  team effects.
- pattern: a user or invitation lookup BY EMAIL in `team-departure.ts` or
  `deactivateScimUser` — reason: tenant RLS hides users of other owning
  tenants (S1), and email matching misses changed or differently-cased
  addresses; departure is recorded by user id.
- pattern: `now()` / `new Date()` as the departure stamp or an invitation's
  `createdAt` — reason: not commit-ordered with the locks (Clock).
- pattern: a team lock taken before `lockTenantRows` in the same transaction
  — reason: lock order.

## Acceptance criteria (each red-proved by removing its clause alone)

Round 5 found no design Critical; its Majors were mechanism (lock batching,
timeout budget, parking points, mock fallout). From v6 the plan carries
decisions and invariants; exact parking statements, fixture SQL and the unit
mock fallout are settled in Phase 2 by running them, and Phase 3 reviews them.
Rule for every race cell: name the row lock the subject waits on, witness the
wait with `pg_blocking_pids`, and show the cell red against the variant
without the clause (a cell that also fails through Prisma's 5 s timeout or a
different error does not count). A clause that cannot be observed in
behaviour (`created_at` default) is pinned by a schema assertion instead and
listed as such. The race helpers move out of
`team-key-version-guard.integration.test.ts` into a shared helper.

Integration (production services/routes under their real RLS contexts; each
fixture's rows asserted present before the act):
- A1 SCIM PATCH `active=false`: memberships of the tenant's teams deactivated
  with the marker; member-key 404; absent from GET /api/teams, admin list,
  pending; rotation neither requires nor accepts. PENDING invitations issued
  by the user → EXPIRED; addressed to the user → still PENDING. Same user's
  membership of a team in ANOTHER tenant untouched; a guest of the same team
  untouched. One `TEAM_MEMBER_TENANT_DEACTIVATE` per deactivated row.
- A2 Accept:
  - invitation issued before the departure → 403, invitation EXPIRED, no
    membership; the same with a diverged `users.tenant_id`;
  - issued by a user who then departed (seeded PENDING by raw SQL, bypassing
    C2 step 4) → refused;
  - issued at exactly `deactivated_at` → refused;
  - issued after the departure → accepted; the re-admitted row has
    `deactivatedAt` null, marker false, `keyDistributed` false, `scimManaged`
    false, and its old member keys are gone;
  - SCIM DELETE, then accept of a pre-delete invitation → refused; SCIM
    DELETE, SSO re-sign-in (row re-created), then accept → refused; the same
    for a user whose `users.tenant_id` names another tenant; an invitation
    issued after the DELETE → accepted;
  - create-deactivated (SCIM POST `active=false`) of a guest holding a
    membership of the tenant's team → membership deactivated with the marker;
  - the `EXPIRED` status is asserted after every refusal;
  - mixed-case email pairs for POST and accept.
- A3 Re-deactivation (SCIM PUT again; directory-sync rename) of a user with a
  re-admitted active membership: stamp byte-equal; membership stays active;
  post-departure invitations stay PENDING; zero audit rows.
- A4 Return with no rotation: member-key 200, one `TEAM_MEMBER_TENANT_RESTORE`
  per row. Return after rotation: pending, confirm-key distributes v2.
- A5 SCIM group PATCH remove of a departed member, and members DELETE of a
  marker row, survive a return; group PUT omitting them likewise.
- A6 Re-invitation after departure incl. a SCIM-managed marker row: POST
  expires the stale pre-departure invitation and succeeds; a group-removed
  SCIM-managed row stays refused.
- A7 SCIM group add of a user with a deactivated non-marker row (tenant
  active): reactivated, marker false, keyDistributed false, stale keys gone
  (was P2002); departed user in a group sync: no-op, request succeeds, marker
  kept, restored by a later return.
- A8 Ownerless: GET lists exactly the ownerless teams of the actor's tenant;
  tenant ADMIN assigns OWNER (step-up), exactly one OWNER after a later return.
  Refused, each asserting no role change and no audit row: a team ADMIN; a
  tenant MEMBER; a tenant ADMIN of another tenant (404); a team with an active
  OWNER; a non-active target; stale step-up; self-assignment by a tenant ADMIN
  (allowed for a tenant OWNER, `selfAssigned: true`).
- A9 Backfill block read from the migration file, run in a rolled-back
  transaction as the migration role, fixtures named per cell: membership
  created before / after the departure; cross-tenant membership; invitation
  arms 2a, 2b (before, equal, after), 2c (audit row before / after / absent);
  mixed-case email; second run changes 0 rows.
- A10 Races (both orders unless stated): departure vs rotation; departure vs
  accept, including accept of an invitation the departing user issued (no
  40P01); departure vs invitation POST, including a two-user departure parked
  on its first user while an invitation to the second is issued (the
  `clock_timestamp()` cell: accept refused); departure vs members POST;
  departure vs team create; SCIM DELETE vs accept; owner assign vs departure;
  create-deactivated (SCIM POST `active=false`) vs a guest's accept;
  a two-user directory-sync run vs accept with the users in reverse order and
  vs owner assign (no 40P01); confirm-key vs departure (regression pin of the
  existing conditional update, not a red-proof of this plan).
- A11 Directory sync: batch deactivation (OWNER stays), per-user deactivate and
  reactivate, refused reactivation leaves team rows deactivated;
  `usersDeactivated` counts transitions; a tenant-row lock timeout fails the
  run with the tenant-row error inside the deadline (not P2028).
- A13 Member PUT: role change and ownership transfer against a concurrently
  departed target or actor → refused, no role change.
- A14 Members POST reactivation of a deactivated row: marker false,
  `keyDistributed` false, stale keys gone. Invitation POST with a stale
  PENDING invitation issued at exactly the departure → expired and replaced.
- Schema: `team_invitations.created_at` default is `clock_timestamp()`; the
  marker CHECK refuses a marker on an active row.
- A12 Members GET: marker rows with `departed: true` for a team ADMIN, absent
  for a VIEWER; members DELETE of a non-member id → 404; of a marker row →
  row and keys gone; group PUT including a marker row → marker kept.
Unit: callers use C2/C3 and derive audit/session from returned ids; engine and
SCIM unit "not called" assertions rewritten to the helpers; both invitation
POST test trees, accept, members, members/[memberId], team create, scim
services, engine, rotate-key, ownerless routes; gate self-test with deny
spellings and exemption-adjacent denies; list/transfer page badge/exclusion;
audit action registration.
CI: `.github/workflows/ci-integration.yml` path filter gains
`src/lib/team/**`, `src/lib/directory-sync/**`, `src/lib/scim/**`.

## Considerations & constraints

- SC1 ItemKey/history/attachment re-key on rotation — follow-up issue.
- SC2 iOS sync aborting on one team's error — follow-up.
- SC3 Share links a departed user created stay live — follow-up.
- SCIM DELETE (IdP hard-delete) removes the memberships of the tenant's teams,
  expires invitations issued by the user and records the departure; admins
  re-invite.
- Backfill arm 2c depends on retained audit rows; PENDING invitations to users
  SCIM-deleted before this change whose audit row was purged stay PENDING
  (one-time residual; runbook query lists PENDING invitations to non-members).
- An invitation addressed to an email that, after a SCIM DELETE, belongs to a
  different user is that user's invitation; the departure record is per user.
- A member re-admitted while their tenant row is inactive is not seen by SCIM
  group GET/PUT (`loadGroupMembers` filters on an active tenant row); the row
  is `scimManaged = false`, so the IdP does not own it (documented).
- Follow-up: a tenant ADMIN can add itself to any team through a SCIM group
  mapping and receive the team key from admins' browsers. Separate issue.
- Contractor → employee: guest-era memberships of the tenant's teams get the
  marker on departure and stay deactivated if the user remains elsewhere;
  re-invite (documented).
- A rotation, or a directory-sync run holding tenant rows, past the lock wait
  fails the waiting request with 409 or the run; the run is retried.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Marker column, CHECK, created_at default, backfill | Go |
| C2 | Departure incl. SCIM DELETE | Go |
| C3 | Return | Go |
| C4 | Rotation leaves deactivated members pending | Go |
| C5 | Admission writers lock tenant rows | Go |
| C6 | Team-level control of departed rows | Go |
| C7 | Ownerless team | Go |
| C8 | CI gate | Go |
| C9 | Audit | Go |
