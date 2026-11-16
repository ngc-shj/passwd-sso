# Plan Review: departed-member-db-invariants
Date: 2026-11-16
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening skipped (Ollama unavailable); merge done by hand.

## Functionality Findings

- **F-1 Major (design, R29/R24/R45).** The commit-time departure check filters `team_members` by
  `(tenant_id, user_id)`, which has no index (only `tenant_id` and `(team_id, user_id)`). Every
  departing user therefore scans the tenant's rows at COMMIT, which is O(N×M) in a directory-sync
  batch. → Resolved: C1 adds `team_members (tenant_id, user_id)` (schema mirror), and Phase 2
  records EXPLAIN evidence.
- **F-2 Minor (prose, R29).** "24 files" is truncated and not reproducible. → Resolved: C6 states the
  runnable command, and the member set is the failing set of the migrated suite run.
- **F-3 Minor (prose, R29).** "Departures keep key rows (`team-departure.ts` header)": the header
  does not say this. → Resolved: cite `endTeamMemberships` / `returnToTenant`.
- **F-4 Minor (design, R3/R42).** There is no file inventory, and the
  `tenant-departure-read.ts` mirror comment, the `team-departure.ts` header, the
  `rls-cross-tenant-verify.sql` header and `schema.prisma` are missing from it. → Resolved: the
  "Files" section.
- **F-5 Minor (question, R48).** Is the clock source of INSERT `created_at` the transaction start?
  If so, an admission that waited behind a SCIM DELETE plus re-create is judged born leftover and
  answered 500. → Accepted: the app's route gate already judges that row leftover
  (`actorDepartedSinceAdmission` over the same `created_at`). Refusing the write keeps the two
  adjudicators aligned, and the retry succeeds. Recorded in Considerations.
- **F-6 Minor (design, R48).** `advisoryKey()` lowercases only the user id. → Resolved: C2 lowercases
  the tenant id too and pins the key against the SQL spelling.
- **F-7 Minor (design, R55).** The role rank's `ELSE 0` is fail-open for an unknown role. →
  Resolved with S8: the map is explicit, an unknown role raises, and a `pg_enum` cell checks it.
- **F-8 Minor (prose, R49).** The runbook gives no operator consequences and no incident procedure. →
  Resolved: C8 runbook items.

## Security Findings

- **S1 Major (design, R49/R42).** End-then-reactivate launders a leftover row: re-activation stamps
  a fresh `admitted_at` while the tenant row is still departed. → Resolved: C1 refuses an activation
  while the user's tenant row is deactivated. The runbook re-admit script, the one legitimate
  writer of that state, disables the guard trigger inside its own transaction (owner-only, never
  visible to another session). SC2 is narrowed accordingly.
- **S2 Major (design, R42/R48).** The guard judges `NEW.tenant_id`, which nothing ties to the
  team's tenant. → Resolved: C1 refuses `tenant_id` ≠ `teams.tenant_id` on `team_members` and
  `team_member_keys`, and the bypass list gains `teams`.
- **S3 Major (design, R49).** The evidence is rewindable: `departed_at` lowered, `created_at` set in
  the future on INSERT. → Resolved:
  - C1 refuses a lowered `departed_at` and a lowered non-NULL `deactivated_at`;
  - C1 refuses an INSERT `created_at` later than `clock_timestamp()`.
  - A return (`→ NULL`) stays allowed: it restores authority by design.
- **S4 Major (design, R50).** The serialisation assumes READ COMMITTED without enforcing it. →
  Resolved: the lock branches raise unless `transaction_isolation = 'read committed'`, as
  `team_member_key_prune` does, with deny/allow cells.
- **S5 Major (design, R14/R49).** The claim that app roles cannot reach the replica bypass is not
  watched by the grants audit (no parameter-ACL class). → Resolved: `audit-db-grants.mjs` gains a
  `PARAMETER:` class over `pg_parameter_acl` (none expected), and an integration cell shows
  `passwd_app` cannot SET `session_replication_role`.
- **S6 Minor.** Pre-existing leftovers are not reported at migrate time. → Skipped as a migration
  NOTICE: `prisma migrate deploy` prints no server NOTICE (measured in `#1047`, plan C9). Instead,
  C8 has the runbook say to run its report (section 1) before deploying. Anti-Deferral: the worst
  case is a residue row that stays leftover, refused by every route gate since `#1057`, and that
  the report lists.
- **S7 Minor (question).** Key rows for an absent or inactive membership are no longer judged once
  rule 8 retires. → Answer: no route relied on rule 8 alone; every key writer route keeps its
  recipient check (confirm-key, rotate-key). Recorded as a residual in C1's control class.
- **S8 Minor (R55).** Unknown role ranks as VIEWER. → Resolved with F-7.
- **S9 Minor (R47).** No cell for `ON CONFLICT`, `MERGE` or `COPY`. → Resolved: C7 cells.
- **S10 Minor.** Restore into the table. → Resolved (documented): `pg_dump`/`pg_restore` create
  triggers in post-data, after the rows load; a data-only restore uses `--disable-triggers`. Stated
  in the runbook.

## Testing Findings

- **F1 Major (RT4/RT7).** The race witness proves only "blocked by something". → Resolved: reuse
  `race-helpers.ts`; witness the blocker pid, an ungranted `advisory` row in `pg_locks` and the
  waiting statement; assert SQLSTATE 23514 and the message prefix; assert pre-state; pin the
  isolation level; run both commit orders.
- **F2 Major (RT7/RT11).** Red-proofs by `CREATE OR REPLACE` on the shared worktree DB, and no
  per-clause matrix. → Resolved: red-proofs run on a scratch database (`CREATE DATABASE … TEMPLATE
  passwd_sso_wt_1060`), with the clause → mutation → expected-red table in C7.
- **F3 Major (RT10/R42).** Missing cells: `ON CONFLICT`/`MERGE`, the role-rank axis, the
  departure-record UPDATE, a restamp, other-user scope, cross-tenant scope, the equality pair,
  statement versus commit timing, and a trigger-order mutation. → Resolved: C7.
- **F4 Major (RT3/RT10).** Millisecond ties in clock-driven allow cells. → Resolved: explicit stamps
  at least 1 s apart in raw cells; app-driven cells assert the gap; the new file is run 20× in
  Phase 2.
- **F5 Major (RT5/RT8).** No behavioural cell for the bypass save and restore. → Resolved: C7 T6.
- **F6 Major (R50/R33).** pre-pr skips integration on `feat/` branches. → Resolved: the full suite is
  run by hand before and after the migration, judged by exit code with per-file counts compared.
  The pre-pr coverage claim is dropped.
- **F7 Major (R42/RT5).** The adopter set comes from a grep, and route-check cells may stop proving
  the route check. → Resolved: the adopters are the files the post-migration run refuses, and each
  route recipient check is red-proved again after the migration (scratch copy), expecting the cell
  red by status.
- **F8 Major (RT11).** The replica helper's reach is too wide. → Resolved: one statement per call,
  and a cell checks that `session_replication_role` is back to `origin` on both paths.
- **F9 Major (R50).** RLS verify is judged by the absence of an error. → Resolved: a scratch
  database is migrated and seed, coverage, verify and negative-test run as CI does, with exit codes
  recorded and a red-proof that removes the 10b allowlist entry.
- **F10 Major (RT7/R50).** The rule 8 retirement's positive cell can be vacuous. → Resolved: the
  harness drops `grants` / `EXEMPT_GRANTS` / the env var. The positive cell runs on an unchecked
  `teamMember.update({ data: { role } })` fixture, with its base-commit control red. Real-tree
  counts are compared before and after.
- **F11 Major (RT11).** Cleanup and open race transactions. → Resolved: cleanup is registered at
  acquisition; race clients ROLLBACK and end in `finally` with `lock_timeout` set.
- **F12 Minor.** Scenarios 3 and 5 and the no-deadlock claim have no cell. → Resolved: C7 cells.
- **F13 Minor.** The probe cell count is mislabelled. → Resolved: 19 deny/allow + 6 race + 1 seed.

## Adjacent Findings

- Testing A1 (admission clock differs by write path) → same as F-5.
- Testing A2 (`SET CONSTRAINTS IMMEDIATE`) → C7 cell, documented as expected refusal.
- Functionality A-1 (INSERT `created_at` writable) → S3.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
- R1 checked (key and rank re-spelled in SQL: F-6, F-7); R2 F-7; R3 F-4; R5 checked; R6 checked
  (cascades do not fire, F-8); R14 checked; R15 checked; R16 checked (VE3); R17 checked; R18
  checked; R22 checked; R24 F-1; R29 F-1, F-2, F-3; R31 checked; R34 checked; R36 checked; R38
  checked; R42 checked, F-2/F-4; R44 checked; R45 F-1; R48 F-5, F-6; R49 F-8; R50 checked; R52
  checked; R54 checked; R55 F-7. All other rules N/A.

### Security expert
- R3 no finding; R14 S5; R29 checked; R42 S1, S2, S3, S7; R47 S9; R48 S2; R49 S1, S3, S5, S6; R50
  S4; R54 no finding; R55 S8; RS1–RS6 N/A or no finding. All other rules N/A.

### Testing expert
- R1 F1 (race-helpers not cited); R3 F7; R16 F9; R17 F7; R19 F7; R21 Phase 2; R29 F13; R33 F6; R42
  F3, F7; R50 F6, F9, F10; RT1 OK; RT2 OK; RT3 F4; RT4 F1; RT5 F5, F7; RT7 F2, F10; RT8 F5; RT10 F3,
  F4, F12; RT11 F8, F11. All other rules N/A.

---

# Round 2
Date: 2026-11-16

## Changes from Previous Round

Revision 2 applied every round-1 finding (S1–S5, F-1, F-6–F-8, test matrix). Round 2 then found
three things:

- The new clauses refuse application paths: F2-1, F2-2, F2-3.
- The stamp ordering is still writer-chosen: N1, N2.
- The test design lacks mechanics: T-1–T-12.

Revision 3 answers them below.

## Functionality Findings

- **F2-1 Major.** Prisma fills `created_at` from the application clock, so an INSERT bound at
  `clock_timestamp()` refuses ordinary admissions under skew. → Resolved: the INSERT bound is
  dropped. It is not needed once I2 judges "departed now" (N1). F-5's text is corrected:
  `created_at` is the application clock at request start.
- **F2-2 Major.** The lowering guard on `tenant_members.deactivated_at` refuses
  `departCreatedMembership`'s restamp of an application-clock placeholder. → Resolved: that guard
  is dropped. A lowered stamp is a transition, and I2 judges it by "departed now". The record stamp
  guard stays, since its one writer uses the database clock. A T4 allow cell covers a future
  placeholder followed by the restamp.
- **F2-3 Major.** S1 turns invitation accept into a 500 for an invitee departed before the invite.
  → Resolved: C9 adds the condition to the route's existing `DEPARTED` arm.
- **F2-4 Minor.** The re-admit script's DISABLE needs `lock_timeout` and a position. → Resolved:
  C6.
- **F2-5 Minor (adjacent).** Seeds that UPDATE `created_at`. → Resolved: the C6 adopter class names
  them.

## Security Findings

- **N1 Major.** I2 depended on writer-chosen stamp order. A back-dated first stamp, or a stamp
  committed while an activation waited, escaped it. → Resolved: I2 refuses any active row of a user
  who is departed now; the leftover predicate applies only when the tenant row is active at commit.
- **N2 Major.** A DELETE of a departed tenant row erases the evidence. → Resolved: a BEFORE DELETE
  guard refuses it unless a record at or after the stamp exists. Cascades are skipped.
- **N3 Major.** INSERT `created_at` bound against clock skew. → Resolved with F2-1 (dropped).
- **N4 Minor.** Placement and `tgenabled` for the re-admit DISABLE; the incident procedure must be
  one transaction. → Resolved: C6, C8.
- **N5 Minor.** The parameter class must resolve effective privilege. → Resolved:
  `has_parameter_privilege` (SET and ALTER SYSTEM) plus `pg_db_role_setting`.
- **N6 Minor.** The S6, S7 and S10 dispositions lacked the Anti-Deferral format. → Resolved below,
  with S6 measured.
- **N7 Minor.** Close SC3 with an INSERT-time active-row check. → Accepted, entry in plan SC3. Teams
  POST nested creates and the RLS seed insert key rows before the member row, so it would need a
  deferred trigger, which costs more than 30 minutes.
- **N8 Minor.** The deadlock sentence was wrong: one raw departure writer suffices. → Resolved: Q1.
- **N9 Minor (question).** Error text as an oracle. → Resolved: messages carry only the written
  row's own ids and a fixed code.

### Anti-Deferral entries (round 1 S6, S7, S10)

#### S6 Minor — pre-existing leftovers not reported at migrate time — Accepted

- Anti-Deferral check: acceptable risk.
- Worst case: a residue row stays leftover. It is refused by every route gate since `#1057`, and it
  is listed by the runbook report's section 1.
- Likelihood: low. Measured read-only (plan Q2): dev `passwd_sso` 0 leftover; worktree 8, all test
  fixtures.
- Cost to fix: a NOTICE prints nothing under `prisma migrate deploy` (`#1047` C9, measured). A hard
  failure would block deploys over residue that the guard already contains.

#### S7 Minor — key rows for inactive or absent memberships — Accepted

- See plan SC3 (Anti-Deferral entry there).

#### S10 Minor — restore into the guarded tables — Accepted (documented)

- Anti-Deferral check: acceptable risk.
- Worst case: a data-only restore without `--disable-triggers` is refused.
- Likelihood: low. `pg_restore` creates triggers in post-data.
- Cost to fix: none needed. The runbook states the restore rule (C8).

## Testing Findings

- **T-1 Major.** The `origin` cell was dropped. → Resolved: C7 T6, plus a matrix row.
- **T-2 Major.** The scratch runner was unspecified. → Resolved: VE4 script.
- **T-3 Major.** A cluster-global parameter grant. → Resolved: a throwaway role, revoked and dropped
  in a trap, with the ACL row asserted gone.
- **T-4 Major.** No departure-side isolation cell. → Resolved: T4.
- **T-5 Major.** No S1 INSERT cell. → Resolved: T3.
- **T-6 Major.** The EXPLAIN evidence was vacuous. → Resolved: a catalog cell, plus a matrix row.
- **T-7 Major.** The `advisoryKey` premise was wrong, and the pin was a twin. → Resolved: C2 text;
  T5 takes the lock through the app helpers with upper-case ids.
- **T-8 Major.** No enum completeness cell. → Resolved: T1.
- **T-9 Major.** Matrix rows were inaccurate or missing. → Resolved: matrix rewritten.
- **T-10 Minor.** Allow cells were thin. → Resolved: T3 and T4 allows.
- **T-11 Minor.** The commands were not executable. → Resolved: C7 loop and JSON-report diff.
- **T-12 Minor (question).** → Resolved: an exported pure key builder, unit-tested.

## Recurring Issue Check (round 2)

### Functionality expert
- R3 F2-3; R5 F2-4; R42 F2-3; R48 F2-1, F2-2; R51 F2-4. Others no finding or N/A.

### Security expert
- R14 N5; R29 N8; R34 N6; R38 N3; R42 N1, N2, N7; R49 N1, N2, N4, N9; R54 verified; R55 N3; RS1–RS6
  N/A or no finding.

### Testing expert
- R14 T-3; R29 T-7; R48 T-7; R50 T-2, T-3, T-6, T-11; R55 T-8; RT4 T-9; RT7 T-1, T-2, T-4–T-6,
  T-9, T-12; RT9 T-7; RT10 T-4, T-5, T-8, T-10; RT11 T-1–T-3.

---

# Round 3
Date: 2026-11-16

## Changes from Previous Round

Revision 3 made I2 independent of stamp order. It dropped the INSERT `created_at` bound and the
tenant-row lowering guard, and added a departed-row DELETE guard, C9 and the parameter audit. Round 3
found the DELETE guard bypassable (return then delete) and in the way of the integration teardown,
and it found gaps in the test cells. Revision 4 drops the DELETE guard and names the class it
belonged to, "undoing a departure", which the database cannot judge. Revision 4 also adds arm
tokens and the missing cells.

## Functionality Findings

- **F3-1 Major.** The DELETE guard refuses `deleteTestData`, which deletes records first and then
  departed rows at depth 1. → Resolved: the guard is dropped (with N10).
- **F3-2 Minor.** The S1 wording against "departed now". → Resolved: the C1 activation arm reads
  the tenant row only, and a T3 allow cell covers a guest with a record and no row.
- **F3-3 Minor (adjacent).** `run-pr-379-test-plan.sh` deletes tenant rows. → Moot once the guard
  is dropped.

## Security Findings

- **N10 Major.** Return-then-delete defeats the DELETE guard. → Resolved: the guard is dropped.
  "Undoing a departure" (a return or a tenant-row DELETE) is named as a class the database does not
  judge and that stays with rule 2 and `tenantRowDeletes`. The claims in Q3, Q6 and scenario 2 are
  scoped to it.
- **N11 Minor.** The activation arm against record-only users. → Resolved: stated explicitly (a
  record without a row admits, SC2). The raw path N11 describes needs a tenant-row DELETE, which
  is in the undo class.
- **N12 Minor.** The grant arm uses the leftover predicate for departed-now users admitted after the
  stamp. → Accepted, recorded as a residual in C1:
  - Anti-Deferral check: acceptable risk.
  - Worst case: a grant to a row that only pre-migration residue or the re-admit script can produce.
  - Likelihood: low.
  - Cost to fix: refusing these grants would also refuse grants to operator-re-admitted members,
    whom the runbook restores by design.
- **N13 Minor.** The depth skip is untested, and its soundness rests on the app roles holding no
  TRIGGER privilege. → The skip is gone with the guard. The TRIGGER-privilege point stays in C1 and
  C4.
- **Question (R51).** `teams.tenant_id` can change under a bypass. → Recorded as SC6 and as a known
  bypass.
- **SC3 / N7.** The worst case and the cost justification are rewritten in plan SC3.

## Testing Findings

- **Q-1 Major.** The I2 not-departed-now arm had no deny cell. → Resolved: two T4 cells and a
  matrix row.
- **Q-2 Major.** The DELETE guard's cascade and boundary cells. → Moot (guard dropped). The teardown
  allow cell remains.
- **Q-3 Major.** Refusals could not be told apart. → Resolved: per-arm tokens, statement-time versus
  commit-time assertions, and a corrected trigger-order row.
- **Q-4 Major.** The audit override did not exist. → Resolved: a scratchpad copy with the throwaway
  role appended, three runs; no knob added.
- **Q-5 Minor.** Fixture preconditions. → Resolved in T3 and T4.
- **Q-6 Minor.** C9 post-state and source-mode red-proofs. → Resolved.

## Recurring Issue Check (round 3)

### Functionality expert
- R3 F3-1; R17 F3-2; R19 F3-1, F3-3; RT11 F3-1. Others no finding or N/A.

### Security expert
- R34 SC3 prose; R42 N11; R48 N11, N12; R49 N10, N13; R51 question; R54 verified; RT7 N13. RS1–RS6
  N/A.

### Testing expert
- R14 Q-4; R42 Q-1, Q-2; R49 Q-3, Q-4; RT3 Q-5; RT7 Q-1–Q-4, Q-6; RT8 Q-3; RT10 Q-1, Q-2.

---

# Round 4
Date: 2026-11-16

## Changes from Previous Round

Revision 4 dropped the DELETE guard, named the "undoing a departure" class, and added arm tokens
and cells. Round 4 found:

- functionality: no design finding;
- testing: missing red-proof rows (QA4-1–QA4-4);
- security: a tenant-row re-key that escapes the departure trigger (R4-1), an SC3 rationale that
  contradicted `returnToTenant` (R4-2), and format and scoping gaps (R4-3, R4-4).

Revision 5 applies all of them.

## Functionality Findings

- **N1 Minor (prose).** The stamp-and-return cell needs a record precondition. → Resolved: the T4
  cell and the Objective I2 note.

## Security Findings

- **R4-1 Major (design).** A raw `UPDATE tenant_members SET user_id = …` on a departed row moves
  the departure without firing I2. → Resolved: the UPDATE trigger fires on `deactivated_at`,
  `tenant_id` and `user_id`. A T4 cell and a matrix row are added.
- **R4-2 Major (prose).** SC3 claimed that a re-admission re-wraps, but `returnToTenant` restores
  keys unchanged. → Resolved:
  - the key trigger also refuses writing a key row for an **ended** membership (`key_inactive`),
    since no writer does so;
  - SC3 narrows to absent rows, with the corrected entry below.
- **R4-3 Minor (prose).**
  - The Objective is scoped to "except the known bypasses".
  - The residual enumeration names SC2 guests.
  - Rule 8 required the same leftover predicate (`actorDepartedSinceAdmission`), so retiring it
    drops no check.
- **R4-4 Minor (prose).** The entries below are in the mandatory format, with sign-off.

## Testing Findings

- **QA4-1 / QA4-2 / QA4-3 Major/Minor (design).** Missing red-proof rows for `activation_leftover`,
  `key_leftover` and `unknown_role`. → Resolved: matrix rows.
- **QA4-4 Minor (prose).** The `created_at` deny's pair. → Resolved: an UPDATE of `created_at` to
  its own value.

## Anti-Deferral entries (current)

### N12 Minor Grant to a departed-now user's row admitted after the departure — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a role raise or key grant to a row whose user is departed now but who was admitted
    after the departure. That covers pre-migration residue, a re-admit-script row, and an SC2 guest
    with a record and no row.
  - Likelihood: low. No application writer produces the first two. Every grant route already
    applies this exact predicate, so the database adds no new acceptance.
  - Cost to fix: refusing these grants also refuses grants to members the runbook re-admits by
    design, and to SC2 guests the app admits.
- **Orchestrator sign-off**: accepted. The database matches the routes' adjudicator, and the
  stronger rule contradicts two documented legitimate states.

### SC3 Minor Key row for an absent membership — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a raw writer inserts a key row for a user with no `team_members` row in that team,
    or races `deactivateScimUser`'s delete. If the user is later admitted fresh, the key row is
    already present.
  - Likelihood: low. A fresh admission starts with `key_distributed = false`, and admin browsers
    redistribute the current key through confirm-key, whose upsert overwrites the row. Rotation
    covers only active key holders.
  - Cost to fix: a foreign key `(team_id, user_id)` → `team_members`, with these parts:
    - a Prisma relation (for `check-migration-drift`);
    - `NOT VALID` or an orphan cleanup;
    - reordering the RLS seed and the test seeds that insert keys first.

    That is more than 30 minutes and a change to the Prisma client surface.
- **Orchestrator sign-off**: accepted. Ended rows, the case `returnToTenant` revives, are now
  refused (`key_inactive`).

### SC6 Minor Team re-homing (`teams.tenant_id` change) — Accepted
- **Anti-Deferral check**: out of scope (different feature)
- **Justification**:
  - Worst case: a raw re-home under a bypass leaves member rows keyed to the old tenant. I2 then no
    longer sees them for the new tenant's departures. Every later guarded write to those rows,
    including an ending, refuses with `tenant_mismatch` until the rows are re-keyed.
  - Likelihood: low. No code changes `teams.tenant_id`.
  - Cost to fix: making `teams.tenant_id` immutable is a team-model invariant of its own.
    - Recovery: the owner re-keys the member rows in one transaction.
    - The wedge is fail-closed and already exists today through `trg_enforce_tenant_id_team_members`.
- **Orchestrator sign-off**: accepted. It is fail-closed and needs no application change.

### S6 Minor Pre-existing leftovers at migrate time — Accepted (provisional pending target measurement)
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: residue rows stay leftover. They are refused by every route gate since `#1057`, and
    after this migration by the database too.
  - Likelihood: measured 0 on dev `passwd_sso`. The worktree's 8 rows are test fixtures. The target
    deployment is measured by the operator's runbook report, section 1, which C8 requires before
    deploying.
  - Cost to fix: a migrate-time NOTICE is not printed by `prisma migrate deploy`.
- **Orchestrator sign-off**: accepted. The measurement on the target is the runbook step.

---

# Round 5
Date: 2026-11-16

## Changes from Previous Round

Revision 5 applied round 4 (re-key firing, `key_inactive`, SC3 narrowing, Anti-Deferral format,
matrix rows). Round 5 returned no design finding from functionality or security, and three Minor
cell-pairing items from testing.

## Findings

- Functionality **F5-1 Minor (prose).** The sentinel runbook's raw stamp is refused when the member
  holds team rows. → Resolved: C8 note.
- Security **R5-1 Minor (prose).** Q6 still listed inactive key rows. → Resolved.
- Testing:
  - **QA5-1 Minor (design).** The re-key deny lacked a pair and a `tenant_id` cell. → Resolved: T4
    pair cells and a split matrix row.
  - **QA5-2 Minor (design).** The stamp-and-return deny lacked its not-leftover pair. → Resolved.
  - **QA5-3 Minor (prose).** The T2 ended-member fixture must not be leftover, and the check order
    must be stated. → Resolved.

---

# Round 6 (final)
Date: 2026-11-16

## Findings

- Functionality **F6-1 Minor (prose).** The header stamp is stale. → Resolved: revision 6.
- Security **P6-1 Minor (prose, R49).** The control-class sentence overreached. → Resolved: it is
  scoped to writes reaching the triggers, apart from the listed bypasses and residuals, and the
  Objective cites both.
- Testing **QA6-1 Minor (design).** No red-proof row for `grant_leftover`. → Resolved: the row was
  added.

## Exit

No Critical or Major finding was raised in rounds 5 or 6, and every finding of every round is
resolved in the plan or carries an Anti-Deferral entry above (N12, SC3, SC6, S6, S10). The plan
reached this state after six rounds; the remaining open set is empty.
