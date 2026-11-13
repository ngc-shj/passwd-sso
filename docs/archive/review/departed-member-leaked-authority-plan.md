# Plan: departed-member-leaked-authority

Issue `#1035`. Follow-up of `#1033` / `#1034` (`migration-backfill-rls-bypass-plan.md`, SC4 and SC5).
Revision 4 (with the round-4 Minor fixes; saturation reached). Findings and their history are in `departed-member-leaked-authority-review.md`.

## Project context

- Type: web app (Next.js App Router, Prisma 7, PostgreSQL 16 with FORCE RLS)
- Test infrastructure: unit + integration (real DB) + E2E + CI/CD
- **Design rule:** no trigger or function here reads or writes another table under the caller's
  RLS context by relying on its owner.
  - On RDS the owner is NOSUPERUSER NOBYPASSRLS (`20261102000000_share_creator_admitted` header).
  - Cross-table SQL uses SECURITY INVOKER with a saved, set and restored `app.bypass_rls` /
    `app.bypass_tables` / `app.bypass_purpose` (plus `app.tenant_id` for DML blocks, as in
    `20261109162613`) over exactly the tables it touches.
- Verification environment constraints:
  - VE1: RDS role semantics. `verifiable-local`. Function bodies are covered by `share-departure`
    A10b (re-owned by a NOSUPERUSER NOBYPASSRLS role). DML blocks are covered by the
    `tenant-member-passkey-revoke.integration.test.ts` backfill pattern (`appConnectionString()`,
    with a principal assertion).
  - VE2: the outbox worker's real privileges. `verifiable-local`: delivery cells run as
    `ctx.worker.prisma` (`passwd_outbox_worker`, NOSUPERUSER) and assert `current_user` and
    `rolbypassrls = false`. Stop the compose workers first (CLAUDE.md).

## Objective

After a user departs a tenant, or loses the role that granted it, no team channel keeps acting on
that user's earlier authority:
- admitting others or passing authority on (inviting, adding, approving, promoting, distributing
  the key);
- serving share links created before the departure;
- receiving the team's webhook stream.

## Background (verified against the code)

- **Membership predicate.** Team authorization reads `team_members.deactivated_at IS NULL`.
  - Departures end memberships via `endTeamMemberships` inside the departure transaction. Its
    writers are `departFromTenant`, `departCreatedMembership` and `returnToTenant` in
    `team-departure.ts`. The file's header states it holds the only writers of
    `tenant_members.deactivated_at`.
  - `check-team-rotation-input-lock` skips that file (`IMPLEMENTATIONS`) and does not scan
    `scripts/`. It counts the create-deactivated sites elsewhere (`tenantStateWrites: 2`).
- **A departed user can hold an active membership legitimately.** Accept re-admits an invitee
  whose tenant row is still deactivated when the invitation was issued after the departure.
  - For pre-`20261101` departures the same state can also be rollout residue (SC5).
- **Actor-on-others sites check only the actor's active role.** They are invitations POST,
  accept (inviter), members POST, SCIM approve (its own `findFirst`), the member PUT (role change
  and ownership transfer), and confirm-key.
  - Their refusal responses:
    - invitations `INVITER_GONE` → FORBIDDEN;
    - members POST `TeamAuthError(FORBIDDEN)`;
    - approve `ACTOR_NOT_PERMITTED` → FORBIDDEN;
    - accept `DEPARTED` → `INVITATION_EXPIRED`;
    - PUT and confirm-key: their existing 403.
- **Accept.** Its unlocked pre-check marks ACCEPTED for an already-active member (R2-S5). The
  SCIM pre-checks after it assume a deactivated row. Accept writes no audit row.
- **Share admission.** The live body of `share_creator_admitted()` is `20261108000000`. It admits
  a team share while the creator is an active member with `created_at <= share.created_at`, so a
  creator re-admitted by accept on the same row revives their earlier shares.
- **Team webhooks.**
  - No creator column; only a `WEBHOOK_CREATE` audit row (`metadata.webhookId`, via
    `logAuditAsync`).
  - Delivery is `resolveWebhookSubscribers` in the worker. A work item is per (outbox, scope,
    team). When no subscriber resolves, the item is marked SENT: the event is not retried.
  - `dispatchWebhook` in `src/lib/webhook-dispatcher.ts` is a second, unused team-delivery path
    (tests only), with grant `TEAM_WEBHOOK_DISPATCH`.

## Contracts

### C1 — SC5 recurrence: what holds it, and the known limits

- **No new runtime control.** Departures end memberships because every departure writer lives in
  `team-departure.ts` and calls `endTeamMemberships`. That is a stated convention (the file
  header), reviewed by humans.
- `check-team-rotation-input-lock` pins writes *outside* that file:
  - a Prisma or raw write naming `tenant_members.deactivated_at` elsewhere fails the gate;
  - it does not see the file's own writers, `*Unsafe` raw SQL, aliased receivers, `scripts/`, or
    `tenantMember.delete*`.
- **Control class:** convention, plus a partial fail-closed verification gate, with the limits
  above.
  - Extending the gate (writers inside the file must call `endTeamMemberships`; tenant-row
    deletes pinned) is SC5: a follow-up issue. AST gates have repeatedly seeded their own
    defects when grown inside a feature PR.
- **Tenant-row DELETE paths:**
  - SCIM DELETE deletes the team rows itself.
  - The bootstrap-tenant migration keeps the bootstrap teams by design (SC4).
- **Acceptance:** none (documentation). C7 states these limits.

### C2 — `team_members.admitted_at`, advanced on re-activation by a same-row trigger

- **Column** `admitted_at timestamptz(3) NULL`; Prisma `admittedAt DateTime? @db.Timestamptz(3)
  @map("admitted_at")`. No backfill.
  - The effective admission time is `COALESCE(admitted_at, created_at)`.
- **`BEFORE INSERT OR UPDATE` row trigger** on all UPDATEs (not `UPDATE OF`). It touches only
  `NEW` and `OLD`.
  - INSERT: `NEW.admitted_at := NULL`.
  - UPDATE with `OLD.deactivated_at IS NOT NULL AND NEW.deactivated_at IS NULL`:
    `clock_timestamp()`.
  - Otherwise: `NEW.admitted_at := OLD.admitted_at`.
  - `REVOKE EXECUTE … FROM PUBLIC` on the trigger function. The manifest delta is listed in
    Testing strategy.
- **Used only by C4.**
- **Control class:** enforceable boundary. The application cannot set it.
- **Acceptance** (real DB). Comparisons are at millisecond precision.
  1. INSERT leaves NULL, even when a value is supplied.
  2. Re-activation through accept's upsert, members POST, approve's CAS and `returnToTenant`
     yields `t0 <= admitted_at <= t1`.
  3. In a raw transaction with a measurable sleep before the re-activating UPDATE, the value is
     later than `now()` (proves `clock_timestamp()`).
  4. A re-activating UPDATE that supplies a value is overridden.
  5. On an active row: setting `deactivated_at = NULL` again, a role or key update, and
     `SET admitted_at = '2000-01-01'` all leave it unchanged.
  6. Deactivation keeps it.

### C3 — A share is refused when its creator departed the tenant after creating it

- **`CREATE OR REPLACE share_creator_admitted`** on the `20261108000000` body. Every rule stays.
  - A team share is additionally refused when
    `GREATEST(tm.deactivated_at, d.departed_at) >= s.created_at`, where `tm` is the creator's
    `tenant_members` row in `s.tenant_id` and `d` is their `tenant_member_departures` row in
    `s.tenant_id`. This is the same definition and the same operator as
    `departedAt()` / `departedSince()`.
  - Equality (a departure at the creation instant) refuses, and a cell pins it.
  - NULL handling: `tm` and `d` are LEFT JOINs, and the condition is
    `(GREATEST(...) >= s.created_at) IS NOT TRUE`. A never-departed creator and a guest creator
    (no `tm` row) are admitted, and A10 cells pin both.
  - `bypass_tables` gains `tenant_members,tenant_member_departures`; `passwd_app` already holds
    SELECT on both.
- **Effects:**
  - A creator re-admitted by accept on the same row while still departed no longer revives
    earlier shares. This includes past re-admissions, with no backfill.
  - `returnToTenant` clears `deactivated_at`, so a restored creator's earlier shares are served
    again, unless a SCIM-DELETE departure record later than the share exists. That is intended:
    the IdP reversed the departure.
  - SCIM group removal followed by approve keeps the tenant row active, so earlier shares are
    served. This is intended (a team-level re-admission by a key-holding admin), recorded as
    SC6.
- **Control class:** enforceable boundary at serve time; the single SQL decision point.
- **Acceptance:**
  1. Real DB: the creator departs via SCIM `active=false`, is re-admitted by accept on the same
     team row, and an earlier share is refused while a later share is admitted.
  2. Restore via `returnToTenant`: admitted.
  3. A seeded cell for the departures arm: tenant row deleted, team row kept, departure record
     later than the share → refused.
  4. The #996 and #998 refusals hold.
  5. A10b adds the migration and a departed-creator refusal as `passwd_app` with no context.
  6. A10 gains rows (departed after, departed before with a later membership, restored), with
     the refusal asserted in the "none" and "public serve bypass" contexts.
- **Consumer walkthrough:** both callers read the boolean only.

### C4 — One actor predicate on every site where an actor grants authority to others

- **Helper** `actorDepartedSinceAdmission(row: LockedTenantRow | undefined, admittedAt: Date):
  boolean`. It is true when `departedAt(row) >= admittedAt`, the same operator as
  `departedSince`.
  - The actor's `admittedAt` is `COALESCE(admitted_at, created_at)` of their membership in this
    team.
  - `activeTeamAdmission(tx, teamId, userId) → { role, admittedAt } | null` is a sibling of
    `activeTeamRole`.
  - Approve's own `findFirst` selects `admittedAt` and `createdAt` as well.
- **Applied after `lockTenantRows` (tenant rows before team locks) at:**
  1. invitations POST (inviter);
  2. accept (inviter, in the DEPARTED branch);
  3. members POST (adder);
  4. SCIM approve (approver);
  5. member PUT (role change and ownership transfer, actor). `lockActorThenTeam` returns the
     `lockTenantRows` map, keeping its name because the gate lists it in `TENANT_LOCK_WRAPPERS`
     and `LOCK_HELPERS`.
  6. confirm-key (distributor). It switches to the `(tenantId, tx)` form of
     `withTeamTenantRls`.
     - It gains `lockTenantRows([actor])` before `lockTeamKeyVersion`.
     - The two share one `LockBudget`, which means adding a `budget` parameter to
       `lockTeamKeyVersion`.
     - It runs with `{ timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS }`.
     - Lock conflicts map through `isMembershipLockConflict` → `membershipConflictResponse`:
       TEAM_BUSY for a team-row timeout, 409 for a tenant-row timeout.
     - A contention cell is added.
- **Member set:** derived from the handlers that change another member's `role`,
  `deactivatedAt` or `keyDistributed`, or create an invitation or membership. These are
  `check-team-rotation-input-lock`'s member-write and admission classes plus the confirm-key
  `keyDistributed` write. Re-derived in Phase 2 against the gate's site list.
  - **Not applied, because they reduce authority:**
    - reject, invitation DELETE, member DELETE;
    - `rotate-key` (`keyDistributed: false` for deactivated rows);
    - `vault-reset.ts` (`keyDistributed: false`).
  - **Not applied, because no team-member actor is involved:** team creation, and the SCIM group
    service (the actor is the IdP).
  - **Out of scope:** `tenant/teams/[teamId]/owner`, which is tenant-role authority; a tenant
    OWNER cannot depart.
- **Refusal:** each site's existing response; no new error code.
- **Fail-closed residual:** an actor re-admitted before C2 (NULL `admitted_at`, `created_at` before
  the departure) is refused until re-admitted. This cannot be told apart from residue. The
  runbook names it.
- **Control class:** enforceable boundary inside the locked transaction.
- **Acceptance:**
  - **Helper matrix:** guest → false; active row → false; departure equal to admission →
    true; re-admitted with `created_at < departure < admitted_at` → false (catches a
    `created_at`-only read); re-provisioned (active row plus an old record) → false.
  - **Route unit tests per site.** Deny: the actor's row departed after admission, role ADMIN.
    Allow: the same four allow kinds.
    - Mocks default to an active actor row and a `Date` admission.
    - For accept, the invitation postdates the inviter's departure, so C4 alone decides.
  - **Real DB per site, residue state:** an actor row created before the departure, then a raw
    `UPDATE tenant_members SET deactivated_at = …` that bypasses `endTeamMemberships`.
    - The UPDATE runs on the superuser connection and asserts exactly one row updated.
    - Each seed makes the actor otherwise entitled: approve's actor has `keyDistributed = true`,
      and ownership transfer uses an OWNER actor. So only C4 can deny.
    - For accept, the PENDING invitation is inserted directly after the departure UPDATE.
    - Every deny cell has a **positive twin**, the same seed without the departure, which is
      allowed.
  - **Real-DB re-admitted allow cell:** the actor departs (SCIM), is re-admitted by accept
    (`created_at < departure < admitted_at`), then invites successfully. This pins the COALESCE
    in the DB read.

### C5 — Accept: ACCEPTED only after locked admission; the admission is audited

- **Delete the unlocked `deactivatedAt === null` pre-check.** Guard the SCIM pre-checks that
  follow with `existingMember.deactivatedAt !== null`, so an active SCIM-managed member reaches
  the locked path.
  - The locked path gives `{ team, alreadyMember: true }` plus ACCEPTED when the admission checks
    pass, and EXPIRED plus the DEPARTED response (`INVITATION_EXPIRED`) otherwise.
- **`TEAM_MEMBER_INVITE_ACCEPT`.** Written with `logAuditInTx` on the accept `tx` **before**
  `teamMemberKey.deleteMany`, when a membership is created or re-activated. ALREADY_MEMBER writes
  none.
  - Scope TEAM, targetType TEAM_MEMBER, targetId = the invitee's user id.
  - Metadata `{ invitationId, role, readmitted }`.
- **Registration (R12):**
  - the Prisma enum, plus a separate `ADD VALUE` migration;
  - `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, and the TEAM groups (PERSONAL and TEAM);
  - en/ja `AuditLog.json`, `audit-action-icons.tsx`, `audit-log-reference.md`;
  - `CRITICAL_ACTIONS`, plus the `ALL` array in its test.
- **Acceptance:**
  1. An already-active member (plain or SCIM-managed) gets ACCEPTED + `alreadyMember` with an
     entitled inviter, and EXPIRED + `INVITATION_EXPIRED` with a departed inviter.
  2. One audit row per admission in **`audit_outbox`** (the workers are stopped, so
     `audit_logs` would be vacuous): `readmitted` true on re-activation, false on create; none for
     ALREADY_MEMBER.
  3. Rollback: the invitee gets a seeded key row, and a temporary row trigger
     `BEFORE DELETE ON team_member_keys FOR EACH ROW WHEN (OLD.user_id = <invitee>)` raises. It
     is dropped in `finally`; the integration config runs one worker.
     - Afterwards there is no `audit_outbox` row for the action and the membership is
       unchanged.
     - The mutation it catches is an audit enqueued in its own transaction (`prismaBase` or
       `enqueueAudit`). `logAuditInTx(prisma, …)` folds into the transaction through the proxy
       and is harmless.
     - `logAuditAsync` after the commit is caught by acceptance 4 and the `CRITICAL_ACTIONS`
       gate.
  4. The unit rewrite asserts `logAuditInTx` received `acceptTx`.

### C6 — Webhook delivery requires the creator's current authority

- **Column** `team_webhooks.created_by_id uuid NULL` (no FK). No database guard.
  - A `NOT VALID` CHECK was withdrawn in round 3: PostgreSQL enforces it on every UPDATE of a
    legacy NULL row, which broke the worker's health updates.
  - The only creating writer is the POST route (`git grep teamWebhook.create`, plus the CI seed
    SQL). It sets the column from the session user, and a unit test pins it.
  - NULL means legacy.
  - **Residuals:**
    - a previous-release pod's POST during the rollout writes NULL;
    - a future second writer that omits the column. The runbook report lists NULL-creator
      webhooks.
- **Delivery check** in `resolveWebhookSubscribers`. A team webhook is delivered only when
  `created_by_id` is NULL (legacy), or that user has an active membership **in the webhook's
  team** with a role holding `TEAM_UPDATE`.
  - The check uses `hasTeamPermission` from `@/lib/auth/access/team-permissions`, not
    `team-auth.ts`, which imports `@/lib/prisma`.
  - The read uses an explicit select. Prisma always adds `id`, so the grant includes it. The
    tenant filter is not applied to `team_members` (no `tenant_id` grant); the `team_id` match
    scopes it.
  - Otherwise it is skipped, with a log line and without counting a failure.
  - Events during the gap are not delivered later. Only future events flow once authority
    returns.
- **Privileges:**
  - A migration grants `passwd_outbox_worker` `SELECT (id, team_id, user_id, role,
    deactivated_at)` on `team_members`.
  - A dedicated bypass grant `OUTBOX_WEBHOOK_SUBSCRIBER_RESOLVE` (`teamWebhook`,
    `tenantWebhook`, `teamMember`), with the outbox worker's existing purpose `AUDIT_WRITE`
    (Phase 2 checks for a narrower existing purpose), is used by `resolveWebhookSubscribers`,
    which already runs its own transaction. The other delivery transactions are not widened.
  - The creators of one work item's webhooks are read in one `findMany` (`userId: { in }`).
- **One predicate.** `webhookCreatorAuthorized(createdById: string | null, member: { role,
  deactivatedAt } | null): "legacy" | boolean` lives in an import-safe module next to
  `team-permissions.ts`.
  - The worker and the GET both call it, so the legacy arm is decided once too.
  - Agreement is proven by real-DB cells 2–6, each also asserting the GET's `creatorAuthorized`
    for the same state, not by a unit cell comparing the predicate with itself.
- **Dependency.** C6 reads only the team row, so it relies on C1's convention that departures end
  memberships. Unlike C3 and C4, it does not read the tenant row: doing so would widen the
  worker's grants to `tenant_members` and `tenant_member_departures`. Recorded, not adopted.
- **Visibility.** The webhooks GET returns a computed `creatorAuthorized: boolean | null` (null for
  legacy). The team webhook card shows a localized "paused: its creator no longer has access"
  state. The runbook documents the recovery: re-create the webhook under a current admin.
- **Backfill** (a migration DO block, the `20261109162613` pattern):
  - Self-granted bypass on `team_webhooks,audit_logs,audit_outbox`, purpose
    `system_maintenance`, and `app.tenant_id` set to nil. All settings are restored with
    `COALESCE(prev, '')`.
  - It sets `created_by_id` from the latest `WEBHOOK_CREATE` in `audit_logs` (`scope = 'TEAM'`,
    `actor_type = 'HUMAN'`, same tenant and team, `metadata->>'webhookId' = id::text`).
  - Otherwise it uses an `audit_outbox` row in status PENDING, PROCESSING or FAILED. The match is
    on `tenant_id` (a column) and on the camelCase payload keys `payload->>'action'`,
    `'scope'`, `'actorType'`, `'teamId'` and `payload->'metadata'->>'webhookId'`, taking
    `payload->>'userId'`.
  - It raises NOTICE counts.
  - It passes `check-migration-rls-dml` with no baseline entry.
- **Removed:** `dispatchWebhook` (team scope) and its `TEAM_WEBHOOK_DISPATCH` grant, if nothing
  else uses it. Phase 2 confirms. `dispatchTenantWebhook` stays.
- **Residuals:**
  - Legacy NULL creators whose audit is gone keep delivering. The runbook report lists them.
  - Residue creators (an active ADMIN row from before a pre-`20261101` departure) pass the role
    check. They belong to the runbook's Report and Contain, not to C6.
- **Control class:** enforceable boundary at delivery.
- **Acceptance** (real DB, as `ctx.worker.prisma`, principal asserted):
  1. A route-created webhook stores the session user.
  2. A positive twin with a non-NULL ADMIN creator is delivered. It catches a missing grant,
     select or bypass.
  3. After member DELETE, departure, or demotion to MEMBER, delivery is skipped: the item is
     SENT, `last_error` is NULL, `attempt_count` and `fail_count` are unchanged. A pre-queued
     item is skipped too.
  4. Cross-team: the creator is removed from team X but stays ADMIN of team Y. X is skipped and
     Y is delivered.
  5. Resume: after re-admission a new event is delivered, and the skipped event is not
     redelivered.
  6. A NULL-creator (legacy) webhook, seeded by INSERT, is delivered **and its health updates
     commit**:
     - the item is SENT, `attempt_count` is unchanged, `last_delivered_at` is set, and exactly
       one POST arrives;
     - a failing endpoint increments `fail_count` and auto-disables at the threshold.
  7. `creatorAuthorized` in the GET.
  8. The backfill, using the passkey-revoke pattern (markers, `appConnectionString()`, invisible
     precondition, GUCs restored, rollback):
     - the latest of two audit rows wins;
     - another team's or tenant's row is ignored;
     - the outbox fallback works, with the outbox row seeded through
       `buildOutboxPayload`/`enqueueAuditInTx`, not hand-written JSON;
     - a non-NULL column is untouched;
     - a second run is a no-op.
  9. `audit-outbox-worker-role` tests assert the `column_privileges`: SELECT on `team_members`
     is exactly `{id, team_id, user_id, role, deactivated_at}`, with no table SELECT.

### C7 — SC5 disposition and documentation

- **Future recurrence:** C1's convention and partial gate, with the limits stated. Follow-up:
  SC5.
- **Past residue:**
  - Membership side: the runbook (`departed-member-access-backfill.md`).
    - Members without a record were ended by `20261101000000` on a role that bypasses RLS, and
      by `20261110000000_rls_backfill_rerun` on one that cannot.
    - Record holders stay operator-confirmed.
  - Shares: closed by C3.
  - Admission actors: fail-closed by C4.
  - Webhooks: C6, except residue creators and legacy NULLs, both of which the runbook covers.
- **Runbook changes:**
  - Report sections 1–2 and the Contain qualification use
    `COALESCE(tm.admitted_at, tm.created_at) <= GREATEST(tmb.deactivated_at, d.departed_at)`,
    with both arms, matching C4. The script-extraction tests are updated.
  - `TEAM_MEMBER_INVITE_ACCEPT` becomes re-admission evidence from now on.
  - It covers the C4 fail-closed case and the NULL-creator webhook section.
- `audit-log-reference.md` gains the new action.

## Testing strategy

- **Real-DB integration:** C2, C3 (incl. A10/A10b), C4 (residue seed per site), C5 (audit and the
  rollback trigger), C6 (as `ctx.worker`, plus the backfill pattern and the column privileges).
- **Unit:**
  - C4 helper.
  - Per-site route tests.
  - Accept rewrite.
  - Webhook POST `createdById`.
  - Webhook GET `creatorAuthorized`.
  - Card render of the paused state.
- **Existing tests to adjust:**
  - `accept/route.test.ts`;
  - `invitations/route.test.ts`, and its duplicate `src/__tests__/api/teams/team-invitations.test.ts`
    (`lockTenantRows` default);
  - `members/route.test.ts` (the actor `select` pin);
  - `approve/route.test.ts`;
  - `members/[memberId]/route.test.ts` and `confirm-key` tests;
  - `webhooks/route.test.ts`;
  - `webhook-dispatcher.test.ts` (removed cases);
  - `check-critical-audit-atomic.test.mjs` (`ALL`);
  - the audit enumeration tests;
  - `departed-member-operator-scripts.integration.test.ts`;
  - the integration suites driving the changed routes:
    - `team-tenant-departure*.integration.test.ts`;
    - `scim-team-admission-approval.integration.test.ts`;
    - `team-key-version-guard.integration.test.ts` (confirm-key lock);
    - `share-departure.integration.test.ts`.
- **Gates:**
  - `check-team-rotation-input-lock`: counts re-derived. The confirm-key lock may change them,
    and that is recorded.
  - `check-migration-rls-dml`: no baseline entry. Red-proof: drop `audit_logs` from the literal.
  - `audit-db-grants --write`. Expected delta: the worker's five column grants. The trigger
    function's PUBLIC EXECUTE is revoked, so no FUNCTION rows appear; confirm.
  - `check-critical-audit-atomic`: the new action.
- Every new test is red-proved on a scratch copy.

## Considerations & constraints

- C4 fail-closes pre-C2 re-admitted actors (stated above).
- C6 adds one batched `team_members` read per team work item that has creator-bearing webhooks.
- **Scope contract:**
  - SC1: tenant-level webhooks, API keys, SA tokens, MCP clients, break-glass grants, Sends.
    Owner: a follow-up issue.
  - SC2: members POST's `TEAM_MEMBER_ADD` outside the transaction. Same follow-up.
  - SC3: `team-member-display.ts` `joinedAt`. Same follow-up.
  - SC4: the bootstrap-tenant migration keeps the bootstrap teams (deliberate).
  - SC5: extending `check-team-rotation-input-lock` to the in-file departure writers and to
    tenant-row deletes. Owner: a follow-up issue.
  - SC6: a SCIM group removal followed by approve revives earlier shares (team-level
    re-admission; intended).

## User operation scenarios

1. **SCIM `active=false`.**
   - Memberships end, and the user's webhooks pause with a visible state.
   - Their shares are refused.
   - `active=true` restores all of these; webhook events from the gap are not replayed.
2. **A departed user re-invited by an admin.**
   - `admitted_at` advances, and `TEAM_MEMBER_INVITE_ACCEPT` is written with `readmitted: true`.
   - Old shares stay refused; new ones are served.
   - They can invite again.
3. **A webhook creator demoted to MEMBER.** The webhook pauses, and the card says why. A
   re-promotion resumes it.
4. **A guest admin invites, promotes or distributes keys.** Allowed.
5. **Rollout residue actor.** They cannot invite, add, approve, promote or distribute keys. Their
   webhooks are found by the runbook report.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | SC5 recurrence: convention plus partial gate, with limits | locked |
| C2 | `admitted_at` via a same-row trigger | locked |
| C3 | Share refused when its creator departed after creating it | locked |
| C4 | One actor predicate on six sites | locked |
| C5 | Accept: locked ACCEPTED, SCIM guard, `TEAM_MEMBER_INVITE_ACCEPT` | locked |
| C6 | Webhook delivery requires the creator's authority; one predicate; visibility; backfill | locked |
| C7 | SC5 disposition and docs | locked |
