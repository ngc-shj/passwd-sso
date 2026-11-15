# Plan: leftover-team-actor-authority

Issue `#1055`. Follow-up of `#1035` / PR `#1043` (`departed-member-leaked-authority-plan.md`).
Revision 4 (round-1 to round-3 findings applied; history in `leftover-team-actor-authority-review.md`).

## Project context

- Type: web app (Next.js App Router, Prisma 7, PostgreSQL 16 with FORCE RLS) plus the audit-outbox
  worker.
- Test infrastructure: unit + integration (real DB) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: the worktree has its own database (`passwd_sso_wt_leftover_team_actor`), so integration
    tests run without stopping the compose workers. `verifiable-local`.
  - VE2: the outbox worker's real privileges. Delivery cells run as `ctx.worker.prisma`
    (`passwd_outbox_worker`, NOSUPERUSER) and assert `current_user` and `rolbypassrls = false`, as
    #1043 C6 did. `verifiable-local`.
  - VE3: `scripts/__tests__/backup-db.test.mjs` Group B needs a `pg_restore`: the host binary in
    CI, the compose `db` service on the dev host (this host has no host binary). C7.
    `verifiable-local` from both the primary checkout and a worktree.

## Objective

A **leftover membership** — an active `team_members` row whose user departed the team's tenant at
or after their admission to the team (`actorDepartedSinceAdmission`, #1043 C4) — grants no team
authority of any kind: not to act on other members, not to read or write the team's data, not to
fetch the team key, not to count as a key holder, and not to keep a webhook delivering.

#1043 applied the predicate only where an actor *grants* authority. Its plan excluded reject,
invitation DELETE and member DELETE "because they reduce authority" (C4, "Member set"). **This plan
reverses that premise.** Removing a member (and deleting their team keys and sessions), cancelling an
invitation, and rejecting a SCIM-pending admission are admin authority exercised over other people.
"Reduces authority" describes the target's state after the action, not whether the actor was
entitled to take it. The same holds for every team route, so the primary control is not per-site.

## Background (verified against the code)

- **One gate for every team route.** Every exported handler under `src/app/api/teams/[teamId]/`
  calls `requireTeamMember` / `requireTeamPermission`, both of which call `getTeamMembership`.
  Derivation (R42, R29): 41 route files, **58** exported handlers (20 GET, 23 POST, 7 PUT,
  8 DELETE), each handler checked individually by the three plan reviewers:
  ```bash
  find 'src/app/api/teams/[teamId]' -name route.ts | wc -l
  find 'src/app/api/teams/[teamId]' -name route.ts -exec grep -hcE '^export const (GET|POST|PUT|PATCH|DELETE)\b' {} + | paste -sd+ | bc
  ```
  C5 turns this into a test. Other `requireTeam*` callers: `share-links` (POST, `mine`),
  `audit-logs/export|import`, `watchtower/alert`, `share-link-manager.ts`, the dashboard watchtower
  page. Direct `getTeamMembership` caller: `src/app/[locale]/admin/teams/[teamId]/layout.tsx`.
- **`getTeamMembership` reads `deactivated_at IS NULL` only.** A leftover passes it.
- **Where leftovers come from.** Every departure writer ends team memberships in the departure
  transaction: `departFromTenant` and `departCreatedMembership` call `endTeamMemberships`;
  `deactivateScimUser` (SCIM DELETE) deletes the team rows in the transaction that writes the
  departure record; directory sync and SCIM PUT/PATCH go through `departFromTenant`. A leftover
  therefore exists only as old state: the pre-`20261101` residue, a `containable = false` row from
  the runbook, or a future writer that misses `endTeamMemberships` (#1045 SC5). A departure racing a
  request deactivates or deletes the team row; it does not create a leftover.
- **Limit of the predicate:** a tenant row deleted *without* a departure record reads as a guest
  (not departed). The bootstrap-tenant migration in `src/auth.ts` (`tenantMember.deleteMany`, teams
  kept) is the in-code case and is a guest by design (#1043 SC4). The runbook already lists tenant-row
  deletes as a gate blind spot; C6 keeps that limit.
- **Direct `team_members` readers that decide something outside `getTeamMembership`.** Derivation:
  `grep -rlE 'teamMember\.(findFirst|findUnique|findMany|count)|team_members' src --include='*.ts'
  --include='*.tsx' | grep -v test` (30 files), supplemented by a relation-read sweep
  (`teamMemberships`, `members: { some|none|every }`, `include: { members }`) that found no further
  authority reader. Classification:
  | Reader | Decides | Disposition |
  |---|---|---|
  | `GET /api/teams` | which teams the user sees, with role | C3 |
  | `getAdminTeamMemberships` (admin shell) | which teams appear as administrable | C3 |
  | `pending-key-distributions` | the actor's admin teams, and the recipients listed | C3 |
  | `teamKeyVersionHolders` (`team-item-key.ts`; rekey GET, history restore) | who may re-key, whether a version is still held | C3 |
  | `webhookCreatorVerdicts` (worker + webhooks GET) | whether a creator's webhook delivers | C4 |
  | member DELETE, `rejectScimPending` | actor-on-others, predicate missing | C2 |
  | `member-key` GET (`keyDistributed` read after `requireTeamMember`) | the team key fetch | C1 (behind `requireTeamMember`) |
  | the #1043 grant sites, `rotate-key`, `rotate-key/data`, `tenant/teams/*` | already apply the predicate | unchanged |
  | `session-timeout.ts` (`teamMemberships`) | the strictest session policy across teams | excluded: a leftover row only makes the policy stricter |
  | members GET / search, `team-member-display` | display of the team's members | excluded: the actor passes C1; admins must see a leftover to remove it (#1045 SC3) |
  | `deactivatedTeamKeyVersionHolderCount` | count of deactivated holders | excluded: counts deactivated rows only |
  | SCIM services, `scim/v2/Groups`, `team-departure.ts`, `team-key-rotation-lock.ts`, `tenant-row-lock.ts`, `tenant-rls-grants.ts`, approve/confirm-key/members/invitations/accept routes | IdP actor, writers, or #1043 sites | unchanged |
- **Invitation cancel** (`invitations/[invId]/route.ts`) re-checks nothing after
  `requireTeamPermission`, deletes outside any lock, and writes no audit row.

## Contracts

### C1 — `getTeamMembership` refuses a leftover membership (every team route)

- **Signature unchanged:** `getTeamMembership(userId, teamId): Promise<TeamMember | null>`. It runs in
  the `(tenantId, tx)` form of `withTeamTenantRls`: the `findFirst` as today, then, only when a row is
  found, `readTenantRows(tx, tenantId, [userId])` in the same transaction and RLS context (no nested
  context), returning `null` when `actorDepartedSinceAdmission(rows.get(userId), row.admittedAt ??
  row.createdAt)`.
- **Refusal:** identical to a non-member — `requireTeamMember` throws `NOT_FOUND` (404) before the IP
  restriction check; the admin layout calls `notFound()`. No new error code: a leftover learns no
  more than a non-member.
- **Unlocked, and what that leaves open.** Leftover state is old state (Background), so an unlocked
  read decides it. A *normal* departure or removal committing after this check while the request is
  still running is not a leftover: sites with an in-transaction re-check (C2, the #1043 sites, the
  `activeTeamRole` sites) see it; the remaining C1-only sites (passwords GET/POST, tags, folders,
  team PUT/DELETE, policy, webhooks, `member-key`) complete that one request. That is the existing,
  request-bounded removal race, unchanged by this plan and not a leftover.
- **Guests** (no tenant row, no departure record) → not leftover. A guest whose departure record is
  older than their admission (re-invited after leaving) → not leftover.
- **Fail-closed residual (widened):** a member legitimately re-admitted before #1043's
  `20261114000000_team_member_admitted_at` (NULL `admitted_at`, `created_at` before the departure)
  is now refused on **every** team route, including `member-key`, not only the six grant sites.
  Nothing distinguishes them from residue, and the alternative (a departed member reading team data
  with keys they hold) is worse. The runbook's removal-based recovery deletes their
  `team_member_keys` (member DELETE) and cannot run at all when they are the sole OWNER with no other
  in-tenant candidate; C8 adds an in-place recovery that keeps the key.
- **Cost:** two indexed reads (`tenant_members`, `tenant_member_departures` by `(tenant_id, user_id)`)
  per team request, inside the transaction `getTeamMembership` already opens; none for a non-member.
- **Control class:** enforceable boundary for every caller of `getTeamMembership`; adjudication
  authority is the database rows read in one transaction under the team's RLS context. Reach over
  future team routes: C5.
- **Acceptance:**
  - Unit (`team-auth.test.ts`) matrix: active → membership; leftover by deactivated tenant row →
    null; leftover by departure record only (tenant row active or absent) → null; departure equal to
    admission → null; guest → membership; re-admitted (`created_at < departure < admitted_at`) →
    membership; re-provisioned (active tenant row plus an older departure record) → membership;
    #1043-C2 residual → null. `requireTeamMember` maps null to 404 and does not call the IP check.
  - Real DB (`assertRlsApplies(prisma)` at file start): for **both** residue seeds — `residueDepart`
    (raw `UPDATE tenant_members SET deactivated_at`, one row asserted) and `recreatedDepart` (a
    departure record with the tenant row re-created active, team row left active) — a leftover OWNER
    gets 404 on team passwords GET, tags POST, team PUT, team DELETE and `member-key` GET, and the
    team, tag and team state are unchanged. Allow cells: positive twin (same seed, no departure), a
    guest from another tenant, a re-admitted member (#1043's seed), and the equality boundary
    (`recreatedDepart(departedAt)` at exactly the admission instant → refused).

### C2 — Locked re-check at the actor-on-others sites #1043 excluded

- **member DELETE:** use the map `lockActorThenTeam` already returns; replace `activeTeamRole` with
  `activeTeamAdmission`; refuse with the existing `ActorNotPermittedError` (403) when
  `actorDepartedSinceAdmission(rows.get(actor), actor.admittedAt)`.
- **`rejectScimPending`:** bind the `lockTenantRows` result; select `admittedAt`, `createdAt` in the
  actor read; return `null` when departed since admission (`approveScimPending`'s check minus the
  key requirement). Covers the single and bulk reject routes.
- **Invitation cancel:** one transaction in the `(tenantId, tx)` form:
  `lockTenantRows(tx, tenantId, [actor], "share", budget)` → `lockTeamsAgainstRotation(tx, [teamId],
  budget)` → `activeTeamAdmission` + `hasTeamPermission(MEMBER_INVITE)` +
  `actorDepartedSinceAdmission` (refuse 403) → `tx.teamInvitation.findFirst({ where: { id: invId,
  teamId }, select: { email: true, role: true } })`, null → `INVITATION_NOT_FOUND` →
  `teamInvitation.deleteMany({ where: { id: invId, teamId } })`; count 0 → `INVITATION_NOT_FOUND`; then `logAuditInTx` with a new action
  `TEAM_MEMBER_INVITE_CANCEL` (scope TEAM, `targetType: TEAM_INVITATION`, target the invitation,
  metadata `{ email, role }` — the same shape `TEAM_MEMBER_INVITE` records).
  Lock conflicts map through `isMembershipLockConflict` → `membershipConflictResponse`, with
  `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`, as invitations POST does. Lock order matches invitations POST and
  accept (tenant row → team → invitation). This also closes the existing removal/demotion race and the
  missing audit at cancel.
- **Why only these three get the locked re-check.** Leftover state cannot appear mid-request
  (Background), so C1 decides it for every route. These three are the actor-on-others class the #1043
  premise excluded; two already hold the lock and discard it, the third has no in-transaction
  re-authorization at all. The `activeTeamRole` sites (history restore, rekey, attachments, migrate,
  `team-password-service`) keep their team-row re-check; adding `lockTenantRows` would serialise
  every team password write with SCIM writes to the actor for no state it can observe.
- **Gate:** `check-team-rotation-input-lock` counts re-derived; no grant, member write or admission
  is added, so they are expected unchanged — Phase 2 records the actual output.
- **Control class:** enforceable boundary inside the locked transaction.
- **Acceptance:**
  - Unit per site: deny (leftover ADMIN/OWNER actor) asserts no delete call and no audit; allow
    (active, guest, re-admitted). Invitation cancel asserts the `deleteMany` arguments are exactly
    `{ id: invId, teamId }`.
  - Real DB per site. C1 refuses a residue actor before these transactions, so the deny cells inject
    the departure **after** the gate: member DELETE through the mocked
    `requireRecentCurrentAuthMethod` (step-up runs after `requireTeamPermission`), reject /
    bulk-reject / cancel through a mocked `withTeamIpRestriction` (`requireTeamMember` calls it after
    the membership resolves). Each asserts 403 and survival — the target member row, its
    `team_member_keys`, and its sessions/tokens (member DELETE); the invitation (cancel); every
    pending row of a several-row bulk reject — with a positive twin using the same hook without a
    departure. Separate cells assert C1's 404 without injection. The `@/lib/team/team-policy` mock
    spreads `importOriginal` and passes through to the real `withTeamIpRestriction` by default; the
    step-up mock likewise defaults to the current `null`. Each hook is one-shot (a second
    `recreatedDepart` would hit the departures primary key) and is disarmed in `afterEach`. The reviewer's case
    (`rejectScimPending` returns `null`) is a direct lib-level cell.
  - Real DB cross-team: an admin of team A cancelling team B's invitation (same tenant) gets 404 and
    B's invitation survives; a same-team twin succeeds and writes `TEAM_MEMBER_INVITE_CANCEL`.
  - #1043's six actor-deny cells in `departed-member-leaked-authority.integration.test.ts`
    (invitations POST, members POST, approve, member PUT role and transfer, confirm-key) now get 404
    from C1. They are converted to the same post-gate injection so they keep asserting 403 from the
    in-transaction checks; C1's 404 is asserted in separate cells.

### C3 — Consistency readers drop leftover memberships

- **Shared reader.** `readTenantRows`, `departedAt`, `departedSince` and
  `actorDepartedSinceAdmission` move to a pure module `src/lib/team/tenant-departure-read.ts` (only
  type imports from `@prisma/client`; no `@/lib/prisma`); `tenant-row-lock.ts` re-exports them, so
  existing imports and gate rule 8 (`RECIPIENT_PREDICATE`, matched by name) are unaffected. C3 and C4
  call `readTenantRows` (grouped by `tenantId`); no second reader is written.
- **Applied at:**
  - `GET /api/teams`: leftover memberships omitted.
  - `getAdminTeamMemberships`: omitted from the admin shell.
  - `pending-key-distributions`: the actor's leftover admin memberships contribute no teams, and
    leftover recipients are not listed (folds #1045's item; confirm-key already refuses them). Both
    selects gain `tenantId`, `admittedAt`, `createdAt`.
  - `teamKeyVersionHolders`: a leftover is not a holder (read in the same transaction, under the team
    lock and the team's RLS context), so rekey GET does not name a leftover as a rekeyer and history
    restore does not treat a version held only by a leftover as available. The count of holders who
    could return (`deactivatedTeamKeyVersionHolderCount`, renamed `inactiveTeamKeyVersionHolderCount`)
    counts leftover holders too, so `rekey-report.ts`'s `deactivatedHolder` warning still marks the
    UNRECOVERABLE delete exit for a version a leftover holds (the C8-recoverable case). Both
    functions gain a `tenantId` parameter and widen their `tx` Pick to `tenantMember`,
    `tenantMemberDeparture`; history restore switches to the `(tenantId, tx)` form of
    `withTeamTenantRls` (rekey GET already uses it).
- **Grants:** `TEAM_ADMIN_MEMBERSHIP_LOOKUP` gains `tenantMemberDeparture`;
  `TEAM_PENDING_KEY_DISTRIBUTION` gains `tenantMember`, `tenantMemberDeparture`. `passwd_app`
  already holds SELECT on both tables; Phase 2 confirms against `db-grants-manifest.json`.
- **A missing grant fails loudly.** Since `20261114000500_rls_bypass_enforce`, a bypass read of a
  table the grant does not list raises 42501 `RLS_BYPASS_NOT_GRANTED`, and a missing worker column
  privilege raises 42501 too; the positive twins below go red on either. No grant-list unit test is
  added (it would be a hand-written list).
- **Control class:** consistency with C1 (C1 is the boundary): the UI stops offering what C1 refuses,
  the key-distribution client is not handed a leftover's public key, and key-holder decisions ignore
  leftovers.
- **Consumer walkthrough:** response shapes are unchanged (rows omitted only). Team-list consumers
  (dashboard sidebar, extension and iOS team lists) read `{ id, name, slug, role, … }`; the admin
  shell reads `team.{ id, name, slug, tenantName, isCrossTenant }`; the auto key-distribution client
  reads `{ memberId, teamId, userId, ecdhPublicKey, teamKeyVersion }`. rekey GET's consumer
  (`rekey-report.ts` `holderInputsFrom`) reads `activeHolderCount`, the rekeyer holders and
  `deactivatedHolderCount`, deriving `deactivatedHolder = activeHolderCount === 0 &&
  deactivatedHolderCount > 0`; with leftovers moved from the first to the last, a leftover-only
  version still sets the warning. None needs a field added.
- **Acceptance** (real DB, both seeds, `assertRlsApplies`): each endpoint omits the leftover and keeps
  a positive twin; per-pair matching — user U departed T1 (T1 team omitted) and is a guest in a T2
  team (listed); `pending-key-distributions` with two tenants and two recipients where only (T1, U1)
  departed; a re-admitted member is listed (pins the admission anchor, not `team.createdAt`);
  rekey GET omits a leftover holder and reports a leftover-only version UNRECOVERABLE with
  `deactivatedHolder` set; history restore refuses a version held only by a leftover and the entry is
  unchanged. Both have same-seed twins (version held by an active member → listed / restored), and
  the actor in every holder cell is an active admin so C1's 404 is not what is tested.

### C4 — Webhook delivery stops for a leftover creator

- **Predicate:** `webhookCreatorAuthorized(createdById, member, tenantRow)` — `member` gains
  `admittedAt`, `createdAt`; `false` also when `actorDepartedSinceAdmission(tenantRow,
  member.admittedAt ?? member.createdAt)`. `webhookCreatorVerdicts(tx, tenantId, teamId, webhooks)`
  reads creators' tenant rows with `readTenantRows(tx, tenantId, creatorIds)`. Both callers keep the
  one function: the worker passes `item.tenant_id`; the webhooks GET switches to the `(tenantId, tx)`
  form of `withTeamTenantRls` and passes those.
- **Privileges** (migration): `passwd_outbox_worker` gains column SELECT on exactly the columns the
  worker's statements issue — `team_members (admitted_at, created_at)`, `tenant_members (tenant_id,
  user_id, role, deactivated_at)`, `tenant_member_departures (tenant_id, user_id, departed_at)` —
  plus any column Prisma's generated SQL adds (e.g. `id`), established by running the worker cell as
  `ctx.worker.prisma` before writing the migration and recorded with the generated SQL in the
  deviation log. `OUTBOX_WEBHOOK_SUBSCRIBER_RESOLVE` gains `tenantMember`, `tenantMemberDeparture`.
  The read is scoped by `tenant_id = item.tenant_id`.
- **Reverses** #1043 C6's "Recorded, not adopted" for leftover creators: C1 now refuses the creator
  everywhere else, and the webhook is the remaining channel.
- **Import safety:** the worker bundle is CJS; `tenant-departure-read.ts` must not import
  `@/lib/prisma`. Pinned by a unit cell over the module's import declarations (type-only imports
  only) and by the existing worker-bundle smoke step, which Phase 2 confirms loads this module.
- **Control class:** enforceable boundary at delivery.
- **Acceptance** (real DB as `ctx.worker.prisma`, principal asserted, both seeds): a leftover
  creator's webhook is skipped (item SENT, counters unchanged); positive twin delivered; a guest
  creator and a re-admitted creator are delivered; the GET's `creatorAuthorized` agrees for each
  state; the `column_privileges` assertion is the new exact set, with no table-level SELECT.

### C5 — Every team handler reaches `getTeamMembership` (test)

- A unit test (`src/__tests__/team-route-auth-reach.test.ts`, ts-morph, no Program needed) lists every
  `route.ts` under `src/app/api/teams/[teamId]/`, resolves each exported handler
  (`export const X = withRequestLog(handleX)` or a direct function) to its function body, and asserts
  the body calls `requireTeamMember` or `requireTeamPermission`. Handlers are the exports named by an
  HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) in any export form (`export const`,
  `export async function`, `export { x as GET }`); Next.js route-segment config exports (`runtime`,
  `dynamic`, `revalidate`, `maxDuration`, `fetchCache`, `preferredRegion`) are allowed; any other
  export, or a handler it cannot resolve, fails. The file list comes from an `fs` walk (the `[teamId]`
  brackets break glob matching), cross-checked against ts-morph's loaded files; it fails when the
  walk finds no file or a file has no handler.
- This checks a call, not read intent; it is not a classifier of `team_members` reads. A new reader of
  `team_members` that decides authority itself remains a convention, stated in `getTeamMembership`'s
  doc comment: apply `actorDepartedSinceAdmission` or call `getTeamMembership`.
- **Control class:** fail-closed verification gate for the reach of C1 over handlers in that tree;
  convention for readers outside it.
- **Acceptance:** red-proved by removing one handler's call and by adding an unresolvable export on a
  scratch copy; the allow side is the current tree passing.

### C6 — Documentation

- `docs/operations/departed-member-access-backfill.md`: "Actors refused since this release" covers
  every team route, key-holder decisions and webhook delivery, keeping the tenant-row-deletion limit
  (Background); the #1043-C2 residual section names the wider effect and points to C8 instead of
  remove-and-re-invite, warning that member DELETE deletes the member's team keys; the
  `pending-key-distributions` sentence is removed.
- New audit actions `TEAM_MEMBER_INVITE_CANCEL` (C2) and `TEAM_MEMBER_OPERATOR_READMIT` (C8),
  registered everywhere `TEAM_MEMBER_INVITE_ACCEPT` was (#1043 B1): an `ADD VALUE` migration,
  `src/lib/constants/audit/audit.ts` (action, `VALUES`, scope groups), `messages/{en,ja}/AuditLog.json`,
  `audit-action-icons.tsx`, `docs/operations/audit-log-reference.md`, the audit enumeration tests,
  and `check-critical-audit-atomic` if they are classed critical.
- `#1045`: comment that its `pending-key-distributions` item is closed by this PR. `#1032`: comment
  recording the team-share creator's access-log reads (share-link-manager) as a foothold of that kind.

### C7 — pre-pr from a git worktree (user-requested)

- **Measured** (full `PRE_PR_FORCE_FULL=1 bash scripts/pre-pr.sh` in this worktree): 3 failures.
  - `Test`: `backup-db.test.mjs` Group B, 6 of 239 (`npx vitest run
    scripts/__tests__/backup-db.test.mjs` → `6 failed | 233 passed (239)`). From a worktree,
    `docker compose` derives the project name from the worktree's directory and finds no running
    `db`.
  - `CLI: deps missing`, `Extension: deps missing`: `cli/node_modules` and `extension/node_modules`
    were never installed in the worktree. pre-pr refuses by design ("does not auto-install") and
    names the command; this is setup, not a code defect, and was resolved by `npm ci` in both.
- **Fix (backup-db):** Group B resolves a **compose directory** once: `REPO_ROOT` when `docker compose
  exec -T -- db pg_restore --version` succeeds there, else the main worktree (first `worktree` entry
  of `git worktree list --porcelain`) when it succeeds there. The reader runs with that `cwd`; the
  delegating stub `cd`s into it on its real-docker branch only (`run()` passes the script an
  allowlisted environment, so `COMPOSE_*` variables would not reach it; the cwd is what compose
  reads). The resolved directory is printed beside the reader kind. The host-binary path (CI) is
  unchanged.
- **Control class:** n/a (test harness).
- **Acceptance:** `npx vitest run scripts/__tests__/backup-db.test.mjs` exits 0 from this worktree and
  from the primary checkout; in the worktree run the printed compose directory equals the first `git
  worktree list --porcelain` entry; with `DOCKER_HOST=unix:///nonexistent` (no host `pg_restore`)
  it fails "no pg_restore reachable" rather than skipping — the shared compose db is never stopped.
  The final full pre-pr from this worktree passes.

### C8 — In-place re-admission that keeps the team key (operator script)

- A runbook script block `-- BEGIN SCRIPT departed-member-readmit` in
  `departed-member-access-backfill.md`, in the shape of `departed-member-contain` (a DO block with an
  input array of `(tenant_id, team_id, user_id)` rows and an operator label, bypass GUCs saved, set
  and restored over exactly the tables it touches, all-or-nothing with a RAISE on any non-qualifying
  row). For each row, in one transaction: lock the user's `tenant_members` row `FOR SHARE` (it must exist; see below)
  and the team row as the rotation lock does — after the per-(tenant, user) advisory locks in
  `COLLATE "C"` key order, as `contain` and `lockTenantRows` take them — require the membership to be
  in the **residual class only**: active, `admitted_at IS NULL`, the tenant row present and
  deactivated with `tm.created_at <= tmb.deactivated_at`, no departure record at or after
  `tm.created_at`, and `tm.updated_at > tmb.deactivated_at` (a legitimate residual was re-activated
  after the departure, and every re-activation writes `updated_at` through Prisma's `@updatedAt`; a
  leaked row nobody touched since the departure fails it). The last condition is necessary, not
  sufficient: a leaked row touched later (a role or key update) still passes it, so the tenant
  admin's confirmation stays required. `updated_at` is the application clock and `deactivated_at`
  the database clock; a skew only refuses a re-admission within the skew of the departure. A stamped `admitted_at` that is still leftover is a missed departure writer, and a
  leftover by departure record alone survived a SCIM DELETE that deletes team rows in its own
  transaction (`deactivateScimUser`); both are leaks the database can prove, ended by `contain` or a
  team admin's removal, never re-admitted. Then `UPDATE team_members SET deactivated_at = clock_timestamp()` followed by `SET
  deactivated_at = NULL` on the same row — the #1043 trigger stamps `admitted_at`;
  `team_member_keys` are untouched. One `audit_outbox` row per membership with a new action
  `TEAM_MEMBER_OPERATOR_READMIT` (metadata: operator label, `readmitted: true`, the row's
  `created_at` and the tenant row's `deactivated_at`), inserted as
  `contain` inserts its `TEAM_MEMBER_TENANT_DEACTIVATE` rows; `audit_outbox` joins the script's
  `bypass_tables`.
- Used only after the tenant admin confirms the section-1 row is a legitimate re-admission (step 5).
- **Control class:** operator procedure (no application path), all-or-nothing.
- **Acceptance** (`departed-member-operator-scripts.integration.test.ts`, extracted from the runbook
  as the existing scripts are, carrying over the `contain` matrix): baseline — a #1043-C2-residual
  member is refused by C1, the script runs, `member-key` GET then returns the same key row, and the
  audit row exists; refusals that each change one field — stamped `admitted_at`, departure-record-only
  leftover, guest, re-provisioned, departure before admission, already ended, tenant mismatch,
  `updated_at` equal to the departure (pins `>`); boundaries — `created_at` equal to the tenant row's
  `deactivated_at` qualifies, a departure record dated before `created_at` (tenant row deactivated
  after it) qualifies, a departure record dated exactly `created_at` refuses;
  a mixed list (one qualifying, one not) refuses with the qualifying row's `admitted_at` still NULL
  and no `audit_outbox` row; upper-case ids, duplicate triples, null ids and array-shape refusals; a
  table-list control over the script's `app.bypass_tables` literal (including `audit_outbox`);
  lock-wait cells for the advisory lock, the tenant row and the team; a second run on the same row is
  refused (no longer leftover). The seed sets `team_members.updated_at` after the departure with a raw
  `UPDATE … SET updated_at` that does not touch `deactivated_at` (the `addTeamMember` helper inserts
  `now()`, which would fail the new condition), in the baseline and every qualifying cell, so each
  refusal differs from the baseline in its own field only.

## Forbidden patterns

- `pattern: await lockTenantRows\(tx, tenantId, \[actorUserId, ` without a binding in
  `rejectScimPending` — reason: the discarded result is the defect.
- `pattern: activeTeamRole\(tx, teamId, session\.user\.id\)` in `members/[memberId]/route.ts` —
  reason: member DELETE must read the admission.
- `pattern: prisma\.teamInvitation\.delete\(` in `invitations/[invId]/route.ts` — reason: the
  unlocked delete.
- `pattern: from "@/lib/prisma"` in `src/lib/team/tenant-departure-read.ts` — reason: worker import
  safety.

## Testing strategy

- Unit: C1 matrix; C2 route tests; C3 holder/count functions; C4 predicate and import cell; C5 reach test.
- Real DB: new `leftover-team-actor-authority.integration.test.ts` (`assertRlsApplies`, both seeds,
  positive twins, post-gate injection for C2); #1043's six cells converted; the worker-role
  column-privilege suite; the operator-scripts suite (C8).
- Existing tests that change (R19, measured by the testing reviewer: 64 of 67 `requireTeam*` test
  files mock `team-auth` at the module boundary and are unaffected):
  - `team-auth.test.ts` (`withTeamTenantRls` mock must pass `(tenantId, tx)`; `getAdminTeamMemberships`)
    and `team-auth.rls-nesting.test.ts` (its `mockTx` gains `tenantMemberDeparture`);
  - the C3/C4 tx-mock consumers: `src/app/api/teams/route.test.ts`,
    `pending-key-distributions/route.test.ts`, `webhook-creator-authority.test.ts`,
    `src/__tests__/audit-outbox.test.ts`, `webhooks/route.test.ts`, `team-item-key` and rekey/restore
    tests;
  - the cancel tests in both trees; the audit enumeration tests (new actions).
- Gates: `check-team-rotation-input-lock` (counts), `audit-db-grants --write`,
  `check-migration-rls-dml`, `check-critical-audit-atomic` (if the new actions are critical), full
  pre-pr from this worktree (C7).
- Every new test is red-proved on a scratch copy, one mutation per clause.

## Considerations & constraints

- C1 adds two reads per team request (Background, cost).
- The #1043-C2 residual widens from grants to all access (C1); C8 is its recovery.
- **Scope contract:**
  - SC1: tenant-level footholds and audit-attributable changes a departed member left, including a
    team-share creator's access-log reads — `#1032`.
  - SC2: the departure-writer gate and rule 8 limits — `#1045`.
  - SC3: members GET / search showing leftovers — display only, `#1045` (SC3 there).
  - SC4: a static gate over direct `team_members` authority reads outside the team route tree — not
    adopted (C5).
- PR `#1054` (invitation token digest) touches `invitations/route.ts` and accept, not
  `[invId]/route.ts`; a rebase may be needed if it merges first.

## User operation scenarios

1. A departed ADMIN whose team row was left active opens the team: 404, as for a stranger; the team is
   absent from their team list and admin shell; they are not offered as a rekeyer; their webhook stops
   delivering.
2. The same user calls member DELETE / reject / cancel directly: 404 at `requireTeamPermission`; a
   request already past that check when a normal removal commits is refused by the in-transaction
   re-check (403).
3. A guest admin from another tenant: unaffected.
4. A member re-invited after leaving: unaffected (`admitted_at` after the departure).
5. A member re-admitted before #1043's migration: loses team access; the tenant admin confirms them,
   and the operator runs C8, which restores access with their key intact.
6. A developer runs `bash scripts/pre-pr.sh` from a worktree with `cli/` and `extension/` installed:
   Group B finds the primary checkout's `db` service and passes.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `getTeamMembership` refuses a leftover (every team route) | locked |
| C2 | Locked re-check + audit at member DELETE, SCIM reject, invitation cancel | locked |
| C3 | Consistency readers (team list, admin shell, pending distributions, key holders) | locked |
| C4 | Webhook delivery stops for a leftover creator | locked |
| C5 | Handler-reach test for the team route tree | locked |
| C6 | Runbook, audit reference, #1045/#1032 | locked |
| C7 | pre-pr from a worktree (backup-db Group B; deps setup) | locked |
| C8 | In-place re-admission operator script | locked |

## Implementation Checklist

Phase 2, Step 2-1. Batches: B1 and B4 in parallel, then B2, then B3.

**B1 — C1, C2, C5, audit actions**
- `src/lib/team/tenant-departure-read.ts` (new, pure): move `readTenantRows`, `departedAt`,
  `departedSince`, `actorDepartedSinceAdmission`, the `LockedTenantRow` type; `tenant-row-lock.ts`
  re-exports all of them. Existing callers keep importing from `tenant-row-lock` (16 test files
  `vi.mock` that module; a caller switching its import would escape those mocks).
- `src/lib/auth/access/team-auth.ts`: `getTeamMembership` (C1) + doc comment (C5 convention).
- `src/app/api/teams/[teamId]/members/[memberId]/route.ts` (member DELETE), `src/lib/team/scim-admission.ts`
  (`rejectScimPending`), `src/app/api/teams/[teamId]/invitations/[invId]/route.ts` (C2).
- Audit actions `TEAM_MEMBER_INVITE_CANCEL`, `TEAM_MEMBER_OPERATOR_READMIT`: `prisma/schema.prisma`
  enum, `ADD VALUE` migration, `src/lib/constants/audit/audit.ts`, `messages/{en,ja}/AuditLog.json`,
  `src/components/audit/audit-action-icons.tsx`, `docs/operations/audit-log-reference.md`, audit
  enumeration tests, `check-critical-audit-atomic` (decide; record).
- `src/__tests__/team-route-auth-reach.test.ts` (C5).
- Unit tests: `team-auth.test.ts`, `team-auth.rls-nesting.test.ts`, `src/__tests__/helpers/mock-team-auth.ts`
  (check), `confirm-key/route.test.ts` (its `getTeamMembership` findFirst mock), `members/[memberId]/route.test.ts`,
  `scim-admission.test.ts`, `reject` / `bulk-reject` route tests, `invitations/[invId]/route.test.ts`,
  `tenant-row-lock.test.ts`, new `tenant-departure-read` import-safety cell.

**B2 — C3, C4**
- `src/app/api/teams/route.ts` (GET), `getAdminTeamMemberships`, `src/app/api/teams/pending-key-distributions/route.ts`,
  `src/lib/team/team-item-key.ts` (`teamKeyVersionHolders`, rename to `inactiveTeamKeyVersionHolderCount`),
  `src/app/api/teams/[teamId]/rekey/route.ts`, `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route.ts`
  (`(tenantId, tx)` form).
- `src/lib/team/webhook-creator-authority.ts`, `src/workers/audit-outbox-worker.ts`,
  `src/app/api/teams/[teamId]/webhooks/route.ts` (GET `(tenantId, tx)` form).
- `src/lib/tenant-rls-grants.ts`: `TEAM_ADMIN_MEMBERSHIP_LOOKUP`, `TEAM_PENDING_KEY_DISTRIBUTION`,
  `OUTBOX_WEBHOOK_SUBSCRIBER_RESOLVE`.
- Migration: worker column grants (exact set from the worker cell run); `scripts/checks/db-grants-manifest.json`
  via `audit-db-grants --write`.
- Unit tests: `src/app/api/teams/route.test.ts`, `pending-key-distributions/route.test.ts`,
  `team-item-key.test.ts`, rekey and restore route tests, `webhook-creator-authority.test.ts`,
  `src/__tests__/audit-outbox.test.ts`, `webhooks/route.test.ts`, `src/app/[locale]/admin/layout.test.tsx`
  (check), `team-vault-core.test.tsx` / `vault-context-passkey-gate.test.tsx` (check; consume
  pending-key-distributions).

**B3 — integration tests, C8, C6**
- New `src/__tests__/db-integration/leftover-team-actor-authority.integration.test.ts` (C1–C4).
- `departed-member-leaked-authority.integration.test.ts`: the six #1043 actor-deny cells converted.
- `audit-outbox-worker-role*.integration.test.ts` (column privileges).
- `departed-member-operator-scripts.integration.test.ts` (C8 matrix); C8 script block and C6 text in
  `docs/operations/departed-member-access-backfill.md`.
- Check `scim-team-admission-approval` and `team-tenant-departure` integration suites (reference
  pending-key-distributions).
- Comments on `#1045` and `#1032` (orchestrator, at PR time).

**B4 — C7**
- `scripts/__tests__/backup-db.test.mjs` Group B only.

**Reuse (do not reimplement):** `lockTenantRows`, `readTenantRows`, `actorDepartedSinceAdmission`,
`activeTeamAdmission`, `createLockBudget`, `lockTeamsAgainstRotation`, `isMembershipLockConflict`,
`membershipConflictResponse` (`src/lib/http/lock-conflict-response.ts`), `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`,
`logAuditInTx`, `hasTeamPermission`, `withTeamTenantRls` `(tenantId, tx)` form, `withBypassRls`,
`BYPASS_GRANT`, `setBypassGucs`; integration helpers `residueDepart`, `recreatedDepart`,
`assertRlsApplies`, `ctx.worker.prisma`; the runbook script-extraction helper used by
`departed-member-operator-scripts.integration.test.ts`.

**CI parity (Step 2-1 item 7).** Gates CI runs that pre-pr does not:
- `npm run check:rls-grant-evidence` — reads the integration run's evidence record; run locally after
  `npm run test:integration` in Step 2-4 (this diff changes bypass grants).
- `bash scripts/check-state-mutation-centralization.sh` — run locally in Step 2-4.
- `check-npm-audit`, `licenses:check*`, `check-terraform-test-count` — no dependency or infra change
  in this diff; not applicable.
