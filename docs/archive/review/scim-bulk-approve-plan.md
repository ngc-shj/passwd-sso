# Plan: scim-bulk-approve (#1005)

Branch: `feat/scim-bulk-approve` (cut from `origin/main` at `dcc1eded9`). Finding IDs in
parentheses refer to `scim-bulk-approve-review.md`.

## Project context

- Type: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16).
- Test infrastructure: unit (vitest) + real-DB integration (`npm run test:integration`) + E2E
  (Playwright) + CI/CD.
- Verification environment constraints:
  - VE1: no IdP is wired to the dev stack; SCIM-pending rows are produced by calling the SCIM
    routes directly (as `scim-team-admission-approval.integration.test.ts` does). `verifiable-local`.
  - VE2: the step-up dialog needs a registered passkey or a recent sign-in in a real browser;
    covered by the manual test plan (`verifiable-local`), not by E2E.
  - VE3: production round-trip latency (RDS) is not reproducible locally; C6 bounds it by
    statement count instead. `verifiable-local` for the count, `blocked-deferred` for a real RDS
    timing (cost to fix: a deployed environment; worst case: a full batch answers 409 and the cap
    constant is lowered; likelihood: low at the C6 bound).

## Objective

An admin onboarding a large IdP group can approve, or reject, many SCIM-pending team memberships
in one step-up-gated request instead of one request per member behind a 30/hour limiter
(deviation D11 of `scim-team-admission-approval`).

## Requirements

- F1. `POST /api/teams/[teamId]/members/bulk-approve` admits the listed pending rows; each entry
  carries the role the approver saw.
- F2. `POST /api/teams/[teamId]/members/bulk-reject` deletes the listed pending rows.
- F3. Every row goes through the single routes' checks: still pending, in this team, role pin
  (approve), target active in the tenant (approve), approver holds the current key (approve). A
  row that fails a check is skipped and reported; the others commit.
- F4. One team-scope audit row per admitted or rejected member, in the transaction of its write.
- F5. The team members page offers "approve all" and "reject all" over the pending rows it shows,
  each behind a confirmation dialog.
- N1. The bulk routes admit or reject nothing that calls of the single routes could not; what
  changes is the rate (per route and user: 10 requests/hour × the cap on each bulk route, next
  to the single routes' 30 rows/hour each) and that one confirmation covers many rows (C5 shows
  the per-role breakdown for that reason).
- N2. A bulk request holds its locks for a bounded time (C6), and takes locks only for rows that
  were pending when it read them (C2).
- N3. Whichever of this branch and #1035 merges second cannot silently ship an approve path
  without the departed-actor check (C8).

## Technical approach

The per-row decision of the single routes is a security control (admission to a team and its
key). It moves into one module that the single and the bulk routes both call, so there is one
adjudicator; the single routes become the one-row case.

The module takes the locks itself, in the documented order (`tenant-row-lock.ts`): the actor's
and every target's tenant row in ONE `lockTenantRows` call (share mode), then the team. That
keeps `check-team-rotation-input-lock` rules 1, 3 and 4 decidable in the function that writes.

One transaction per request: every row's write and its audit row commit together, a refused row
writes nothing, and any throw (lock conflict, audit failure, transaction expiry) rolls the whole
request back. Per-row transactions were rejected: each would retake the team lock and the
actor's row, and a request could end half done with no single answer.

Per target the module issues the single routes' statements unchanged: one locked `findFirst`,
one write, one `logAuditInTx`. A batched read and `logAuditBulkInTx` (`audit.ts`) were considered
and not taken: the single-route unit tests' transaction double offers only `findFirst` /
`updateMany` / `deleteMany` and `logAuditInTx`, and keeping those tests untouched is what proves
the move preserved behaviour (AC1) and keeps #1035's additions to them applicable (T2, F6). The
cost is a per-row statement count, which C6 bounds.

Concurrency: no new primitive. `lockTenantRows` takes N advisory locks in one statement in
`COLLATE "C"` key order, as SCIM's `lockGroupWrite` does for a group's users. Probe: see
`## Probe record`.

## Contracts

### C1 — Admission module `src/lib/team/scim-admission.ts`

```ts
export type ScimAdmissionContext = {
  teamId: string;
  actorUserId: string;
  ip: string | null;         // as extractRequestMeta returns them
  userAgent: string | null;
  batchId?: string;          // bulk routes only; copied into each audit row's metadata
};
export type ApproveTarget = { memberId: string; userId: string; expectedRole: TeamRole };
export type RejectTarget = { memberId: string; userId: string };

// null = the actor may not act (nothing written); else one outcome per target, keyed by memberId.
export async function approveScimPending(
  tx: Prisma.TransactionClient, tenantId: string, ctx: ScimAdmissionContext,
  targets: readonly ApproveTarget[],
): Promise<Map<string, ScimApproveOutcome> | null>;
export async function rejectScimPending(
  tx: Prisma.TransactionClient, tenantId: string, ctx: ScimAdmissionContext,
  targets: readonly RejectTarget[],
): Promise<Map<string, ScimRejectOutcome> | null>;
```

`userId` is the row's user as the route's unlocked pre-read saw it. Outcome values live in
`src/lib/constants/team/scim-admission.ts` (client-importable): `SCIM_APPROVE_OUTCOME =
{ APPROVED, NOT_FOUND, ROLE_CHANGED, TENANT_INACTIVE, CAS_FAILED }`, `SCIM_REJECT_OUTCOME =
{ REJECTED, NOT_FOUND }`.

Invariants (app-enforced unless noted):

- V1. Lock order: exactly one `lockTenantRows(tx, tenantId, [actor, ...target users], "share",
  budget)`, then `lockTeamsAgainstRotation(tx, [teamId], budget)`, before any read the decision
  uses; one `createLockBudget()`. Writes sit in the function that takes the locks, in a plain
  loop (not a callback), which is what gate rules 1/3/4 can read.
- V2. Actor, re-read under the locks: an active row of this team with `MEMBER_INVITE`; approve
  additionally requires `keyDistributed`. Failing → `null`, no write, no audit row. (C8 adds the
  departed-actor condition here.)
- V3. Per target, in this order: locked re-read `{ id, teamId, userId, scimApprovalPending: true }`
  selecting `role`, missing → `NOT_FOUND`; approve: role ≠ `expectedRole` → `ROLE_CHANGED`;
  approve: target's tenant row absent or deactivated → `TENANT_INACTIVE`; then the write.
- V4. Approve write: the existing CAS (`where { id, teamId, role: expectedRole,
  scimApprovalPending: true, deactivatedAt: { not: null } }`, `data { deactivatedAt: null,
  scimApprovalPending: false, keyDistributed: false }`); count ≠ 1 → `CAS_FAILED`. Reject write:
  the existing `deleteMany { id, teamId, scimApprovalPending: true }`; count ≠ 1 → `NOT_FOUND`.
- V5. Audit: `logAuditInTx` right after each successful write, fields as today
  (`TEAM_MEMBER_SCIM_APPROVE` / `_REJECT`, scope TEAM, `targetId` = target user). `metadata.role`
  is `expectedRole` for approve and the locked re-read's `role` for reject (F1);
  `metadata.batchId` is present only when `ctx.batchId` is (S6). A refused row emits nothing. A
  throw from any statement propagates; the module never returns outcomes for a batch it did not
  finish (T5).
- V6. A pending row is never OWNER, active, or departure-marked — **schema-enforced** (CHECK
  constraints `team_members_scim_pending_*`); "self-approval is impossible" rests on it, as today.
- V7. Module boundary, enforced by gate rule 7 (extended; S1, F3, T10):
  (a) `scimApprovalPending` set to anything but literal `true` only in this module (the
  allowlist moves from the approve route);
  (b) the module is imported only by the four route files (the two single, the two bulk). The
  gate resolves each import / `export … from` / literal `import()` / literal `require`
  specifier to a path (`@/` → `src/`, a relative one against the importing file) and compares
  it with the module's; any `export … from` of it is refused;
  (c) those four routes do not call `lockTenantRows`;
  (d) audit emitters by import allowlist over every `@/lib/audit/*` specifier (F9, T21): the
  four routes import only `extractRequestMeta` from `@/lib/audit/audit` and nothing else from
  `@/lib/audit/*`; the module imports only `logAuditInTx` from `@/lib/audit/audit` and nothing
  else from `@/lib/audit/*`.

Control classes: locks + CAS — `enforceable boundary` (authority: PostgreSQL row state read under
V1's locks). V7 — `fail-closed verification gate` for what it reads (AST over import/export
declarations and call expressions of the scanned tree; test files are outside the scan, so tests
may import the module). Known limits: an `import()` / `require` with a non-literal specifier is
not followed; a missing route or module file is not an error (the gate judges importers that
exist). What V7 does NOT enforce: that an allowlisted route keeps its permission check, step-up
and limiter in front of the module call. Removing the step-up call is caught by the step-up
client-coverage gate (manifest bijection); ignoring its result, reordering it, or dropping
`requireTeamPermission` / `checkRateLimitOrFail` is caught only by the route unit tests (U2 and
the single routes' existing tests) (S9).

Acceptance:

- AC1. The single approve and reject routes' existing unit tests pass with no edit to the test
  files.
- AC2. `scim-team-admission-approval.integration.test.ts` passes with no edit to the file.
- AC3. `node scripts/checks/check-team-rotation-input-lock.mjs` exits 0 with `memberWrites` 21,
  `admissions` 7 (two writes moved, none added). Gate self-tests. V7(b) deny: a fifth file
  importing the module by alias, by relative path, by literal `import()`, and re-exporting it
  (`export *` and `export { … }`); allow: the four routes, and a page importing
  `@/lib/constants/team/scim-admission` (the near-named constants file). V7(c) deny/allow: a
  route calling `lockTenantRows` / not. V7(d) deny: a route importing `logAuditInTx`,
  `logAuditAsyncBothScopes`, `enqueueAudit` from `@/lib/audit/audit-outbox`, or
  `enqueueAuditInTx` from `@/lib/audit/audit-outbox-in-tx`; the module importing
  `logAuditAsync`; allow: the current shapes. The four existing rule-7 deny tests follow the
  reworded message;
  the old approve-route path with `scimApprovalPending: false` now fails; the module path passes
  with an approve-shaped and a reject-shaped fixture (T11).

Consumers of the outcome maps: the two single routes (C4) and the two bulk routes (C2/C3).

### C2 — `POST /api/teams/[teamId]/members/bulk-approve`

Request (`bulkApproveMembersSchema`, strict): `{ members: [{ memberId: uuid, expectedRole:
TEAM_INVITE_ROLE_VALUES }] }`, 1..`SCIM_BULK_ADMISSION_MAX` entries. `memberId` is lowercased by
the schema; uniqueness is checked on the lowercased form (else 400), and results carry it (S7,
F2).

Handler order: session (401) → `requireTeamPermission(MEMBER_INVITE)` → step-up
`// @stepup id:team-member-bulk-approve-post method:POST` → rate limit
(`rl:team_member_bulk_approve:<userId>`, **10/hour**, `failClosedOnRedisError: true`, scope
`teams.member_bulk_approve`) → body (400) → unlocked pre-read → transaction.

Rate: D3 of the original plan chose 30/hour "the plan named no number"; it throttles a stepped-up
admin session, not a specific threat. 10 requests × 100 rows covers a 1000-user onboarding in an
hour and leaves the bulk routes a third of the single routes' request budget (S5).

Pre-read: `teamMember.findMany({ where: { id: { in }, teamId, scimApprovalPending: true },
select: { id, userId } })` under `withTeamTenantRls`. Only rows pending at the pre-read enter the
module, so a list of active members' ids takes no lock (S2). A row that turns pending after the
pre-read is `not_found`; it is not retried. The `expectedRole` of each target comes from the
request entry with the same `memberId`, never from position (T7).

Responses:

- 200 `{ results: [{ memberId, outcome }] }`, one per requested id in request order. Ids the
  pre-read did not return are `not_found`. If it returns none, no transaction is opened and the
  answer is 200 with every row `not_found` — including for an actor who would have been refused
  under lock; nothing was attempted for them to be refused.
- 403 `FORBIDDEN` — the module returned `null`.
- 409 via `membershipConflictResponse` — lock conflict; nothing committed.
- 401 / 404 / 403 / step-up / 429 / 503 (limiter store down) / 400 as the single route.

The response says nothing about other teams' rows: they are `not_found`, like an unknown id.
`batchId` = `randomUUID()` per request, passed in the context.

Consumer walkthrough: the members page (C5) reads `results[].outcome` only — counts `approved`,
checks whether every other outcome is `not_found`, then refetches the list.

Acceptance: U2 and B1, B2, B4–B8 green.

### C3 — `POST /api/teams/[teamId]/members/bulk-reject`

As C2 with: body `{ memberIds: uuid[] }` (same bounds, lowercasing and uniqueness), step-up id
`team-member-bulk-reject-post`, limiter `rl:team_member_bulk_reject:<userId>` (10/hour) / scope
`teams.member_bulk_reject`, `rejectScimPending`, `SCIM_REJECT_OUTCOME`. No key requirement.
Acceptance: U2 and B2, B3, B8 green.

### C4 — Single routes call the module

`members/[memberId]/approve/route.ts` and `.../reject/route.ts` keep everything up to and
including their pre-read (unchanged, not filtered on pending), then call the module with one
target and no `batchId`, and map: `null` → 403 `FORBIDDEN`; `NOT_FOUND` → 404
`MEMBER_NOT_FOUND`; `ROLE_CHANGED` → 409 `SCIM_APPROVAL_ROLE_CHANGED`; `TENANT_INACTIVE` → 409
`SCIM_APPROVAL_TARGET_INACTIVE`; `CAS_FAILED` → 409 `CONFLICT`; success → `{ success: true }`.
Acceptance: AC1, AC2.

### C5 — Members page

`src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`, for OWNER/ADMIN viewers:

- "Approve all (N)": N = shown pending rows without `pendingTenantInactive`, first
  `SCIM_BULK_ADMISSION_MAX` in display order. Rendered when N ≥ 2.
- "Reject all (N)": N = shown pending rows, same cap. Rendered when N ≥ 2.
- "Shown" = `filteredMembers` (the search box narrows the set).
- Each opens a confirmation dialog. Approve's dialog states N and the count per role, with the
  ADMIN count on its own line when non-zero (an ADMIN can invite and manage members; the team
  key still reaches them only through a key holder's separate confirm-key) (S3, S11). Reject's dialog reuses the single reject's explanation. When more pending rows
  exist than the cap, the dialog says how many remain for a second pass.
- The list sent is captured when the dialog is confirmed; the step-up retry variant carries that
  captured list (ids + roles, or ids) and replays it as is (F7).
- No request is sent before confirm, or on cancel.
- Errors: `handleStepUpError`; `FORBIDDEN` / `CONFLICT` / `TEAM_BUSY` / `RATE_LIMIT_EXCEEDED` as
  the single handlers. On 200: approved (rejected) count toast; if nothing succeeded and every
  outcome is `not_found`, the existing `requestAlreadyHandled` message instead; otherwise a
  second toast with the skipped count when non-zero; then `fetchAll()`.

New `messages/{en,ja}/Team.json` keys (ICU plurals; no number written into a string).
`apiPath.teamMembersBulkApprove(teamId)` / `teamMembersBulkReject(teamId)`. Acceptance: U4 green,
manual test plan executed.

### C6 — Cap `SCIM_BULK_ADMISSION_MAX` = 100

`src/lib/constants/team/scim-admission.ts`; used by both schemas, the page and the tests.

The binding limit is what other writers tolerate: a SCIM write, a departure or a rotation
waiting on this request's locks gives up after `TEAM_KEY_LOCK_TIMEOUT_MS` (3 s). The cap stands
only if both hold, for approve and for reject (T6, F6, S7):

1. Local: B7 times the route call only (`performance.now()` around it), one warm-up then 5
   runs, each run seeding its own cap-sized set of pending rows before the timer by one
   `INSERT … SELECT generate_series`, and prints
   `[B7] kind=<approve|reject> n=<cap> max_ms=<…> statements=<…>`. Max < 1500 ms (half the lock
   timeout). Condition: this worktree's database, no worker process on it.
2. Latency-independent: statements per full batch × 3 ms < 3000 ms. The count is every
   `pg` `Client.prototype.query` call during one route call (a spy in B7 only; it includes
   BEGIN/COMMIT, RLS context and lock statements). B7 also prints the count for a 10-row batch,
   to show it scales with rows rather than being a constant. 3 ms is an assumption, not a
   measurement: a deliberately high per-statement round trip for an app and database in one
   region (VE3); the local figure from (1) divided by the count is recorded next to it.

Otherwise the cap is lowered to the largest multiple of 10 that passes; either way the numbers
and the command go in the deviation log. B7 imports the constant. No timing assertion in CI.

### C7 — Registries

Derived from: `grep -rnE "team-member-approve-post|members/\[memberId\]/approve|teamMemberApprove|member_approve" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git | grep -v docs/archive`,
plus pinned-count gates `grep -nE "EXPECTED[A-Z_]*=[0-9]+|_COUNT=[0-9]+" scripts/checks/*.sh`,
plus `grep -rn "failClosedOnRedisError" scripts/checks`.

| File | Change |
|------|--------|
| `scripts/checks/stepup-route-paths.json` | two ids → `apiPath.teamMembersBulkApprove` / `…Reject` |
| `scripts/checks/route-policy-manifest.json` | two entries, by hand (copy the approve entry; sorted) |
| `docs/security/route-policy-matrix.md` | regenerated from the manifest (`scripts/generate-security-matrices.ts`) |
| `scripts/checks/fail-closed-manifest.txt` | two `…/route.ts	1` lines |
| `scripts/checks/check-fail-closed-routes-have-test.sh` | `EXPECTED_LIMITER_COUNT` 75 → 77 and its comment (T1) |
| `scripts/checks/check-team-rotation-input-lock.mjs` + test | rule 7: V7(a)–(d) |
| `src/lib/constants/auth/api-path.ts` + test | two builders |
| `docs/security/step-up-reauth-routes.md` | the two bulk routes, and the two single routes missing today (F5) |
| `docs/operations/audit-log-reference.md` | `batchId` in the two actions' metadata |
| `CLAUDE.md`, `docs/architecture/tenant-team-scim-spec.md` | the two endpoints |

Not changed: `check-critical-audit-atomic.mjs` (keyed by action; both listed), audit constants /
i18n / icons (no new action), `prisma/schema.prisma`, proxy classification (`/api/teams/*`).

Acceptance: every gate the static-checks CI job runs exits 0 (run via the repo's pre-PR script),
plus `npm run lint`, `npx vitest run`, `npx next build`.

### C8 — Departed-actor tripwire (#1035)

#1035 adds `actorDepartedSinceAdmission` (`tenant-row-lock.ts`) and applies it to the approve
route's approver check; after C4 that check lives in the module. It cannot be implemented on
`main` (it needs #1035's `admitted_at` column). To make the omission loud in either merge order
(S4):

- `scim-admission.test.ts` computes `hasDepartedActorCheck` = the real `tenant-row-lock` module
  (`vi.importActual`) exports `actorDepartedSinceAdmission`, OR `prisma/schema.prisma`'s
  `TeamMember` model has an `admittedAt` field (a second signal that does not depend on the
  function's name). The schema signal is read from the `model TeamMember { … }` block's field
  lines with comments stripped; an always-run test asserts that block was found and holds a
  field present on `main` (`scimApprovalPending`), and a block that cannot be located throws
  rather than reading as "absent" (T20). Two further tests, so the report shows which ran:
  - `it.runIf(hasDepartedActorCheck)`: `approveScimPending` returns `null`, with no write and no
    audit row, for an actor whose locked tenant row departed at their admission time (equal
    refuses), after it, and with `admittedAt` NULL and `createdAt` before the departure; and it
    admits for an actor re-admitted after the departure. Fixtures: the actor `findFirst` returns
    `admittedAt` / `createdAt`; the mocked `lockTenantRows` returns `LockedTenantRow`s with
    `deactivatedAt` / `departedAt`.
  - `it.runIf(!hasDepartedActorCheck)`: asserts only that neither signal is present.
- The module test's mock of `@/lib/team/tenant-row-lock` spreads `importOriginal()` and
  overrides `lockTenantRows` only, so the module calls the real predicate (F11).
- So the branch that merges second goes red until the condition is in the module: in its PR when
  that branch contains `main` (the `approve/route.ts` conflict forces #1035 to rebase; this
  branch rebases by plan), otherwise on `main` right after the merge.
- Resolution either way: the module's actor read selects `admittedAt, createdAt`, and V2 gains
  `|| actorDepartedSinceAdmission(rows.get(actorUserId), admittedAt ?? createdAt)` for approve.
  Reject keeps no such check, as #1035 decided for the single reject (it only reduces
  authority); bulk-reject follows.
- If #1035 has merged when this PR is opened, the rebase and the resolution are part of this PR.

Control class: `best-effort tripwire` — it detects the export by name; a rename in #1035 defeats
it. Recovery path: the PR body states the obligation, and #1035's own route tests for a departed
approver run through the module after either rebase.

Acceptance: rehearsed on a scratch copy carrying #1035's real `tenant-row-lock.ts` and
`admitted_at` schema field (taken with `git show` from its branch): the first test is red
without the condition and green with it, at the equal boundary and on the re-admitted allow
side. The PR body states the merge-order obligation.

## Testing strategy

Unit:

- U1. Module (`scim-admission.test.ts`): actor refusals → `null`, nothing written; outcome per
  target and that a refused target does not stop later ones; precedence (missing + stale role →
  `NOT_FOUND`; stale role + departed target → `ROLE_CHANGED`); one `lockTenantRows` call holding
  actor + every target user; audit once per success with exact fields (reject's role from the
  locked row, not from a stale fixture; `batchId` present only when given), never for a refusal;
  `logAuditInTx` rejecting on the k-th call propagates. Plus C8's tests.
- U2. Bulk routes (`bulk-approve/route.test.ts`, `bulk-reject/route.test.ts`): 401; permission
  error; step-up refusal with an invalid body returns the step-up error; 429 with a valid body
  does not reach the pre-read; 503 via `assertRedisFailClosed` (one per limiter, with
  `assertNoMutation`); 400 for empty, over-cap, duplicate ids (same and mixed case), bad role,
  unknown key; the pre-read double returns rows in a different order than requested with a
  distinct role per entry, and each target gets its own `expectedRole`; pre-read misses →
  `not_found`; empty pre-read → 200, no transaction; module `null` → 403; lock conflict → 409;
  200 shape and order. Every denial asserts the transaction was not entered.
- U3. Schemas: 0, 1, cap, cap+1 entries (the constant), both schemas; mixed-case duplicate.
- U4. Page: each button rendered only at N ≥ 2 for admins; counts follow the search filter and
  exclude tenant-inactive rows for approve; per-role counts in the dialog; no fetch to the bulk
  URL before confirm or after cancel; request body in display order, capped; summary and
  already-handled toasts; step-up retry replays the captured body; the existing per-row buttons
  still render.
- U5. Gate self-tests (AC3).

Integration (`scim-bulk-approve.integration.test.ts`, through the route handlers; its own copy
of the fixture helpers it needs, so the existing suite's file stays untouched — AC2, and no
conflict with other branches editing it; T12):

- B1. Mixed batch: approvable (one ADMIN, one MEMBER), stale role, tenant-departed target,
  already-approved, another team's pending id, an unknown uuid → the right outcome each (the
  last two identical); exactly the approved rows are active, unpending, `key_distributed = false`;
  one `TEAM_MEMBER_SCIM_APPROVE` row per approved member, all with one `batchId`, none for others.
- B2. Keyless admin: bulk-approve 403, every row still pending, no audit row; the same caller's
  bulk-reject 200.
- B3. Bulk-reject deletes exactly the listed pending rows; an active member's id, another team's
  pending id and an unknown uuid are `not_found` and those rows are intact.
- B4. Single approve vs bulk on one row: the bulk request is parked first (team row held), the
  single approve queues behind it; on release the bulk admits, the single answers 404; one audit
  row for that member.
- B5a. A SCIM PATCH remove over users [A, B] is parked holding A's advisory lock (blocker holds
  B's, B sorting after A); a bulk approve of A and an unrelated C is shown parked behind the SCIM
  backend; on release SCIM withdraws A; the bulk answers 200 with A `not_found`, C `approved`.
- B5b. A blocker holds a target's advisory lock past `TEAM_KEY_LOCK_TIMEOUT_MS`: 409, every row
  still pending, no audit row.
- B5c. A blocker holds an ACTIVE member's advisory lock; a bulk request listing only that
  member's id answers 200 with `not_found` while the blocker is still held and has no waiter,
  and no audit row exists (S2). The pass condition is the response, not that the call settled:
  without the pre-read filter it would settle as a 409 after the lock budget. Positive control
  in the same cell: with a PENDING row's user held instead, the request is shown parked.
- B6. Users A < M < Z by id. A blocker holds M's advisory lock; bulk1 (team 1) over {A, M, Z}
  parks on it; bulk2 (team 2) over {A, Z} is shown parked behind bulk1; on release both answer
  200 and each team's rows are admitted with their audit rows.
- B7. C6 measurement, approve and reject.
- B8. Atomicity: `@/lib/audit/audit` is partially mocked in this file (`importOriginal()` spread,
  `logAuditInTx` routed through a spy whose default is the real function). With the spy set in
  the test body to reject on its third call, a 3-row approve rejects (the handler rethrows; it is
  called directly), no row is admitted and no audit row exists; the same batch without the fault
  admits 3. The spy is restored to the pass-through in `afterEach`.

Every race cell proves its waiter parked (`waitForBackendBlockedBy` / `settledOrBlocked`) before
the blocker is released.

Red-proofs (Phase 2, on scratch copies only, observed failure text recorded; T8): remove the
`keyDistributed` check → B2; remove the role pin → B1; drop the team lock → B4; per-row
transactions → B8; reverse the advisory-lock order → B6; drop the pre-read's pending filter →
B5c; allowlist the old approve path in rule 7 → U5; one mutation per V7 clause → U5.

Manual: `docs/archive/review/scim-bulk-approve-manual-test.md` — approve all / reject all in the
browser with a stale step-up, a search filter, a role raised between page load and click, an
ADMIN row in the batch, and more pending rows than the cap.

## Considerations & constraints

- **Rebase onto #1035**: C8. Its gate rule 8 reads the approve CAS as no grant (`where` names
  `scimApprovalPending: true`; `data` sets `keyDistributed: false`), so its pinned `grants` count
  is unaffected. Textual conflicts expected: `approve/route.ts` (one hunk; keep this branch's
  route, apply C8's resolution) and possibly the gate's rule-7 header comment.
- A bulk request holds an exclusive advisory lock per target user for its duration; a SCIM write
  on one of them waits, or the bulk request answers 409. Bounded by C6.
- Team webhooks fire once per audit row, as N single approvals would.
- Server-side refusal of ADMIN rows in bulk-approve was considered (S3) and not taken: the issue
  asks for the single routes' checks, the single approve admits an ADMIN on one click with no
  dialog, and the bulk dialog shows the ADMIN count. Recorded for the user's decision.

Scope contract:

- SC1. Per-row checkboxes for a bulk action — not in #1005; the search filter narrows. Owner: a
  future issue.
- SC2. Looping over more than the cap in one click — the admin repeats. Owner: same.
- SC3. The single routes' 30/hour limit — unchanged.
- SC4. E2E of the bulk buttons — VE2; the manual test plan covers it.
- SC5. A departed-actor check on reject (single or bulk) — #1035's decision.

## User operation scenarios

1. 60 pending rows: "Approve all (60)", dialog "60 members: 58 Member, 2 Admin", step-up, "60
   approved".
2. SCIM raised 3 users after the page loaded: "57 approved", "3 not approved"; the refreshed list
   shows the 3 at their new role.
3. 150 pending rows: the button reads 100, the dialog says 50 remain; a second pass handles them.
4. A keyless ADMIN: approve all → the existing "needs the current team key" message; reject all
   works.
5. A search narrows to 12 pending rows: "Reject all (12)" rejects only those.
6. Two admins confirm at once: one gets "60 approved", the other "already handled" or a
   busy/retry message.
7. One pending row shown: no bulk button; the row's own buttons remain.

## Probe record

2026-11-14, worktree database `passwd_sso_wt_1005`, base `dcc1eded9`:
`npm run test:integration -- src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`
→ `Test Files 1 passed (1)`, `Tests 46 passed (46)`, 7.62 s, exit 0. The existing cells A6, A7,
A7b, A7c, A7d are among the 46. The isolation level is not part of the design: every decision is
read after V1's locks at the default READ COMMITTED.
`node scripts/checks/check-team-rotation-input-lock.mjs` → `OK {"memberWrites":21,"tenantStateWrites":2,"admissions":7}`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Admission module (locks, per-row decision, audit, boundary gate) | locked |
| C2 | bulk-approve route | locked |
| C3 | bulk-reject route | locked |
| C4 | Single routes call the module | locked |
| C5 | Members page bulk actions | locked |
| C6 | Row cap and its measurement | locked |
| C7 | Registries | locked |
| C8 | Departed-actor tripwire (#1035) | locked |

## Implementation Checklist

Files (Phase 2 impact analysis; C7's table lists the registries):

- New: `src/lib/team/scim-admission.ts` + `scim-admission.test.ts`;
  `src/lib/constants/team/scim-admission.ts`;
  `src/app/api/teams/[teamId]/members/bulk-approve/route.ts` + `route.test.ts`;
  `src/app/api/teams/[teamId]/members/bulk-reject/route.ts` + `route.test.ts`;
  `src/__tests__/db-integration/scim-bulk-approve.integration.test.ts`;
  `docs/archive/review/scim-bulk-approve-manual-test.md`, `-deviation.md`.
- Changed: `members/[memberId]/approve/route.ts`, `members/[memberId]/reject/route.ts` (their
  test files are NOT edited — AC1); `src/lib/validations/team.ts` + `team.test.ts`;
  `src/lib/constants/auth/api-path.ts` + `api-path.test.ts`;
  `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx` + `page.test.tsx`;
  `messages/en/Team.json`, `messages/ja/Team.json`;
  `scripts/checks/check-team-rotation-input-lock.mjs` +
  `scripts/__tests__/check-team-rotation-input-lock.test.mjs`; the C7 registries and docs.
- Test trees referencing the changed symbols (R19): co-located `route.test.ts` for approve and
  reject; `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`
  (calls the routes; untouched, AC2); `page.test.tsx`. No e2e spec touches the members page.

Reuse (do not reimplement): `lockTenantRows`, `isMembershipLockConflict`
(`src/lib/team/tenant-row-lock.ts`); `createLockBudget`, `lockTeamsAgainstRotation`
(`team-key-rotation-lock.ts`); `hasTeamPermission`, `requireTeamPermission` (`team-auth.ts`);
`requireRecentCurrentAuthMethod`; `createRateLimiter` + `checkRateLimitOrFail`; `parseBody`;
`withTeamTenantRls`; `logAuditInTx`, `extractRequestMeta`; `membershipConflictResponse`;
`errorResponse` / `handleAuthError` / `unauthorized`; `withRequestLog`; `MS_PER_HOUR`,
`TEAM_MEMBERSHIP_TX_TIMEOUT_MS`, `TEAM_INVITE_ROLE_VALUES`; test helpers
`assertRedisFailClosed` (`src/__tests__/helpers/fail-closed.ts`) and the race helpers in
`src/__tests__/db-integration/race-helpers.ts`; page: `handleStepUpError`, `useInlineReauth`,
`readApiErrorBody`, the existing `AlertDialog` composition.

CI parity: gates CI runs that `scripts/pre-pr.sh` does not name —
`scripts/check-state-mutation-centralization.sh` (run by hand in Step 2-4),
`check-npm-audit.mjs` and `check-terraform-test-count.mjs` (no dependency or Terraform change in
this diff; not run).
