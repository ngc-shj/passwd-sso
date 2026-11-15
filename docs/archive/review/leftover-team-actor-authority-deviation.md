# Coding Deviation Log: leftover-team-actor-authority

## D1 — `getTeamMembership` imports the predicates from the pure module
The checklist said existing callers keep importing from `tenant-row-lock` so the 16 test files that
`vi.mock` it keep intercepting. `team-auth.ts` is a new caller, not an existing one, and imports
`readTenantRows` / `actorDepartedSinceAdmission` from `tenant-departure-read.ts` directly: importing
`tenant-row-lock` would pull `team-key-rotation-lock` and `@/lib/prisma`-adjacent modules into the
team-auth import graph for no benefit. Existing callers are unchanged.

## D2 — Audit classification of the two new actions
`TEAM_MEMBER_INVITE_CANCEL` is in `check-critical-audit-atomic`'s `CRITICAL_ACTIONS` (emitted only
through `logAuditInTx`, like `TEAM_MEMBER_INVITE_ACCEPT`). `TEAM_MEMBER_OPERATOR_READMIT` is not: like
`TEAM_MEMBER_TENANT_DEACTIVATE` it is written only by an operator SQL block, and the gate requires an
application `logAuditInTx` emitter. Both are in the team scope group and the webhook-subscribable
list, as `TEAM_MEMBER_INVITE_ACCEPT` is.

## D3 — Migration timestamp
`20261115000100_team_member_invite_cancel_readmit_audit_actions` (one `ADD VALUE` migration for both
actions); `20261115000000` was already taken on main.

## D4 — `TEAM_MEMBER_OPERATOR_READMIT` metadata keys fixed in B1
The plan named the contents, not the keys. `audit-log-reference.md` documents
`{ operator, readmitted, createdAt, tenantDeactivatedAt }`; the C8 script block (B3) uses exactly these.

## D5 — C7 verified from the worktree only
`backup-db.test.mjs` passes 239/239 from this worktree, with the printed compose directory equal to
the main worktree, and fails "no pg_restore reachable" under `DOCKER_HOST=unix:///nonexistent`. The
primary checkout is in use by another session on another branch and was not touched; from there the
first probe (`REPO_ROOT`) is the pre-change code path.

## D6 — `withoutLeftoverMemberships` helper (refactor not in plan)
`src/lib/team/leftover-memberships.ts` groups memberships by `tenantId` and filters them through
`readTenantRows` + `actorDepartedSinceAdmission`. Three C3 call sites (teams GET, admin shell,
pending-key-distributions) needed the same cross-tenant grouping; one helper keeps them on one reader
(C3 "no second reader"). It reads tenants sequentially: an interactive transaction is one connection.

## D7 — The worker's `tenant_members` grant includes `id`
Captured with Prisma query logging against the worktree DB: the `tenant_members` findMany issued by
`readTenantRows` selects `"tenant_members"."id"` although the select does not name it; the
`tenant_member_departures` read selects no `id` (composite key). Migration
`20261115000200_worker_webhook_creator_tenant_departure_grants` grants exactly
`team_members (admitted_at, created_at)`, `tenant_members (id, tenant_id, user_id, role,
deactivated_at)`, `tenant_member_departures (tenant_id, user_id, departed_at)`.

## D8 — Grants manifest regenerated against the worktree DB, committed delta hand-reduced
`audit-db-grants --write` first refused with `ROLE_STATE_VIOLATION` for a stale `CONNECT` grant to
the retired `passwd_dcr_cleanup_worker` on the worktree database; it was revoked on that database only
(`REVOKE CONNECT ON DATABASE passwd_sso_wt_leftover_team_actor FROM passwd_dcr_cleanup_worker`). The
regenerated file also differed in worktree-only lines (the `DATABASE:` entries carry the worktree DB
name; two `DEFAULTACL:passwd_user` lines absent). The committed manifest is `HEAD`'s plus exactly the
10 new `COLUMN:passwd_outbox_worker … SELECT` lines.

## D9 — R19: the parallel test tree was missed by B2
`src/__tests__/api/teams/team-entry-rekey.test.ts` and `team-history-restore.test.ts` exercise the
real `teamKeyVersionHolders` / restore route over mocked transactions and failed in the full run
(missing `tenantMember` / `tenantMemberDeparture`; the restore RLS mock did not pass `tenantId`; the
inactive count now reads holders' rows instead of `count`). Fixed by the orchestrator.

## D10 — C7 widened to the second compose caller (R42)
The full integration run from this worktree also failed `bootstrap-rds-roles` T11 ("service db is not
running"): its `psqlRunner` compose fallback runs `docker compose exec` with `cwd: REPO_ROOT`, the same
defect as backup-db Group B. Sweep of test code that spawns `docker compose` (`spawnSync("docker",
["compose", …])` across `src/`, `scripts/__tests__/`, `e2e/`) finds exactly these two callers; both now
probe `REPO_ROOT`, then the main worktree. bootstrap-rds-roles passes 52/52 from the worktree.
The other worktree-only integration failures were configuration: the five MinIO-backed files pass
103/103 with `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000`.

## D11 — C8 script details (B3)
- Bypass GUCs are set transaction-locally (`set_config(…, true)` inside the block's transaction), as
  `departed-member-contain` does; they revert at commit, so there is no explicit save/restore step.
- The tenant row is locked `FOR SHARE` as C8 states (contain takes `FOR UPDATE`: it departs rows).
- No shared integration helper module was extracted: the new suite copies the small fixture subset
  (`residueDepart`, `recreatedDepart`, `addTeamMember`, …) it needs; both files close over per-file
  tenant state.
- The lock-wait helpers in `departed-member-operator-scripts.integration.test.ts` were hoisted into one
  `blockedByLock` shared by the contain and readmit cells (refactor not in plan; contain unchanged).

## D12 — Runbook text beyond C6's list
Besides C6's items, B3 corrected three sentences C1/C4 made false: step 6's "remove and re-invite",
the "Paused team webhooks" sentence, and the closing "what prevents a recurrence" paragraph.

## D13 — `rls-grant-evidence-baseline.txt` loses `TEAM_ADMIN_MEMBERSHIP_LOOKUP`
`check:rls-grant-evidence` (CI-only; run locally per the CI parity entry) reported the grant "is in the
baseline but now has evidence: remove it" — the new integration cells exercise it. Removed.

## D14 — Red-proof results and the three thin spots
Every clause was red-proved on scratch copies (scratch vitest config redirecting one module; unmutated
control green through the same config first): C1, C2 member DELETE, C2 reject, C2 cancel predicate,
C3 `withoutLeftoverMemberships`, C3 holders (both functions), C4, C5 (a scratch tree of the 41 route
files with one gate call removed). Thin spots, accepted:
- Dropping `teamId` from cancel's `deleteMany` alone is caught by the unit exact-args assertion only;
  the integration IDOR cell reds when the in-transaction `findFirst` loses it, since that read is the
  cross-team gate and the `deleteMany` runs after it under the same locks.
- The bulk-reject route test mocks `rejectScimPending`; the clause is pinned by the lib tests, the
  single-reject route test and the integration bulk-reject cells.
- `src/__tests__/api/teams/team-entry-rekey.test.ts` / `team-history-restore.test.ts` do not react to
  the holder mutations; the `src/app/...` rekey and restore route tests and `team-item-key.test.ts` do.

## D15 — Checklist files with no diff (code review FN-F2)
Checked and unaffected:
- `src/__tests__/audit-outbox.test.ts` — never reaches `resolveWebhookSubscribers` /
  `webhookCreatorVerdicts` (0 references); the worker's delivery decision is tested in
  `src/workers/audit-outbox-worker.test.ts`, which changed.
- `confirm-key/route.test.ts` — mocks `requireTeamPermission`, so `getTeamMembership` never runs; its
  `findFirst` mock is the actor's in-transaction `activeTeamAdmission` read.
- `bulk-reject/route.test.ts` — mocks `rejectScimPending`; the clause is pinned by
  `scim-admission.test.ts`, the single-reject route test and the integration cells (D14).
- `tenant-row-lock.test.ts` — exercises `readTenantRows` / the predicates through the re-exports,
  which `tenant-departure-read.test.ts` pins as the same function objects.
- `mock-team-auth.ts`, `admin/layout.test.tsx`, `team-vault-core.test.tsx`,
  `vault-context-passkey-gate.test.tsx` — mock `team-auth` or the endpoint at the module boundary.
- `scim-team-admission-approval` and `team-tenant-departure` integration suites — pass unchanged
  (46/46, 71/71).
History restore takes the `(tenantId)` form of `withTeamTenantRls` and keeps its own
`prisma.$transaction`, which joins the context transaction through the prisma proxy; the holder
functions receive that `tx` and `tenantId`.

## D16 — The worker's `tenant_members.role` column grant is accepted (code review SEC-F2)
`readTenantRows` selects `role`, so the worker that reuses it needs the column although the leftover
decision reads only `deactivated_at` / `departed_at`. Worst case: the outbox worker (which also makes
outbound HTTP) can read member roles across tenants under its bypass grant; it already reads
`team_members.role`, and its webhook read and this read are scoped by `item.tenant_id`, so no role
leaves the worker. Likelihood of misuse requires code execution in the worker. Cost to narrow: a
second tenant-row reader with a narrower select, which round 1 of the plan review rejected (one
reader, FN-F2/R48). Accepted.
