# Plan Review: leftover-team-actor-authority
Date: 2026-11-15
Review round: 1

## Changes from Previous Round
Initial review of plan Revision 1. Local LLM pre-screening skipped (Ollama unavailable).

## Functionality Findings
- **FN-F1 Major (design)** — C1 widens the #1043-C2 residual to every route, and the runbook's
  remove-and-re-invite recovery runs member DELETE, which deletes the member's `team_member_keys`;
  a team whose holders are all residual loses its data. → **Resolved**: C8 (in-place re-admission
  keeping the key), C6 rewording, C1 residual paragraph.
- **FN-F2 Minor (design)** — C3/C4 re-implement `readTenantRows`; worker columns depend on reuse. →
  **Resolved**: C3 moves `readTenantRows` + predicates to `tenant-departure-read.ts`, reused by C3/C4;
  C4 grants derived from the issued statements.
- **FN-F3 Minor (design)** — webhooks GET has no `tenantId` for the new signature. → **Resolved** (C4).
- **FN-F4 Minor (prose)** — 58 handlers, not 59; backup-db count. → **Resolved**: 58 with command;
  239 kept with the `vitest run` command that prints it (`vitest list` reports 220 because it counts
  differently — the plan cites the run output).
- **FN-F5 Minor (prose)** — `member-key` unclassified; layout uses `notFound()`; "pre-C2" ambiguous.
  → **Resolved**.

## Security Findings
- **SEC-F1 Major (design)** — the departure-record side fails open silently when a bypass grant omits
  `tenantMemberDeparture`; acceptance seeded only the deactivated-row side. → **Resolved**: both seeds
  (`residueDepart`, `recreatedDepart`) for C1/C3/C4; C3 grant-coverage unit test.
- **SEC-F2 Minor (design)** — worker column grant includes unneeded `id`. → **Resolved**: C4 grants
  exactly the issued columns, established by running the worker cell; generated SQL recorded.
  The SECURITY INVOKER function alternative was not adopted: it adds a third SQL copy of the predicate.
- **SEC-F3 Minor (design)** — widened residual can wedge a team (sole residual OWNER). Converges with
  FN-F1 → floor Major. → **Resolved** by C8.
- **SEC-F4 Minor (design)** — `teamKeyVersionHolders` counts leftovers (rekeyer naming, restore
  availability). → **Resolved**: added to C3.
- **SEC-F5 Minor (prose)** — 58 handlers. → **Resolved** (converges with FN-F4, TEST-F6).
- **SEC-F6 Minor (prose)** — "unlocked by design" overstated. → **Resolved**: C1 states the
  request-bounded non-leftover race explicitly.
- **SEC-F7 Minor (design)** — C1 reach over future routes is an ungated convention. → **Resolved**:
  C5 is now a per-handler reach test.
- **SEC-F8 Minor (prose)** — keep the tenant-row-deletion limit in C6. → **Resolved** (Background, C6).

## Testing Findings
- **TEST-F1 Critical (design)** — C2 real-DB deny cells cannot reach C2 under C1. → **Resolved**:
  post-gate injection through the step-up mock (member DELETE) and `withTeamIpRestriction` mock
  (reject, bulk reject, cancel); separate C1 404 cells.
- **TEST-F2 Major (design)** — six #1043 actor-deny cells flip 403→404. → **Resolved**: converted to
  the same injection (C2 acceptance).
- **TEST-F3 Major (design)** — C1 real DB lacked the departure-record seed and real allow axes. →
  **Resolved** (C1 acceptance).
- **TEST-F4 Major (design)** — C3 pair matching and admission-anchor cells missing. → **Resolved** (C3,
  C4 acceptance).
- **TEST-F5 Major (design)** — cancel's cross-team guard moves into `deleteMany`; mocked cell vacuous.
  → **Resolved**: argument assertion + real-DB cross-team cell.
- **TEST-F6 Minor (prose)** — 58 handlers. → **Resolved**.
- **TEST-F7 Minor (prose)** — R19 list mis-aimed. → **Resolved**: Testing strategy lists the measured set.
- **TEST-F8 Minor (design)** — `assertRlsApplies`. → **Resolved**.
- **TEST-F9 Minor (design)** — C7 verification must not stop the shared db; prove the fallback taken.
  → **Resolved** (`DOCKER_HOST` override; printed directory asserted).
- **TEST-F10 Minor (design)** — import safety unpinned. → **Resolved** (C4 import cell + forbidden pattern).
- **TEST-F11 Minor (design)** — member DELETE deny must assert sessions untouched. → **Resolved**.

## Adjacent Findings
- **SEC-F9 Minor [Adjacent]** — invitation cancel writes no audit row. The file is changed by C2, so
  in scope (Anti-Deferral rule 1). → **Resolved**: `TEAM_MEMBER_INVITE_CANCEL` in C2.
- **SEC-F10 Minor [Adjacent]** — team-share creators read access logs without a membership check.

### SEC-F10 Minor Team-share creator access-log reads — Out of scope
- **Anti-Deferral check**: out of scope (different feature).
- **Justification**: the authority comes from `share_links.created_by_id`, not a `team_members` row,
  so it is not a member of this plan's class (leftover membership). It is a departed-member foothold
  of the kind `#1032` tracks; C6 posts it there.
- **Orchestrator sign-off**: tracked by `#1032` (comment added in C6).

## Quality Warnings
None (merge done manually; Ollama unavailable).

## Additional orchestrator observations (pre-pr in the worktree)
`PRE_PR_FORCE_FULL=1 bash scripts/pre-pr.sh` in the worktree: Passed 89, Failed 3 — `Test` (backup-db
Group B, 6 cases), `CLI: deps missing`, `Extension: deps missing`. Recorded in C7; the deps were
installed with `npm ci`.

## Recurring Issue Check
### Functionality expert
R1 FN-F2 · R2 ok · R3 ok (both reject routes via `rejectScimPending`) · R4 N/A · R5 ok · R6 FN-F1 ·
R7–R9 N/A · R10 ok · R11–R13 N/A · R14 FN-F2 · R15 ok · R16 ok (C7) · R17 ok · R18 ok · R19 ok ·
R20–R21 N/A · R22 ok (premise reversal explicit) · R23 N/A · R24 ok · R25–R28 N/A · R29 FN-F4 ·
R30 N/A · R31 FN-F1 · R32–R33 N/A · R34 ok · R35–R39 N/A · R40 ok · R41 N/A · R42 FN-F5 · R43–R46 N/A ·
R47 ok · R48 FN-F2 · R49 ok · R50 ok · R51 N/A · R52 FN-F1 · R53–R57 N/A

### Security expert
R1 drift risk (SEC-F1) · R2–R3 ok · R4 ok (C4) · R5 ok · R6–R13 N/A · R14 SEC-F2 · R15–R16 N/A ·
R17 SEC-F4 · R18 SEC-F1 · R19 ok · R20–R21 N/A · R22 SEC-F4 · R23–R24 N/A · R25 SEC-F1 · R26–R28 N/A ·
R29 SEC-F5 · R30–R33 N/A · R34 SEC-F9/F10 · R35–R37 N/A · R38 SEC-F3 · R39 N/A · R40 ok · R41 N/A ·
R42 SEC-F4 · R43 bounded (SEC-F2) · R44–R45 N/A · R46 ok · R47 ok · R48 SEC-F1/F2 · R49 SEC-F6/F7/F8 ·
R50 SEC-F1 · R51 N/A · R52 SEC-F1 · R53 N/A · R54 ok · R55–R57 N/A · RS1 N/A · RS2 no new routes ·
RS3–RS6 N/A

### Testing expert
R1–R2 N/A · R3 TEST-F4 · R4 N/A · R5 TEST-F5 · R6 ok · R7–R13 N/A · R14 confirm exact sets in Phase 2 ·
R15 N/A · R16 TEST-F9 · R17 N/A · R18 TEST-F8 · R19 TEST-F7/F2 · R20–R28 N/A · R29 TEST-F6 · R30 N/A ·
R31 TEST-F9 · R32–R33 N/A · R34 ok · R35–R41 N/A · R42 ok · R43 ok · R44–R46 N/A · R47 ok · R48 ok ·
R49 ok · R50 TEST-F9 · R51 N/A · R52 TEST-F3 · R53–R57 N/A · RT1 TEST-F5 · RT2 ok · RT3 ok · RT4 N/A ·
RT5 TEST-F3/F8 · RT6 ok · RT7 TEST-F1/F2 · RT8 TEST-F1/F5/F11 · RT9 N/A · RT10 TEST-F3/F4 · RT11 ok

---

# Round 2
Date: 2026-11-15
Review round: 2 (incremental, on Revision 2)

## Changes from Previous Round
Revision 2 applied every round-1 finding: 58 handlers, C5 reach test, C1 residual/race wording, C2
post-gate injection + cancel audit, C3 shared pure reader + key holders, C4 grants from issued SQL,
C7 measured, new C8 operator re-admission.

## Functionality Findings
- **FN-R2-F1 Major (design)** — excluding leftovers from `teamKeyVersionHolders` drops the rekey
  report's `deactivatedHolder` warning on the UNRECOVERABLE delete exit. Converges with SEC-N2. →
  **Resolved**: C3 counts leftover holders in the renamed `inactiveTeamKeyVersionHolderCount`;
  walkthrough over `holderInputsFrom`; `tenantId` ripple and restore's `(tenantId, tx)` form stated.
- **FN-R2-F2 Minor (design)** — cancel audit `{ email, role }` had no source. Converges with SEC-N5. →
  **Resolved**: in-tx `findFirst({ id, teamId })` after the locks.
- **FN-R2-F3 Minor (design)** — C8 should accept departure-record-only leftovers; advisory lock
  omitted. → **Advisory lock resolved** (converges with SEC-N3). **First half rejected** in favour of
  SEC-N1: `deactivateScimUser` deletes team rows in the transaction that writes the departure record,
  so an active row older than the record is a provable leak, not a residual; its end is `contain` or
  member DELETE, where losing the key is intended.
- **FN-R2-F4 Minor (design)** — C5 would trip on `export const runtime`. → **Resolved**: handler and
  route-segment-config definitions in C5.

## Security Findings
- **SEC-N1 Major (design)** — C8's qualifier re-admits provable leaks. → **Resolved**: C8 restricted to
  the residual class (`admitted_at IS NULL`, tenant-row-deactivation-driven, no departure record at or
  after `created_at`); refusal cells; audit metadata records the inputs.
- **SEC-N2 Minor** — converges with FN-R2-F1 → floor Major; resolved there.
- **SEC-N3 Minor** — advisory lock first. → **Resolved**.
- **SEC-N4 Minor** — grant-coverage test anchored to a hand-written list. → **Resolved by removal**: the
  premise was false (TEST-R2-F2); a missing grant raises 42501.
- **SEC-N5 Minor (prose)** — converges with FN-R2-F2; resolved.

## Testing Findings
- **TEST-R2-F1 Major (design)** — C8 acceptance thinner than the `contain` matrix. → **Resolved**: the
  matrix is carried over, with parity against C8's residual class (not C1's full class, per SEC-N1).
- **TEST-R2-F2 Minor (prose)** — the "silent fail-open" rationale is false since
  `20261114000500_rls_bypass_enforce` (verified: the migration raises 42501
  `RLS_BYPASS_NOT_GRANTED`). → **Resolved**: C3 rewritten; grant-list unit test dropped.
  Round-1 SEC-F1's both-seed cells stay: they cover the departure side of the predicate.
- **TEST-R2-F3 Minor (design)** — injection hook behaviour. → **Resolved** (pass-through default,
  one-shot, `afterEach`).
- **TEST-R2-F4 Minor (design)** — literal counts in C5. → **Resolved**: `fs` walk, non-empty floor,
  no literal counts.
- **TEST-R2-F5 Minor (design)** — holder cells need mutation assertions and twins. → **Resolved**.

## Recurring Issue Check (round 2)
### Functionality expert
R3 FN-R2-F1 · R5 ok · R6 ok · R10 ok · R12 ok · R14 ok · R16 ok · R18 ok · R19 ok · R24 ok · R29 ok ·
R31 FN-R2-F1 · R34 ok · R40 FN-R2-F1 · R42 ok (58/58 by AST) · R47 ok · R48 FN-R2-F3 · R49 ok · R50 ok ·
R52 FN-R2-F1 · R54 ok · all others N/A
### Security expert
R1 ok · R4 ok · R9 ok · R10 ok · R12 ok · R14 ok · R18 SEC-N4 · R22 SEC-N2 · R24 ok · R25 SEC-N4 ·
R29 ok · R31 SEC-N2 · R38 ok (C8) · R42 SEC-N4 · R43 SEC-N1 · R46 ok · R47 ok · R48 SEC-N1 · R49 ok ·
R52 SEC-N2 · R54 ok · RS2 no new routes · all others N/A
### Testing expert
R1 ok · R3 ok · R5 ok · R6 ok · R10 ok · R12 ok · R14 ok · R16 ok · R18 TEST-R2-F2 · R19 ok · R29
TEST-R2-F2 · R31 ok · R42 TEST-R2-F2 · R43 ok · R47 ok · R48 TEST-R2-F1 · R49 ok · R50 ok · R53
TEST-R2-F4 · R54 TEST-R2-F1 · RT1 ok · RT2 ok · RT3 ok · RT5 ok · RT6 ok · RT7 TEST-R2-F1 · RT8
TEST-R2-F1/F5 · RT10 TEST-R2-F1/F5 · RT11 TEST-R2-F3 · all others N/A

---

# Round 3
Date: 2026-11-15
Review round: 3 (incremental, on Revision 3)

## Changes from Previous Round
Revision 3 applied round 2: cancel in-tx read, hook spec, inactive holder count, loud-failure
rationale, C5 fs walk and export definitions, C8 residual class with advisory lock and the contain
matrix.

## Functionality Findings
No findings. Confirmed the C8 narrowing against `deactivateScimUser`'s git history (team rows deleted
in the same transaction since 6372bded3; seeded departure records lag the delete by seconds).

## Security Findings
- **SEC-R3-1 Minor (design)** — C8 still admits untouched pre-`20261101` residue; add
  `tm.updated_at > tmb.deactivated_at` (necessary, not sufficient). Verified `TeamMember.updatedAt` is
  `@updatedAt`. → **Resolved** (C8 qualifier, refusal cell, caveat).
- Confirmed the loud-failure premise for every C3/C4 bypass path (`withBypassRls`, worker
  `setBypassGucs`), including enforcement switched off (table admitted, not hidden).

## Testing Findings
- **TEST-R3-F1 Minor (design)** — C8 lacks boundary cells for its comparisons. → **Resolved** (three
  boundary cells).

## Recurring Issue Check (round 3)
### Functionality expert
All R1–R57: N/A or checked ok (R3, R5, R6, R14, R29, R31, R40, R42, R43, R48 explicitly checked).
### Security expert
All R1–R57, RS1–RS6: N/A or ok, except R43 SEC-R3-1. R18/R25 ok (N4 premise verified).
### Testing expert
All R1–R57, RS*, RT1–RT11: N/A or ok, except R48 / RT10 TEST-R3-F1.

---

# Round 4
Date: 2026-11-15
Review round: 4 (incremental, C8 only, on Revision 4)

## Changes from Previous Round
C8 gained `tm.updated_at > tmb.deactivated_at` (necessary, not sufficient) and three boundary cells.

## Functionality Findings
No findings. Every re-activation writer in history stamps `updated_at` (Prisma `@updatedAt` on
accept, members POST, approve, SCIM group writes; `returnToTenant`'s raw UPDATE sets
`updated_at = clock_timestamp()` and clears the tenant row, so its rows never reach C8). No raw
migration UPDATE re-activates a row.

## Security Findings
No findings. Wording nit "(if any)" on the tenant-row lock fixed ("it must exist").

## Testing Findings
- **TEST-R4-F1 Minor (design)** — seeds insert `updated_at = now()` before the departure, so the
  baseline would fail the new condition; pin `>` with an equality cell. → **Resolved** (C8
  acceptance: raw `UPDATE … SET updated_at` after the departure; equality refusal cell).

## Recurring Issue Check (round 4)
All three experts: unchanged from round 3 except R42/R48 checked ok (functionality), R43 resolved
(security), R48/RT7/RT10 TEST-R4-F1 (testing).

---

# Round 5
Date: 2026-11-15
Review round: 5 (confirmation of TEST-R4-F1)

Testing: No findings. Functionality and Security returned No findings in round 4 on the same revision
(the round-5 change touched only C8's acceptance text the testing reviewer raised).

**Loop terminated: all three experts returned "No findings".** All contracts C1–C8 locked.
