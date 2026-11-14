# Coding Deviation Log: departed-member-leaked-authority

## D1 — Test-only env override for the C3 red-proof

`share-departure.integration.test.ts` reads `SHARE_CREATOR_DEPARTED_SQL` (default: the
`20261114000100_share_creator_departed` migration) so a mutated copy can be loaded for the
red-proof. It follows the file's existing `RUNBOOK_MD` / `RLS_BACKFILL_RERUN_SQL` overrides. No
production code reads it.

## D2 — Guest-creator fixture files the user under the share's tenant

The first A10 guest-creator fixture filed the guest's `users` row under another tenant, which
broke teardown and leaked a test tenant. The fixture now files it under the share's tenant; the
leaked rows were removed and a final check found no leftover test tenants, functions or triggers.

## D3 — Red-proof coverage

The testing strategy says every new test is red-proved on a scratch copy. B4 red-proved the C4
route term, the C6 predicate, the C3 function (A10b), the C5 in-transaction audit, and the three
runbook predicates (RP1–RP7). The C2 trigger, the C6 backfill block and the worker
`column_privileges` cell need a mutated migration on a database; they are red-proved on an
isolated scratch database (see D6), never on the shared dev database.

## D4 — Pre-PR gate fixes

- `scripts/rls-cross-tenant-verify.sql` (10b) pins `share_creator_admitted`'s exact bypass list;
  it now names the seven tables C3 grants (`tenant_members`, `tenant_member_departures` added).
- The C5 rollback cell's probe function has a fixed name, `c5_accept_rollback_probe`, allowlisted
  in `check-bypass-rls.mjs` `FUNCTION_RULE_ALLOWLIST` for that file only. The gate's routine-name
  parser reads a schema-qualified `public.<name>` as `public`, so the CREATE is unqualified.

## D5 — Step 2-5 self R-check

- Functionality and security: no findings.
- Testing:
  - F1 (C3/C4 divergence for a deleted tenant row with a departure record) refuted:
    `lockTenantRows` seeds an entry for every requested user, so the record is attached with
    `hasRow: false` (pinned at `tenant-row-lock.test.ts`, the `gone` entry). A helper cell for
    exactly that state was added.
  - F2: approve allow cell with `created_at < departure < admitted_at`, red-proved against the
    `createdAt`-only mutation on a scratch copy (1 failed / 21 passed; control 22 passed).
  - F3: not-called assertions added to the two status-only deny cells.
  - F4: stale `activeTeamRole` mock and comment removed from the confirm-key test.
  - Adjacent: `check-bypass-rls` named a schema-qualified `CREATE FUNCTION public.x` as `public`.
    It now names the routine after the dot, with a gate test.

## D6 — Red-proofs on an isolated scratch database

A separate database (`passwd_sso_rp1035`, migrated, granted as CI does, then dropped); nothing ran
against `passwd_sso`. Every control was green first.

| Mutation | Result |
|---|---|
| C2 trigger uses `now()` | the `clock_timestamp()` cell red |
| C2 ELSE no longer copies `OLD.admitted_at` | the active-row cell red |
| C2 INSERT no longer forces NULL | the INSERT cell red |
| C6 backfill `ORDER BY … ASC` | the backfill cell red |
| C6 backfill without the tenant match | the backfill cell red |
| Worker table-level `SELECT` on `team_members` | the column-privileges cell red |
| Worker `REVOKE SELECT (role)` | the column-privileges cell red |
| Worker `GRANT DELETE` | the table-privileges assertion red on its own |
| `audit_logs` dropped from the backfill's `bypass_tables` | `check-migration-rls-dml` fails at both lines |

## D7 — Simplify pass

- `webhookCreatorVerdicts(tx, teamId, webhooks)` in `webhook-creator-authority.ts` replaces the
  two copies of the creator lookup (the worker's `resolveWebhookSubscribers` and the webhooks
  GET), so the delivery decision and the "paused" display come from one read. Unit-tested.
- Mirror comments: `departedAt` names its SQL copies; `activeTeamAdmission` names the inlined
  `COALESCE(admitted_at, created_at)` sites.
- Not applied: a comment in `20261114000100` on why the share rule keeps `m.created_at` (editing
  an applied migration changes its checksum). The reason: a share older than a re-admitting
  departure is refused by the `GREATEST(...) >= s.created_at` clause, so `admitted_at` adds
  nothing there.
- Skipped: member DELETE and `rotate-key` keep `activeTeamRole` — they reduce authority (plan C4
  exclusions). Superseded for `rotate-key` by D8; member DELETE still keeps it.

## D8 — Code review round 1: the recipient side of C4

C4 refused a leftover membership as an **actor** only. Round 1 (S1, S2) showed the same
membership could still **receive** a grant. A leftover member is now treated as deactivated for
every grant:

- confirm-key refuses (`MEMBER_NOT_FOUND`) a leftover recipient.
- Member PUT refuses a promotion or an ownership transfer to a leftover target; a demotion stays
  allowed.
- rotate-key does not wrap the new version for a leftover key-holder, refuses a key supplied for
  one as for a non-member, and clears their `keyDistributed` in the existing `updateMany`.
  `rotate-key/data` omits them, which is where the client builds `memberKeys` from.
- rotate-key also refuses a leftover **actor**: the plan's C4 exclusion of rotate-key assumed
  rotation only reduces authority, but the rotating member generates and keeps the new key.

**The recipient's tenant row is read unlocked** (`readTenantRows`); only the actor's is locked.
A first version locked the recipient too, and the full integration run showed why not:
`lockTenantRows` takes an exclusive per-user advisory lock even in share mode, so a role change
serialised behind any SCIM transaction on the same user and answered 409
(`scim-team-admission-approval` A7d, R9). No lock is needed: the check is against residue, which
is old state. A departure racing the request either deactivates the team row first, and the
route's `deactivatedAt: null` write misses (404), or deactivates it after the commit, as for any
active member. rotate-key's `FOR NO KEY UPDATE` serialises a departure before or after it.

`pending-key-distributions` still lists leftover members: it runs under
`TEAM_PENDING_KEY_DISTRIBUTION` without tenant-row tables, and widening that grant for an
advisory list was not worth it; the confirm-key refusal is the control.

rotate-key's team lock is no longer the transaction's first statement (the actor's tenant row
comes first, per the lock order); `team-key-rotation-lock.ts`'s comment and `raw-sql-usage.txt`
follow. `check-team-rotation-input-lock` counts are unchanged.

## D9 — Code review round 2: owner assignment, and the grant-recipient gate (SC5 partly pulled in)

- `tenant/teams/[teamId]/owner` refused a leftover OWNER neither as an obstacle nor as a target.
  A leftover OWNER now counts as absent: the team is listed as ownerless, assignment answers
  `HAS_OWNER` only for a non-leftover OWNER, and the existing demotion turns the leftover row into
  ADMIN, which a team admin can then remove. A leftover target is refused (`NOT_ACTIVE`). Owner
  tenant rows are read unlocked (D8). The listing pre-filters in the query to a superset (an OWNER
  with no deactivated tenant row and no departure record cannot be leftover) and decides exactly
  in code. The listing reads the tenant's active OWNER rows first, judges them, and queries the
  ownerless teams plus the teams owned only by leftovers (`id: { in }`, a residue-sized list). A
  filter through the required User relation is refused by `check-required-user-relation`, because
  a tenant context hides the User row of someone filed under another tenant; an earlier version
  bound every stamped user of the tenant as `notIn`, which grows with the tenant's history.
- **Accepted widening (R43).** An OWNER legitimately re-admitted before
  `20261114000000_team_member_admitted_at` (NULL `admitted_at`, a departure later than
  `created_at`) is indistinguishable from a leftover, so the team is listed as ownerless and a
  tenant admin can assign another owner, demoting them. Before, the route answered `HAS_OWNER`.
  Accepted because C4 already refuses that OWNER as an actor (the team is unmanageable either
  way), the assignment needs `TEAM_OWNER_ASSIGN` plus step-up, self-assignment stays tenant-OWNER
  only, the target must be a non-leftover active member, and the demotion is audited in the same
  transaction. The demotion is not reversible by a transfer (D8 refuses a leftover target):
  recovery is to remove and re-invite the member. The runbook asks the tenant admin to confirm a
  listed OWNER is a leak first. The operator-scripts contain
  cell now expects a team with a leaked OWNER to be listed as ownerless before contain too.
- **Gate rule 8 (GRANT RECIPIENTS)** in `check-team-rotation-input-lock`. The recipient set grew
  twice under review (3 sites in round 1, the owner route in round 2), so per the review loop's
  convergence rule it is closed by a guard derived from the primitive, not by another list. Every
  grant to an existing membership row (a `role` write, `keyDistributed: true`, a `teamMemberKey`
  create/upsert, a nested `team.update` of members or keys, and their raw-SQL forms) must be
  preceded by `actorDepartedSinceAdmission` tied to the recipient by variable name, or be
  exempted with a reason. 10 grant sites: 5 recipient-checked, 5 exempted (two admissions that
  refuse an active row first, the SCIM demotion batch, rotate-key's set-checked `createMany`, and
  `team.update` of name/description). The plan deferred gate growth to SC5 because AST gates had
  seeded their own defects inside feature PRs; that risk is bounded here by mutation-testing the
  gate itself (14 gate mutations, each failing a gate test) and red-proving it against the three
  route checks it guards. SC5's remaining part (the in-file departure writers and tenant-row
  deletes) stays a follow-up.
- `readTenantRows` lowercases ids as `lockTenantRows` does; its contract now states when an
  unlocked read may decide.
- The worker's missing-verdict branch is unreachable with `webhookCreatorVerdicts`, which answers
  every id; it stays as defense in depth and is not separately tested.
