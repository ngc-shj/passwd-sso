# Plan Review: verify-sentinel-audit-chain
Date: 2026-10-23
Review round: 1

## Changes from Previous Round

Initial review (fresh reviewers).

## Merged findings and disposition

| ID | Source | Sev | Kind | Disposition |
|----|--------|-----|------|-------------|
| T-F1 | Testing (also Functionality A1) | Critical | design | Fixed — no test changes the sentinel's flag or writes its rows; routing proven by a direct call with superuser ground truth; flag logic unit-tested |
| F-F3 | Functionality | Major | design | Fixed — the sentinel is verified every tick, whatever its flag (C3) |
| F-F1 | Functionality | Major | design | Fixed — alerts.md states the retention/false-TAMPER interaction and keeps the disable-chain recovery |
| F-F2 | Functionality | Major | design | Fixed — alerts.md names TRUNCATED as the sentinel's likely mode and its remedy |
| T-F2 | Testing | Major | design | Fixed — stub answers GUC reads from what was written |
| T-F3 | Testing | Major | design | Fixed — deny cases asserted by message, on both axes; stub gains `$queryRaw` |
| T-F4 | Testing | Major | design | Fixed — bypass path tested with a second tenant's chain present |
| T-F5 | Testing | Major | design | Fixed — unit case on the sentinel transaction's timeout |
| S-F1 | Security | Minor | prose | Fixed — C1 control class in two layers |
| S-F2 | Security | Minor | design | Fixed — `BYPASS_SCOPE_VIOLATION` row assertion |
| S-F3 | Security | Minor | design | Fixed — `verifyTenantChain` takes no scope; bypass path exported under its own name |
| S-F4 / F-F5 | Security, Functionality | Minor | design | Fixed — precondition via `readBypassState`, compared to the constant grant, purpose included, values stringified |
| S-F5 / F-F6 | Security, Functionality | Minor | prose | Fixed — `MANUAL_MCP_REPLAY_VERIFICATION` recorded as unevidenced (superuser consumer); C4 reason reworded |
| F-F4 / T-F8 | Functionality, Testing | Minor | prose | Fixed — C3 lists every text that changes |
| T-F6 | Testing | Minor | prose | Fixed — each red proof names what goes red |
| T-F7 | Testing | Minor | design | Fixed — sentinel case compared with superuser ground truth; visibility proven on throwaway tenants |

Security's R43 check: no widening — the grant is the union of two existing grants the worker file
may already name, and the maintenance endpoint already reads `audit_logs` under bypass scoped by
`WHERE tenant_id`.

## Recurring Issue Check

### Functionality expert
R1 F-F5; R2 OK; R3 F-F4; R4 N/A; R5 OK; R6–R13 N/A; R14 OK; R15–R28 N/A; R29 F-F1, F-F6; R30–R40
N/A; R41 F-F1/F-F2; R42 F-F3 (#933 member set re-derived: 24, holds); R43–R48 N/A; R49 OK; R50 OK;
R51–R57 N/A.

### Security expert
R1–R42 N/A or no issue; R43 checked, no widening (residual F2, F3, F5); R44–R48 N/A; R49 F1, F4;
R50–R57 N/A. RS1 OK; RS2 OK (metadata only in memory); RS3 F4 stringify; RS4 OK; RS5 OK (a
non-canonical sentinel spelling is refused by withTenantRls); RS6 N/A.

### Testing expert
R1–R41 N/A; R42 OK; R43 N/A; R44–R48 N/A; R49 OK; R50 F6; R51–R57 N/A. RS* N/A. RT1 F2, F3; RT2
OK; RT3 use the grant constant; RT4 N/A; RT5 F2; RT6 OK; RT7 F3, F5, F6; RT8 F7; RT9 N/A; RT10 F3,
F4; RT11 F1.

---

# Round 2
Date: 2026-10-23

All round-1 fixes confirmed by their filing experts. Findings on revision 2, all applied in
revision 3:

| ID | Source | Sev | Kind | Disposition |
|----|--------|-----|------|-------------|
| F-N1 | Functionality | Major | design | Measured instead (R53): whole 12,469-row table counted in 1.7 ms; ~1 s extrapolated for a 1M-row sentinel vs a 60 s budget; partial index not added, recorded in C3 |
| F-N2 / T-N4 | Functionality, Testing | Major / Minor | design | Fixed — existing unit cases listed; stub fixtures keyed by tenant |
| F-N3 | Functionality | Minor | prose | Fixed — retention trade-off stated; chain-off recommended |
| S-N1 | Security | Minor | design | Fixed — anchor read asserted too; count stated as WHERE-only |
| T-N1 | Testing | Minor | prose | Fixed — sentinel expectation derived from superuser ground truth; scope of the proof stated |
| T-N2 | Testing | Minor | design | Fixed — options recorded per transaction |
| T-N3 | Testing | Minor | prose | Fixed — red proofs name the cells that go red |
| T-N5 | Testing | Minor | design | Fixed — deny cases for purpose and a missing state |

## Recurring Issue Check (round-2 delta)
Functionality: R3 F-N2; R29 F-N3; R50/R53 F-N1; others OK. Security: R43 re-applied, no widening,
no new exposure from per-tick verification; R49 S-N1. Testing: RT7 T-N2, T-N3; RT8 T-N1, T-N4;
RT10 T-N5; RT11 resolved.

---

# Round 3
Date: 2026-10-23

Security: no findings (N1 confirmed; the WHERE-only count accepted — one aggregate, never logged;
attacker-driven sentinel volume degrades loudly via P2028/TRUNCATED, no confidentiality gap).
Functionality: N1–N3 confirmed; R1 [Minor, prose] — the cost wording read as a whole-table count;
corrected to name the production statement bound to the largest tenant and the warm cache.
Testing: N1–N5 confirmed; P1 [Minor, design] — the anchor assertion's at-most-one-row half had no
case; `[own, foreign]` case and its red proof added.

Plan phase closed after 3 rounds: no Critical or Major open; the two round-3 Minors applied in
revision 4; all contracts locked.
