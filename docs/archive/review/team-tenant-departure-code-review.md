# Code Review: team-tenant-departure
Date: 2026-11-01
Review round: 2

Base: `a0ee2277c` (the head of PR #986, which this branch is stacked on).

## Changes from Previous Round
Initial review. Phase 2's self-check (R1-R57/RS/RT) had already fixed three
findings in `30f0ec5ff`: SCIM group routes not mapping the tenant-row timeout to
409 (R3), the ownerless list offering candidates the owner route refuses (R48),
and the owner-assignment UI lacking confirmation and error mapping (R8).

## Functionality Findings
- F1 [Major] Invitation POST did not re-check the inviter under the lock — same as S1.
- F2 [Major] The shared lock budget was spent on non-lock work: four round trips
  per user for the advisory locks, and directory sync's own work before its
  transitions — false conflicts on large writes.
- F3 [Minor] SCIM group PUT/PATCH did not pass the membership transaction timeout.
- F4 [Minor] The personal audit "Team" filter lacked the three new actions.
- F5 [Minor] Directory sync called `departCreatedMembership` per user.
- F6 [Minor] The ownerless list offered a tenant ADMIN themselves.
- F7 [Adjacent, Minor] Planned A10 race cells missing — see T4.

## Security Findings
- S1 [Major] Invitation POST decided the inviter's authority before the
  transaction only: an inviter whose departure committed after the permission
  check could issue an invitation stamped after the departure, which accept
  admits; departure step 4 had already run. (escalate: false)
- S2 [Minor] Members POST and DELETE did not re-check the acting member under the
  lock (PUT did).

## Testing Findings
- T1 [Major] The backfill's mixed-case fixture was vacuous.
- T2 [Major] The backfill cell lacked arms 2a, 2b-equal, 2c and the cross-tenant
  membership; idempotency checked one table.
- T3 [Major] The two-user reverse-order race could not deadlock.
- T4 [Major] Planned A10 race cells missing without a deviation entry.
- T5 [Major] Rotation -> pending exclusion -> return -> confirm-key not run on a real DB.
- T6 [Major] The lock-timeout cell bypassed the directory-sync engine.
- T7 [Major] The mixed-case cell claimed accept but tested only POST.
- T8 [Major] The gate self-test lacked exemption-adjacent and partial-caller denies.
- T9 [Minor] Refusal cells did not assert EXPIRED; diverged-tenant arm missing.
- T10 [Minor] The A8 negative audit check had no positive control.
- T11 [Minor] A3 compared stamps at millisecond precision; arms missing.
- T12 [Minor] `expect([410]).toContain(...)`.

## Adjacent Findings
- F7 (testing scope) — merged into T4.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R3: F3 (timeout contract not carried to the group routes); F1's members POST note.
- R12: F4. R48: checked — one predicate (`departedSince`, `>=`) in accept, POST and backfill.
- R5/R9: checked. R38: checked (accept returns its EXPIRED refusal). R45/R53 analogue: F2.

### Security expert
- R3: S2. R49/R51: S1 (plan claimed "refused by POST"; authority bound to a pre-transaction read).
- R5/R9/R12/R14/R25/R38/R42/R48: checked. RS1/RS4: N/A. RS2/RS3: checked.

### Testing expert
- RT4: T3. RT7: T1, T8. RT10: T8, T10. RT5: T6.
- RT1/RT3/RT6/RT11/R33/R35/R42: checked.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1.

## Resolution Status
### S1 / F1 [Major] Invitation POST did not re-check the inviter
- Action: the issuing transaction re-reads the inviter's team membership after
  `lockTenantRows` and refuses (403) when it is gone or lacks MEMBER_INVITE.
  Real-DB cell with the permission check answering as before the departure;
  allow side: an active guest ADMIN. Red-proved (R1).
- Modified file: src/app/api/teams/[teamId]/invitations/route.ts

### S2 [Minor] Members POST/DELETE actor re-check
- Action: both re-check the acting member under the team lock (403 / 404).
- Modified file: src/app/api/teams/[teamId]/members/route.ts, src/app/api/teams/[teamId]/members/[memberId]/route.ts

### F2 [Major] Lock budget spent on non-lock work
- Action: every advisory lock in one ordered statement (`$executeRaw`, the lock
  returns void); directory sync's transitions get a fresh deadline after the
  run's loops. Unit cell pins one statement in key order before the row lock.
- Modified file: src/lib/team/tenant-row-lock.ts, src/lib/directory-sync/engine.ts

### F3, F4, F5, F6 [Minor]
- Action: group routes pass `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`; the three actions
  join the personal Team filter; `departCreatedMembership` takes the batch; the
  ownerless list omits the actor unless they are tenant OWNER.

### T1, T2 [Major] Backfill
- Action: one fixture per arm (1 incl. cross-tenant and after-departure; 2a
  before/after; 2b before, uppercase-before, equal, after; 2c audit
  before/after/none); idempotency from the second run's NOTICE counts.
  Red-proved: case-sensitive 2b (R6), 2a without its time condition (R7).

### T3 [Major] Reverse-order race
- Action: replaced by a directory-sync engine cell (run vs an accept holding one
  of its rows, witnessed). It pins the outcome, not the lock order:
  pg_blocking_pids also lists waiters queued ahead, so a lock-order mutation is
  indistinguishable there (R8 stayed green). The one-call-before-team-lock rule
  is pinned by the gate's rule 4 (red-proven self-test). Recorded in the cell.

### T4 [Major] Missing A10 cells
- Action: added SCIM DELETE vs accept (both orders), departure vs team create,
  owner assign vs departure of the target and of the acting admin, invitation
  POST waiting on a departure, departure vs rotation. Red-proved: owner route
  without the tenant-row lock (R3, via the acting-admin cell), team create
  (R4), invitation POST (R5). Remaining two recorded as D6.

### T5 [Major] Rotation -> return -> confirm-key
- Action: real-DB cell (rotation excludes the departed member and resets
  `key_distributed`; absent from pending; after a return listed and confirm-key
  distributes v2). Red-proved (R2).

### T6 [Major] Engine lock timeout
- Action: engine cells for a suspension, the tenant-row timeout (run fails with
  the tenant-row error inside the deadline, sync log ERROR, nothing changed),
  and a rename of a suspended user (A3).

### T7, T9-T12
- Action: mixed-case replace-and-accept cell; EXPIRED asserted after every
  refusal plus a diverged-tenant refusal; positive audit row in A8; stamps
  compared as text with a post-departure invitation arm; `toBe(410)`.

### T8 [Major] Gate self-test
- Action: denies for a second write in the exempted function, the exempted
  shape in a sibling file, a partial caller, upsert-update, createMany and a raw
  key-table write; every deny asserts exit 1.

## Round 2

### Changes from Previous Round
Round 1's fixes (`f6ff42ac0`, `bb6f61fd4`) reviewed incrementally. S1/F1, F3-F6,
T1, T2 and T4-T12 resolved; F2 partly (F8); S2 incomplete (F9/S3/S5); T3
continuing (N1).

### Findings
- F8 [Major] (= S4) The one-statement advisory lock was bounded per lock only:
  `lock_timeout` applies to each acquisition, so N keys could wait N x budget
  and expire the transaction (P2028).
- F9 [Major] Members POST/PUT/DELETE re-checked the actor without locking the
  actor's tenant row, so a concurrent departure was not serialised.
- F10 [Minor] Advisory key order relied on the database collation; comment
  cited the JS sort.
- S3 [Minor] rotate-key and confirm-key decided the actor's authority before
  the transaction only.
- S5 [Minor] Re-checks covered departure but not team-level removal or
  demotion; DELETE did not pin the target's role; accept did not re-check the
  inviter.
- N1 [Minor] The old reverse-order cell still claimed "do not deadlock".
- N2 [Major] Directory sync's fresh transition budget had no test.
- N3 [Major] The batched `departCreatedMembership` was untested beyond one user.
- N4 [Minor] The A3 rename cell was vacuous if the first run did not stamp.
- N5 [Major] S2 unit tests pinned neither the lock ordering nor the actor scope.
- N6 [Minor] The acting-admin cell asserted no final state.
- N7 [Minor] The engine race cell parked the accept inside its 3 s lock budget.

### Recurring Issue Check
- Functionality: R3 (F9 — actor lock not carried to the members routes), R45/R53 analogue (F8). Others re-checked clean.
- Security: R3/R51 (S3, S5 — authority on a pre-transaction read); R43 boundary check of every round-1 fix: no widening.
- Testing: RT4 (N1), RT7 (N2, N3, N5), RT10 (N6 positive state). Others clean.

### Resolution Status
#### F8 / S4 [Major] Lock wait bounded as a whole
- Action: `withBoundedLockWait` sets `statement_timeout` with `lock_timeout`
  (`setWaitTimeouts` / `restoreWaitTimeouts` in tenant-rls-grants.ts) and maps
  57014 to the timeout error. Real-DB cell: two keys held 2 s then 4 s, taken
  in key order, refuse within the budget. Red-proved (Q1).
- Modified file: src/lib/team/team-key-rotation-lock.ts, src/lib/tenant-rls-grants.ts

#### F9, S3, S5 [Major/Minor] Actor authority under the lock
- Action: `activeTeamRole` (team-auth.ts) re-reads the actor's role under the
  transaction's locks. Members POST locks `[target, actor]`, PUT/DELETE lock the
  actor's row then the team (`lockActorThenTeam`), and each re-checks the role
  and the rank against the target; DELETE pins `role: target.role`. Invitation
  POST also takes the team lock; rotate-key and confirm-key re-check the actor
  (403); accept refuses (EXPIRED, 410) when the inviter is no longer a member
  entitled to invite. Real-DB cells: the actor's departure waits for each
  members route. Red-proved: Q2, Q3, Q5, Q6, Q7.
- Modified file: src/lib/auth/access/team-auth.ts, members/route.ts, members/[memberId]/route.ts,
  invitations/route.ts, invitations/accept/route.ts, rotate-key/route.ts, confirm-key/route.ts

#### F10 [Minor]
- Action: `ORDER BY k COLLATE "C"`; comment corrected.

#### N1-N7
- N1: the cell is renamed to what it asserts and points to gate rule 4.
- N2: engine unit cell — the transitions share a budget distinct from the
  row-lock one, created after the loops' last write. Red-proved (Q4).
- N3: engine unit cell (two users, one call); real-DB cells for a run creating
  two users deactivated and for the batch refusal stamping nothing.
- N4: the rename cell asserts the first run stamped and marked.
- N5: unit cells assert the actor read's where-clause and that it follows the
  team lock, plus a demotion refusal.
- N6: the acting-admin cell asserts the final owner state and the stamp.
- N7: the engine race parks the accept on the invitation row, outside its
  lock budget.
