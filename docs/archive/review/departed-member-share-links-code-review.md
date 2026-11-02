# Code Review: departed-member-share-links
Date: 2026-11-02
Review round: 1

## Changes from Previous Round
Initial review of `02ccdc266..5f8efaed9` (implementation, A7 page cell, Phase 2
self-check fixes). Seeds: functionality unavailable; security "No findings"; testing
three Minors (one rejected — `beforeEach` clears the mocks).

## Functionality Findings
- F1 [Major] `shareLinkStatus` ranked "not admitted" above the final states: a revoked,
  expired or used-up dead link kept the revivable label, so revoking it showed nothing.
- F2 [Minor] One label for every refusal cause: "creator is no longer in the team" was
  shown for trashed or deleted entries too, including the creator's own orphaned link
  in the personal list.
- F3 [Minor] Gate: rule 1 reads tagged templates only; rule 2 missed template-string
  grant keys; KNOWN LIMITS did not say so.

## Security Findings
- S1 [Minor] The `[E-RLS-BYPASS-ROUTINE]` allowlist check claimed "exactly three tables"
  but only proved the literal was present; a second widening `set_config` would pass.
- Verified sound: the function's restore on every exit; the outer UPDATE's RLS
  InitPlan is evaluated before the non-leakproof function call and the outer executor
  is suspended during it, so the call-scoped bypass is never visible to the outer
  statement; refused answers match revoked at all four sites; verify-access writes no
  audit on refusal.

## Testing Findings
- T1 [Major] A8 `/mine?team=` asserted only `false`; an always-false wiring passed.
- T2 [Minor] The dialog test counted labels but not which row carried one.
- T3 [Minor] No personal entry share row in A6/A10; the handlers never admitted a
  non-team share (a protected share reaches the gate and verify-access without
  decrypting).

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3, R12, R14, R16, R25, R33, R42, R48 checked clean; R37 (F2), R38 (F1), R49 (F3).
### Security expert
R29, R42, R43, R54 clean; R49 (S1); RS1, RS2, RS5, RS6 n/a; RS3, RS4 clean.
### Testing expert
RT1-RT7, RT9, RT11 clean; RT8, RT10 (T1, T3); RT7 (T2).

## Environment Verification Report
`verified-local`: unit 20305, integration share-departure 22/22 (dev DB, workers
stopped), lint, tsc, build. The plan declared no blocked environment.

## Resolution Status
- F1: "not admitted" is decided only inside the active arm; revoked / used up / expired
  win (deviation D8 amends C4's precedence).
- F2: status and key renamed to `notAdmitted`, string made cause-neutral (en/ja):
  "Unavailable: the creator left the team or the entry was removed".
- F3: template-string grant keys are counted; rule 3 refuses untagged raw calls in a
  serving file; KNOWN LIMITS names the ORM form. Self-test fixtures added.
- S1: the check also requires exactly two writes of `app.bypass_tables` (the grant and
  the restore) with the grant being the exact list. Red-proved without touching the
  database: the original body passes, a body with a second widening call fails.
- T1: A8 lists a dead and a live link and asserts by id for an admin and a member.
  Red-proved: `/mine` reporting `false` for every item fails A8.
- T2: the dialog test asserts the label sits on the dead row and not on the live one.
- T3: A6 serves a protected personal entry share and a protected Send through the page
  (gate) and verify-access (token) after the creator's removal; A10 gains a personal
  entry share row.
