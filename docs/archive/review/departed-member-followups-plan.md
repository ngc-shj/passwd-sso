# Plan: departed-member-followups

Issue `#1045`. Follow-ups of PR `#1043` (`departed-member-leaked-authority-plan.md`, scope items
SC2, SC3, SC5 and the rule 8 limits in its code review) and PR `#1057`
(`leftover-team-actor-authority-plan.md`). The issue's SC1 moved to `#1032`; its
`pending-key-distributions` item was closed by `#1057`.
Revision 4 (round-1 to round-3 findings applied; history in `departed-member-followups-review.md`).

## Project context

- Type: web app (Next.js App Router, Prisma 7, PostgreSQL 16 with FORCE RLS) plus CI gates.
- Test infrastructure: unit + integration (real DB) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: the worktree has its own database (`passwd_sso_wt_1045`, enforce mode). No outbox worker
    runs against it, so `audit_outbox` rows stay PENDING and the integration tests need no worker
    stopped. `verifiable-local`.
  - VE2: `cli/` and `extension/` dependencies installed in this worktree (`npm ci` in both, done);
    pre-pr refuses without them. `verifiable-local`.

## Objective

1. Every audit row for a change of team membership authority commits with the change (SC2).
2. `joinedAt` reports the membership's admission time (SC3).
3. The departure-writer gate covers the writers it skipped and pins tenant-row deletes (SC5).
4. Each rule 8 limit has a recorded disposition, and the mechanism that would close them is split
   out (`#1060`).

## Decision on the gate items

Rule 8 drew findings in four passes, each inside surface the previous pass added
(`departed-member-leaked-authority-code-review.md`, Termination). Its limits — raw
`ON CONFLICT`/`MERGE`, deep nested writes, model-access aliases, caller coverage by call expression,
and the member PUT exemption — share one cause: a parse tree without a Program sees spellings, not
writes. Scope-aware resolution grows the same analyser; refusing each shape outright adds four
categorical arms over the same spelling space. Neither changes the mechanism.

A schema-enforced form is the candidate that would: triggers refusing a grant to a leftover
membership, and a deferred constraint refusing a commit that departs a user while leaving their team
memberships active. It is not a drop-in equivalent: it needs locks equivalent to `lockTenantRows`
to avoid write skew, must not wedge batches on existing residue, cannot judge a tenant-row DELETE
(the bootstrap guest case), and must run its cross-table reads under the bypass GUC pattern at
commit time. That is a separate design, filed as `#1060` with these open questions. This PR:

- leaves rule 8 and its KNOWN LIMITS as they are, with `#1060` as their owner (C4);
- applies the gate's existing site-count mechanics to what SC5 names, where no new analysis is
  needed (C3). C3 stays the control for tenant-row deletes whatever `#1060` decides.

## Contracts

### C1 — Membership-authority audits commit with the change (SC2)

- **Member set (R42).** Post-commit audits of a change to team membership authority. Derivation:
  `grep -rn -A4 'logAuditAsync(' src/app/api/teams src/app/api/tenant/teams | grep -E 'action: AUDIT_ACTION\.'`,
  cross-checked by `grep -rn 'AUDIT_ACTION\.TEAM_\(MEMBER\|ROLE\|OWNER\|INVIT\)' src`:
  | Site | Action | Disposition |
  |---|---|---|
  | members POST | `TEAM_MEMBER_ADD` | C1 |
  | invitations POST | `TEAM_MEMBER_INVITE` | C1 |
  | member PUT, ownership transfer | `TEAM_ROLE_UPDATE` | C1 |
  | member PUT, role change | `TEAM_ROLE_UPDATE` | C1 |
  | member DELETE | `TEAM_MEMBER_REMOVE` | SC3 |
  In the transaction already: accept, invitation cancel, approve/reject, confirm-key, SCIM, departure,
  tenant owner assignment. `TEAM_MEMBER_KEY_OLD_VERSION_READ` is a read signal (not in class).
- **Change.** `logAuditAsync` → `logAuditInTx(tx, tenantId, { ...teamAuditBase(req, actor, teamId), … })`
  inside each `withTeamTenantRls` callback, once the change is known to have happened, with the same
  action, target and metadata. Members POST computes its result in both branches and audits once
  before returning it; member PUT audits after its `count` checks; invitations POST audits after the
  `create`, on the ISSUED path only, and its callback parameter `_tenantId` becomes `tenantId` (the
  same value as `team.tenantId`). Refusal paths write nothing, as today.
- **Ownership transfer's `previousRole`.** It is the pre-transaction `target.role`, and the promoting
  `updateMany` does not compare it. The promotion gains `role: target.role` in its `where`, as the
  role-change arm has, so a concurrent role change fails the transfer (`MEMBER_NOT_FOUND`, as any
  other count mismatch) and the audited `previousRole` is the replaced role.
- **Gate (emitter pinning).** `check-critical-audit-atomic.mjs` gains `IN_TX_ONLY_ACTIONS`, a map of
  action → pinned count: `TEAM_MEMBER_ADD: 1`, `TEAM_MEMBER_INVITE: 1`, `TEAM_ROLE_UPDATE: 2`.
  - The count is of direct `logAuditInTx(...)` calls whose params' `action:` is the literal
    `AUDIT_ACTION.<NAME>` (the gate's existing reading); the descriptor form and `logAuditBulkInTx`
    do not count toward it. A count other than the pin fails, so deleting an emit fails.
  - Any `AUDIT_ACTION.<NAME>` of a listed action appearing anywhere in the argument subtree of a
    `logAuditAsync`, `logAuditBulkAsync` or `logAuditAsyncBothScopes` call fails (a direct property,
    a ternary arm, a mapped bulk element), so reverting an emit fails. The helper bodies in
    `src/lib/audit/audit.ts` name no action and match nothing. An action held in a variable
    (`action: auditAction`) is not attributable: a stated limit, as the sibling gates state theirs.
  - The pin is a count, not a site identity: swapping one emit for a duplicate of the other keeps it
    green. Site identity rests on the per-arm unit cells.
  - Evidence that the real tree passes is the gate run itself, recorded in Phase 2.
  - The actions also join `CRITICAL_ACTIONS` and the test's `ALL`.
- **Accepted changes.** An `audit_outbox` insert failure now rolls the change back (500) instead of
  answering 201 without the row — the intended atomicity. `logAuditInTx` does not emit
  `logAuditAsync`'s synchronous structured log line; the same trade as every `CRITICAL_ACTIONS`
  entry. `TEAM_MEMBER_INVITE`'s metadata keeps the invitee `email` it records today.
- **Control class:** atomicity by construction. The gate is a best-effort tripwire over the spellings
  it reads: an action held in a variable or built outside the call's argument is not seen, and it
  reads names and the action, not which client is passed. The per-arm route unit cells and the
  integration cells carry what it cannot see, as in `check-emergency-activate-atomic.mjs`. Action
  names are compared by exact equality (`TEAM_MEMBER_INVITE` is not `TEAM_MEMBER_INVITE_CANCEL` or
  `_ACCEPT`).
- **Acceptance:**
  - Unit, per site: the audit mock factories export `logAuditInTx`; `withTeamTenantRls` hands the
    callback a sentinel `tx` that delegates to the module `prisma` mock (so the lock helpers and
    model calls keep working) but is not identical to it; the success cell asserts
    `logAuditInTx(sentinelTx, tenantId, objectContaining({ action, targetId, metadata }))` and no
    `logAuditAsync`. Existing refusal cells asserting `logAuditAsync` was not called are re-pointed
    to `logAuditInTx`, each with a positive control (the same fixture's success emits). Files:
    `members/route.test.ts`, `invitations/route.test.ts`, `src/__tests__/api/teams/team-invitations.test.ts`,
    `members/[memberId]/route.test.ts` (both PUT arms). Member PUT's transfer `where` pins
    `role: target.role`. Invitations POST's `ALREADY_SENT` and `INVITER_GONE` outcomes call no
    `logAuditInTx` (positive control: ISSUED does). Per route, a rejecting `logAuditInTx` propagates
    out of the handler and is not mapped to a 4xx.
  - Real DB, per site (members POST, invitations POST, both PUT arms), route-driven:
    - success: exactly one `audit_outbox` row filtered by `tenant_id`, `payload->>'action'` and
      `payload->>'targetId'` (fresh tenant per cell), with the expected metadata;
    - atomicity: a temporary `BEFORE INSERT` trigger on `audit_outbox` (created on the superuser
      connection) raising with the default SQLSTATE and a marker message when the payload action and
      `tenant_id` match the cell. The handlers rethrow unmapped errors (`handleAuthError`, `throw e`,
      `withRequestLog`), so the cell asserts the handler rejects with that message, and that the
      member row, invitation or role is unchanged. Dropped in `finally`; the integration config runs
      one file at a time. With a post-commit `logAuditAsync` the change commits and the cell fails;
      that is its red proof.
  - Gate self-tests (the harness emits each listed action its pinned number of times; the "all N
    security-critical actions" string follows `ALL`; revert cells name their action explicitly
    rather than taking `ALL`'s last entry): deny — a direct async emit, a ternary arm, a mapped
    `logAuditBulkAsync` element, a count one below (deletion), one above, the pin met only through a
    descriptor; allow — the pinned tree, an identifier-valued async action (the stated limit), an
    async emit of `TEAM_MEMBER_INVITE_CANCEL`, and an in-tx `TEAM_MEMBER_INVITE_ACCEPT` that does not
    count toward `TEAM_MEMBER_INVITE`'s pin.

### C2 — `joinedAt` is the admission time (SC3)

- `TeamMemberDisplayRow` gains a required `admittedAt: Date | null`; `joinedAt` is
  `member.admittedAt ?? member.createdAt`, the effective admission (`#1043` C2).
- Callers: members GET adds `admittedAt` to its `select`; member PUT adds it to its two
  `findUniqueOrThrow` selects and to `buildMemberRoleResponse`'s parameter type (the PUT handler and
  that helper only; `#1047` edits the DELETE handler of the file); the ownerless route already
  selects it.
- **Consumer walkthrough:** `joinedAt` is read by no UI, extension, iOS or CLI code
  (`grep -rln joinedAt --exclude-dir=node_modules .`: the helper, its tests, the member route test,
  archived docs; UI pages import the type only). It is part of the members GET response
  (`TeamMemberDisplayApiItem`); member PUT and ownerless drop it.
- **Acceptance:** unit — `admittedAt` set → it; NULL → `createdAt`; route test mocks gain
  `admittedAt`. Real DB, driving the members GET handler: a member re-admitted through accept
  (`admitted_at` ≠ `created_at`) reports `admitted_at`; a never re-admitted member and a SCIM-pending
  row (NULL `admitted_at`) report `created_at`. A select missing `admittedAt` is a type error
  (required field), so the build catches the Prisma callers.

### C3 — Departure-writer gate: the writers it skipped, and tenant-row deletes (SC5)

All in `scripts/checks/check-team-rotation-input-lock.mjs`, reusing its site/exemption/pinned-count
mechanics.

- **Scope.** `TARGETS` gains `scripts`: its `.ts` files outside `__tests__` and `*.test.*` (the
  walker's rule; `scripts/__fixtures__` and `scripts/manual-tests` `.ts` files are scanned and add
  no site). Measured:
  `TEAM_ROTATION_INPUT_LOCK_TARGETS="src/app,src/lib,src/workers,src/auth.ts,scripts" node scripts/checks/check-team-rotation-input-lock.mjs`
  → `OK` with unchanged counts; `scripts/tenant-domain.ts` only reads these tables.
- **Before the IMPLEMENTATIONS skip**, for every file: rule 2 (tenant active state), rule 5
  (`deleteUser`), rule 6 (departure records), and the delete class below. The skip today exempts
  `tenant-row-lock.ts` and `team-key-rotation-lock.ts` from rules whose claim is "only X writes Y"
  (neither writes these tables, so no count changes).
- **In `team-departure.ts`** a tenant active-state write (raw `UPDATE`/`INSERT` of `tenant_members`
  naming `deactivated_at`, or the Prisma form) is a `departureWriters` site, not a violation. It is
  covered when its SQL sets the column to NULL (`/\bSET\b[\s\S]*?\bdeactivated_at\s*=\s*NULL\b/i`,
  so a `WHERE … IS NULL` does not count; Prisma: `deactivatedAt: null` in `data`), or when a call of
  `endTeamMemberships` follows it in the same function (source order — the gate's existing meaning
  of "after"; a conditional call counts, as the header's general KNOWN LIMITS say). Pinned count 3.
- **Tenant-row deletes.** `tenantMember.delete` / `deleteMany` and a raw `DELETE FROM tenant_members`
  are `tenantRowDeletes` sites with no automatic cover: each needs a reviewed EXEMPTION. Pinned 2:
  `src/auth.ts` (bootstrap migration; its teams are kept and the user reads as a guest, `#1043` SC4)
  and `deactivateScimUser` (deletes the team rows and writes the departure record in the same
  transaction). A user delete's FK cascade (`deleteUser`, refused by rule 5) removes the team rows
  with the tenant rows.
- **Control class:** best-effort tripwire over the spellings the gate already reads, with pinned
  counts as the backstop. Not seen: aliases, element access, `*Unsafe`, migrations, `.sh` / `.sql`
  files (e.g. `scripts/manual-tests/run-pr-379-test-plan.sh` deletes tenant rows in a manual test),
  and the runbook's operator SQL.
- **Harness** (`scripts/__tests__/check-team-rotation-input-lock.test.mjs`): `beforeEach` writes a
  `scripts/` placeholder; `run()` passes the two new counts via
  `TEAM_ROTATION_INPUT_LOCK_DEPARTURE_WRITERS` / `TEAM_ROTATION_INPUT_LOCK_TENANT_DELETES`;
  `EXEMPT_FILES` gains `src/auth.ts` and `src/lib/services/scim-user-service.ts` delete fixtures
  matching their exemption keys, with an `EXEMPT_TENANT_DELETES` constant.
- **Acceptance** (gate self-tests, each arm a deny/allow pair, each red-proved by reverting that arm
  on a scratch copy of the gate):
  | Arm | Deny | Allow |
  |---|---|---|
  | in-file writer, raw | deactivating `UPDATE` with no later `endTeamMemberships` | same with the call after |
  | in-file writer, order / scope | call before the write; call in another function | call after, same function |
  | in-file writer, Prisma | `tenantMember.update({ data: { deactivatedAt: new Date() } })` without the call | with it |
  | NULL anchor (one pair) | `SET deactivated_at = clock_timestamp() … WHERE deactivated_at IS NULL` without a call | `SET deactivated_at = NULL … WHERE deactivated_at IS NOT NULL` without a call |
  | pinned count | a fourth writer | the three |
  | other implementation files | tenant-state write / departure-record write / `deleteUser` call in `tenant-row-lock.ts` or `team-key-rotation-lock.ts` | the files without them |
  | `scripts/` | tenant-state write in `scripts/x.ts` | a read there |
  | tenant-row delete | `tenantMember.delete`, `deleteMany`, raw `DELETE FROM tenant_members` unexempted | the exempted pair |
  The real tree passes with the new counts.

### C4 — Rule 8 limits: disposition

- Each limit stays a KNOWN LIMIT, unchanged in the gate; the header names `#1060` as the owner,
  replacing "the SC5 follow-up issue". The member PUT exemption stays, pinned by its route unit tests.
- **Anti-Deferral (acceptable risk):**
  - Worst case: a grant in one of these spellings — a `team_member_keys` row, `key_distributed =
    true`, or a role raise — lands on a leftover membership, disclosing team key material to, or
    granting a role to, a user who departed the tenant.
  - Likelihood: low. None of the spellings occurs in `src` (`#1043` round 4: 13 grant sites, 4
    recipient-checked, 9 exempted and read by hand); leftover state arises only from residue or a
    missed departure writer (C3); and since `#1057` C1 a leftover membership is refused on every team
    route, so material wrapped to it is not usable through the app while that gate holds.
  - Cost to close here: a further analyser round of the kind the stopping rule ended, or the `#1060`
    design. Owner: `#1060`.
- **Control class:** unchanged (review tripwire).

### C5 — Documentation

- Gate header: rules 2/5/6 apply to every scanned file; the two new classes; `scripts/` is scanned;
  what is not seen (C3); rule 8's owner `#1060`.
- `docs/operations/departed-member-access-backfill.md`, "What prevents a recurrence, and its limits":
  the file's own writers and `scripts/` `.ts` are seen, tenant-row deletes are pinned, what stays
  unseen (C3), and `#1060`.
- `check-critical-audit-atomic.mjs` header: `IN_TX_ONLY_ACTIONS`.

## Forbidden patterns

- `pattern: logAuditAsync\(` in `src/app/api/teams/[teamId]/members/route.ts` and
  `src/app/api/teams/[teamId]/invitations/route.ts` — reason: their only audit is the C1 success row
  (also enforced by the gate).
- `pattern: joinedAt: member\.createdAt` — reason: C2.

## Testing strategy

- Unit: C1 route tests (four files), `team-member-display.test.ts`, the `check-critical-audit-atomic`
  and `check-team-rotation-input-lock` self-tests.
- Real DB: new `src/__tests__/db-integration/departed-member-followups.integration.test.ts` (C1 per
  site, C2), `assertRlsApplies` at file start, run with `npx vitest run --config
  vitest.integration.config.ts` (the config's glob picks it up; CI's integration job runs that
  config).
- Existing integration suites driving these routes are re-run: `departed-member-leaked-authority`,
  `leftover-team-actor-authority`, `team-tenant-departure*`, `scim-team-admission-approval`.
- Gates: both gates above, full pre-pr.
- Every new test is red-proved on a scratch copy, one mutation per clause.

## Considerations & constraints

- `src/app/api/teams/[teamId]/members/[memberId]/route.ts` is shared with `#1047` (DELETE handler).
  This PR edits the PUT handler and `buildMemberRoleResponse`; the hunks do not overlap.
- **Scope contract:**
  - SC1: tenant-level footholds — `#1032`.
  - SC2: `pending-key-distributions` — closed by `#1057`.
  - SC3: member DELETE's `TEAM_MEMBER_REMOVE` stays after the commit in this PR. `#1047` C4 rewrites
    that handler (revocation in the transaction) and records the post-commit tombstone failure count
    in this row; whether it also writes an in-transaction base row is `#1047`'s to decide, and this
    PR's review records the dependency there.
  - SC4: the schema-enforced boundary — `#1060`.
  - SC5: rule 8's other KNOWN LIMITS (names, shapes) — `#1060`.

## User operation scenarios

1. An admin adds a member, invites one, changes a role or transfers ownership: the audit row exists
   exactly when the change committed; if the audit cannot be written, the change does not happen.
2. A member re-invited after leaving: the members list shows the re-admission date.
3. A developer adds a departure writer to `team-departure.ts` without `endTeamMemberships`, a new
   tenant-row delete anywhere, or a tenant-state write in a `scripts/` `.ts` file: the gate fails and
   names the site.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Membership-authority audits in the transaction (4 sites), site-pinned gate | locked |
| C2 | `joinedAt` = `COALESCE(admittedAt, createdAt)` | locked |
| C3 | Gate: scripts, pre-skip rules, in-file writers, tenant-row deletes | locked |
| C4 | Rule 8 limits: disposition, owner `#1060` | locked |
| C5 | Gate headers and runbook | locked |

## Implementation Checklist

Phase 2, Step 2-1. B1 and B2 in parallel, then B3.

**B1 — C1, C2 (application + audit gate)**
- `src/app/api/teams/[teamId]/members/route.ts` (POST audit; GET select).
- `src/app/api/teams/[teamId]/invitations/route.ts`.
- `src/app/api/teams/[teamId]/members/[memberId]/route.ts` (PUT handler, `buildMemberRoleResponse`).
- `src/lib/team/team-member-display.ts`.
- `scripts/checks/check-critical-audit-atomic.mjs` and `scripts/__tests__/check-critical-audit-atomic.test.mjs`.
- Unit tests listed in C1/C2.

**B2 — C3, C4, C5 (lock gate and docs)**
- `scripts/checks/check-team-rotation-input-lock.mjs`, `scripts/__tests__/check-team-rotation-input-lock.test.mjs`.
- `docs/operations/departed-member-access-backfill.md`.

**B3 — integration**
- `src/__tests__/db-integration/departed-member-followups.integration.test.ts`.

**Reuse:** `logAuditInTx`, `teamAuditBase`, `withTeamTenantRls` `(tenantId, tx)` form; integration
helpers in `src/__tests__/db-integration/helpers.ts`; the route-driving and audit-probe patterns of
`departed-member-leaked-authority.integration.test.ts`.

**Step 2-1 impact analysis (recorded).**
- Test trees (R19): colocated `members/route.test.ts`, `invitations/route.test.ts`,
  `members/[memberId]/route.test.ts`, `team-member-display.test.ts`, `tenant/teams/ownerless/route.test.ts`
  (mocks the display helper; check only); centralized `src/__tests__/api/teams/team-invitations.test.ts`;
  integration suites driving these routes (re-run): `departed-member-leaked-authority`,
  `leftover-team-actor-authority`, `team-tenant-departure*`, `scim-team-admission-approval`,
  `team-key-version-guard`, `share-departure`, `concurrent-grant-serialization`.
- CI parity: no migration, grant, bypass or dependency change, so the CI-only gates
  (`check:rls-grant-evidence`, `check:migration-drift`, licenses, npm audit, terraform) are not
  affected; `lint`, `typecheck`, `typecheck:test`, `check:rls-nesting`, `check:bypass-rls` and
  `check-state-mutation-centralization.sh` are run locally in Step 2-4.
