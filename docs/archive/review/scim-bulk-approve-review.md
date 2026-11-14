# Plan Review: scim-bulk-approve

Date: 2026-11-14T05:37:05Z
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening and merge were unavailable (Ollama down); findings were
deduplicated by hand from the experts' json indexes. `design` / `prose` labels are the experts'.

Convergent findings (≥ 2 perspectives, floor Major): **S1 + F3 + T10** (module boundary and the
two unenforced forbidden patterns); **S7 + F2 + T7** (memberId case); **S7 + F6 + T6** (cap
measurement); **T1 + F8-A** (fail-closed gate). S4 + T9 touch the #1035 obligation.

## Functionality Findings

- F1 Minor (design) — Reject audit `role` source unspecified (reject/route.ts:131 uses the locked
  row's role). **Resolved**: C1/V5, U1.
- F2 Minor (design) — `memberId` case and duplicate detection unspecified. **Resolved**: C2
  (schema lowercases, uniqueness on that form), U2/U3.
- F3 Minor (design) — Forbidden patterns 2 and 3 have no enforcement (R49). **Resolved** with
  S1: C1/V7(c)(d) in gate rule 7.
- F4 Minor (prose) — the route-policy manifest is hand-edited; only the matrix is generated.
  **Resolved**: C7 table.
- F5 Minor (design) — `docs/security/step-up-reauth-routes.md` lists gated team routes and misses
  the single approve/reject already (R34). **Resolved**: C7 adds all four.
- F6 Minor (design) — cap measured on the dev DB only; per-row statement shape and the
  `logAuditBulkInTx` trade-off unstated. **Resolved**: Technical approach states the per-row
  shape and why; C6 adds a statement-count bound.
- F7 Minor (design) — retry payload, N = 0 button state, all-`not_found` message. **Resolved**: C5.

## Security Findings

- S1 Major (design) — nothing ties the module's callers to step-up and the limiter; two forbidden
  patterns unenforced (R42, R49). **Resolved**: C1/V7(b)–(d): importer allowlist of four route
  files, each under the step-up client-coverage gate; gate self-tests per clause (AC3).
- S2 Major (design) — the bulk pre-read was not filtered to pending rows, so any member id put
  that user's advisory lock in the transaction (100× amplification of lock holding).
  **Resolved**: C2 pre-read filters `scimApprovalPending: true`; cell B5c.
- S3 Major (design) — "approve all" puts up to 100 accounts, ADMIN rows included, behind a
  count-only dialog. **Resolved by option (b)**: C5's dialog states per-role counts with the
  ADMIN count called out; B1 pins an ADMIN row's outcome. Option (a), a server-side refusal of
  ADMIN rows in bulk, is recorded in Considerations for the user's decision (it changes the
  issue's "same per-row checks").
- S4 Major (design) — the #1035 rebase note left a fail-open window (a departed actor could
  bulk-approve) that no gate catches. **Resolved**: C8 tripwire test, loud in either merge order;
  N3; Go/No-Go row.
- S5 Minor (design) — a per-request limiter makes "no new authority" stale. **Resolved**: N1
  reworded; bulk limiters 10/hour with the reasoning in C2.
- S6 Minor (design) — no batch correlation in audit rows. **Resolved**: `batchId` (C1/V5, C2).
- S7 Minor (design) — case-sensitive uniqueness; C6 timing without latency. **Resolved**: C2, C6.
- S8-A Minor (adjacent → Testing) — once S2 lands, assert no lock is taken for non-pending ids.
  **Resolved**: B5c.

No Critical finding; no escalation requested, and none judged warranted by the orchestrator (S4
would be Critical only if both branches merged without the check, which C8 turns into a red CI).

## Testing Findings

- T1 Major (design) — C7 missed `EXPECTED_LIMITER_COUNT` 75 → 77 and the Redis-down contract test
  per new limiter. **Resolved**: C7, U2.
- T2 Major (design) — AC1 forces a per-target statement shape; unacknowledged. **Resolved**:
  option (a), stated in Technical approach; C6 measures that shape.
- T3 Major (design) — the two-team overlap cell was vacuous. **Resolved**: B6 forces the
  interleaving; red-proof by reversing the lock order.
- T4 Major (design) — the SCIM race cell expected a disjunction and contradicted F3.
  **Resolved**: B5a / B5b.
- T5 Major (design) — the one-transaction decision was pinned by no test. **Resolved**: U1
  (propagation), B8.
- T6 Major (design) — C6 had no procedure and an unreasoned threshold. **Resolved**: C6.
- T7 Major (design) — missing cells: role mapping by id, case-variant duplicates, empty pre-read,
  denial ordering, cross-team bulk-reject, bounds. **Resolved**: U2, U3, B1, B3.
- T8 Major (design) — no red-proof plan. **Resolved**: Testing strategy, red-proofs.
- T9 Minor (design) — acceptance only for C1; precedence and the #1035 case untested.
  **Resolved**: per-contract acceptance lines, U1, C8.
- T10 Minor (design) — see S1.
- T11 Minor (design) — rule-7 tests bound to the approve path and message. **Resolved**: AC3.
- T12 Minor (design) — the new integration file needs helpers private to the existing one.
  **Resolved differently from the recommendation**: the new file carries its own copy of the
  helpers it needs rather than extracting them, so the existing file stays untouched (AC2 literal;
  no conflict with other branches). 100-row seeding by one statement adopted (C6).
- T13 Minor (design) — the page test's AlertDialog mock always renders. **Resolved**: U4 asserts
  on fetch calls before confirm and after cancel.
- T14 Minor (prose) — id collisions. **Resolved**: invariants V1–V7, acceptance AC1–AC3,
  integration cells B1–B8.

## Adjacent Findings

- S8-A → Testing: resolved by B5c.
- F8-A → Testing: same as T1.

## Quality Warnings

None raised (merge-findings quality gate did not run; each finding above carries file:line
evidence in the expert's output).

## Recurring Issue Check

### Functionality expert

- R1 Checked (shared audit helpers considered, F6); R2 Checked; R3 Checked; R5 Checked; R7
  Checked (no e2e selector on the members page); R8 Checked (F7); R9 Checked; R10 Checked; R17
  Checked (F6); R18 Checked (rule 7 allowlist moves); R19 Checked (mock alignment analysed for
  AC1); R26 Checked (F7b); R27 Checked; R29 Checked (21/7 verified by running the gate; probe
  record carries its command); R34 Finding F5; R35 Checked; R36 Checked; R37 Checked; R40
  Checked; R42 Checked (C7 set recomputed; one extra, F5); R48 Checked; R49 Finding F3; R50
  Checked; R51 Checked; R52 Checked (F6); R53 Finding F6; R57 N/A (F2 on case).
- N/A: R4, R6, R11–R16, R20–R25, R28, R30–R33, R38, R39, R41, R43–R47, R54–R56.

### Security expert

- R1 Checked; R2 Checked; R3 Checked (S1); R4 Checked; R5 Checked; R8 Checked; R9 Checked; R10
  Checked; R12 Checked (S6 is metadata only); R17 Checked; R18 Checked; R19 Adjacent (S8-A); R22
  Checked; R29 Checked (21/7 reproduced; the 30/hour rationale is S5); R31 Checked; R36 Checked;
  R40 Checked; R42 Findings S1, S2; R43 Finding S4; R44 Checked; R48 Checked; R49 Finding S1; R50
  Checked; R51 Checked; R52 Findings S4, S5; R53 Finding S7; R57 N/A (see S7).
- N/A: R6, R7, R11, R13–R16, R20, R21, R23–R28, R30, R32–R35, R37–R39, R41, R45–R47, R54–R56.
- RS1 N/A; RS2 Checked (S5 on weighting); RS3 Checked (S7); RS4 N/A; RS5 N/A; RS6 N/A.
- The expert noted the R1–R57 table text was too large to read in one call and worked from the
  output template's ids plus the RS rows.

### Testing expert

- R1 Checked; R2 Checked (B7 imports the cap, T6); R3 Checked (T1); R5 Checked (T5); R8 Checked;
  R9 Checked; R10 Checked; R17 Checked; R18 Checked (T11); R19 Checked (T2); R27 Checked (T13);
  R29 Checked (T6; 21/7 re-derived by execution); R33 Checked (CI path filters cover the new
  paths); R35 Checked; R36 Checked; R40 Checked (T7); R42 Checked (T1, T10); R44 Checked; R48
  Checked; R49 Checked (T10); R50 Checked (T6); R53 Checked (T6).
- N/A: R4, R6, R7, R11–R16, R20–R26, R28, R30–R32, R34, R37–R39, R41, R43, R45–R47, R51, R52,
  R54–R57.
- RT1 T2, T7; RT2 T12, T4 (B4/B2/B3 confirmed buildable); RT3 Checked; RT4 T3, T4; RT5 Checked;
  RT6 Checked; RT7 T3, T8; RT8 T1, T7, T13; RT9 N/A; RT10 T7, T4, T11; RT11 Checked (T12 on
  seeding cost).

---

# Round 2

Date: 2026-11-14
Review round: 2 (incremental; same three experts, resumed)

## Changes from Previous Round

The plan was rewritten to resolve round 1: module boundary gate (V7), pending-filtered pre-read,
C8 tripwire, 10/hour limiters, `batchId`, C6 two-part criterion, renamed ids. Every round-1
finding was verified resolved by its expert (S1 "partly", continued as S9; S3 judged adequately
closed by option (b)). No finding in this round is against the original design; all are against
text round 1 added.

## Functionality Findings

- F9 (new in round 2) Minor (design) — V7(d) was a two-name denylist; `logAuditAsyncBothScopes`,
  `enqueueAudit`, `enqueueAuditBulk` are emitters too (R42). **Resolved**: V7(d) is an import
  allowlist.
- F10 (new in round 2) Minor (design) — no mechanism for the statement count; 3 ms unsourced.
  **Resolved** with T15: C6.
- F11 (new in round 2) Minor (design) — the module test's `tenant-row-lock` mock must spread
  `importOriginal()`. **Resolved**: C8.
- F12 (new in round 2) Minor (prose) — V7(b) specifier resolution unspecified. **Resolved** with
  T16: V7(b), AC3.

## Security Findings

- S9 (new in round 2) Minor (design) — V7(b)'s "under the step-up gate" claimed more than the
  textual gate enforces (R49). **Resolved** by stating exactly what is gate-enforced and what is
  unit-test-enforced. The optional AST ordering check was not added: Skipped — worst case: a later
  edit leaves step-up unreachable in one of four routes and the route's unit tests (which assert
  the step-up refusal and no transaction) fail; likelihood: low (those tests exist for all four);
  cost to fix: a control-flow check in an AST gate, the kind of gate growth that has seeded its
  own defects in this repository.
- S10 (new in round 2) Minor (design) — tripwire holes: where the test runs, name-only trigger,
  mock spread, fixture shape, NULL `admittedAt` case, hand-over. **Resolved**: C8 (second signal
  from the schema, `runIf` split, fixtures, the NULL case, PR-body obligation, reworded claim).
- S11 (new in round 2) Minor (prose) — dialog rationale overstated (the key is distributed
  separately); N1 arithmetic. **Resolved**: C5, N1.

## Testing Findings

- T15 (new in round 2) Major (design) — the statement count could not come from a Prisma query
  log; 3 ms unsourced; B7 must reseed per run. **Resolved**: C6 (`pg` client spy in B7, reseed per
  run, 10-row control, 3 ms declared an assumption under VE3). Convergent with F10.
- T16 (new in round 2) Major (design) — V7(b)/(c) self-tests need surface-form fixtures (R47) and
  a defined answer for missing files. **Resolved**: V7(b), AC3. Convergent with F12.
- T17 (new in round 2) Minor (design) — C8 red-proof used a stub; one conditional test; merge-order
  claim unverified. **Resolved**: C8.
- T18 (new in round 2) Minor (design) — B8: the handler rethrows; the fault toggle needs a reset.
  **Resolved**: B8.
- T19 (new in round 2) Minor (design) — B5c must assert the response, with a parked positive
  control. **Resolved**: B5c.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert

- R1–R3, R5, R7–R10, R17 Checked; R18 Checked (F9/F12); R19 Checked (F11); R26, R27 Checked; R29
  Checked (75/77 verified against the manifest sum; F10 on the 3 ms); R34–R37, R40 Checked; R42
  Finding F9; R48 Checked; R49 Checked (F9, F12; C8 declares best-effort); R50–R52 Checked; R53
  Finding F10; R57 N/A.
- N/A: R4, R6, R11–R16, R20–R25, R28, R30–R33, R38, R39, R41, R43–R47, R54–R56.

### Security expert

- R1–R5, R8–R10, R12, R17, R18 Checked (R3: S9); R19 Adjacent (S10 item 3); R22 Checked; R29
  Finding S11; R31, R36, R40 Checked; R42 Checked (S9 notes what V7(b) does not enforce); R43
  Checked (S10 residue); R44, R48 Checked; R49 Finding S9; R50–R53 Checked (S11 on N1); R57 N/A.
- N/A: R6, R7, R11, R13–R16, R20, R21, R23–R28, R30, R32–R35, R37–R39, R41, R45–R47, R54–R56.
- RS1 N/A; RS2 Checked; RS3 Checked; RS4–RS6 N/A.

### Testing expert

- R1–R3, R5, R8–R10, R17 Checked; R18 Checked (T16); R19 Checked (T18); R29 T15; R33, R35, R36,
  R40, R42, R44 Checked; R46 Checked (T16); R47 T16; R48 Checked; R49 Checked (T17); R50 Checked
  (T15, T17); R53 T15.
- N/A: R4, R6, R7, R11–R16, R20–R28, R30–R32, R34, R37–R39, R41, R43, R45, R51, R52, R54–R57.
- RT1 Checked; RT2 T15, T18 (B5a/B5b/B4/B6 confirmed buildable); RT3 Checked; RT4 T19; RT5, RT6
  Checked; RT7 T16, T17, T19; RT8 Checked; RT9 N/A; RT10 Checked (T16, T17); RT11 Checked.

---

# Rounds 3 and 4

Date: 2026-11-14

## Changes from Previous Round

Round 3 reviewed the round-2 edits (V7(b)/(d), AC3, C5 rationale, C6, C8, B5c, B8). Round 4 was a
confirmation by the Testing expert of the two round-3 edits only.

## Functionality Findings

Round 3: No findings (F9–F12 verified resolved).

## Security Findings

Round 3: No findings (S9–S11 verified resolved; the S9 skip disposition judged acceptable).

## Testing Findings

Round 3 (T15–T19 verified resolved):

- T20 (new in round 3) Minor (design) — C8's schema signal read "absent" when it examined nothing.
  **Resolved**: C8 (comment-stripped model block, always-run positive control, throw when the
  block cannot be located).
- T21 (new in round 3) Minor (design) — V7(d)'s allowlist omitted `audit-outbox-in-tx` (R42).
  **Resolved**: V7(d) ranges over every `@/lib/audit/*` specifier; AC3 deny fixture.

Round 4: No findings (T20, T21 verified resolved).

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert (round 3)

- R1–R3, R5, R7–R10, R17–R19, R26, R27, R29, R34–R37, R40, R42, R47–R53 Checked.
- N/A: R4, R6, R11–R16, R20–R25, R28, R30–R33, R38, R39, R41, R43–R46, R54–R57.

### Security expert (round 3)

- R1–R5, R8–R10, R12, R17–R19, R22, R29, R31, R36, R40, R42–R44, R48–R53 Checked; R57 N/A.
- N/A: R6, R7, R11, R13–R16, R20, R21, R23–R28, R30, R32–R35, R37–R39, R41, R45–R47, R54–R56.
- RS1 N/A; RS2, RS3 Checked; RS4–RS6 N/A.

### Testing expert (rounds 3 and 4)

- Round 3: R1–R3, R5, R8–R10, R17–R19, R29, R33, R35, R36, R40, R44, R46–R49, R53 Checked; R42
  T21; R50 T20; RT1–RT6, RT8–RT11 Checked; RT7 T20.
- Round 4: R1–R3, R5, R8–R10, R17–R19, R29, R33, R35, R36, R40, R42, R44, R46–R50, R53 Checked;
  RT1–RT11 Checked.
- N/A: R4, R6, R7, R11–R16, R20–R28, R30–R32, R34, R37–R39, R41, R43, R45, R51, R52, R54–R57.

## Exit

Plan review closed after round 4 with every expert at "No findings" and no open finding. One
Minor (S9's optional AST ordering check) carries a Skipped disposition, recorded under round 2.
All contracts C1–C8 are `locked`.
