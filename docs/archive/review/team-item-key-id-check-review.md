# Plan Review: team-item-key-id-check
Date: 2026-11-20
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
- F1 [Major, design] 0.5.0 snapshots copy a (v0, X) entry into (v0, X) history rows. After M1 the restore route's `sameItemKey`-first order can write (v0, X) back onto an entry → 23514. → Resolved: D-a/D-b clear history (v0, id); D-c adds the one-way histories CHECK.
- F2 [Major, design] A skip-release upgrade (0.4.x → this release) reruns D41. deployment.md L1444 names the deferred CHECK. → Resolved: Objective premise; C6 deployment.md requirement; code guard rejected with reason.
- F3 [Major, design] Minting keeps the marker, so an entry can drop out of pending. The "what 0.5.0 does" rationale was wrong. → Resolved: every repair sets marker 0; D-b re-derived from the 0.5.0 restore rule. (Converges with S1.)
- F4 [Minor, design] The high-water of rollout-window rows is never raised. → Resolved: raise-only step added.
- F5 [Minor, design] `teams FOR SHARE` is redundant under ACCESS EXCLUSIVE, opens a deadlock cycle, and the stall was understated. → Resolved: step dropped; stall restated (D-d).
- F6 [Minor, prose] D-a writer list was incomplete (0.4.77 bulk import, restore onto a NULL-id entry). → Resolved: D-a table.
- F7 [Minor, prose] C5 string case and baseline list. → Resolved: C5 self-test cases; baseline produced by running the gate.
- F8 [Minor, prose] NOTICEs are not printed by migrate deploy. → Resolved: C1 states where they appear.

## Security Findings
- S1 [Major, design] Repairs leave the marker, so entries drop out of the re-key requirement (R56). → Resolved (with F3).
- S2 [Major, design] The SC1 stale-id subset with an equal wrap and a different non-NULL history id is decidable. → Resolved: D-b relabel; conflicting evidence → marker 0 only; SC1 narrowed.
- S3 [Minor, design] Mint ignores a history id that proves the identity. → Resolved: adopt when |H| = 1.
- S4 [Minor, design, Adjacent] The 0.5.0 premise is not enforced. → Resolved with F2 (documented requirement; guard rejected with reason).
- S5 [Minor, design] The baseline is per directory, not per kind. → Resolved: self-test asserts M1's kind set is exactly {ADD CHECK}; listed self-test cases added.

## Testing Findings
- T1 [Major, design] Unenumerated seeds: the rerun describe `seedFixtures` and the team-rekey-pass rollout cells; an in-transaction DROP does not work across pooled connections. → Resolved: C4 enumerates each with its technique; three rollout cells deleted (state unrepresentable).
- T2 [Major, design] Entering the probe via SET ROLE and running DDL contradicts the rds-probe-role contract. → Resolved: a transaction-local NOLOGIN role in the owner role, attribute preconditions asserted, single client.
- T3 [Major, design] Red proofs were not per clause; the mint mutant targeted the wrong cell; no override hook. → Resolved: per-mutant table plus `TEAM_ITEM_KEY_ID_CHECK_SQL` hook.
- T4 [Major, design] GUC restore and lock behaviour were untested. → Resolved: sentinel assertion and a 55P03 lock cell.
- T5 [Minor] The VALIDATE cell needed a hidden-row control and an allow twin. → Resolved.
- T6 [Minor] A10 re-ADD and savepoints around refusals. → Resolved.
- T7 [Minor, prose] C5 baseline and self-test cases. → Resolved (with F7).

## Adjacent Findings
- S4 (deployment premise) merged with F2.

## Quality Warnings
None. Every finding cites file and line evidence.

## Recurring Issue Check
### Functionality expert
R1 Checked · R2 Checked · R3 N/A · R4 Checked · R5 N/A · R6 Checked · R7 N/A · R8 N/A · R9 Checked · R10 N/A · R11 N/A · R12 Checked · R13 N/A · R14 Checked · R15 N/A · R16 N/A · R17 Checked · R18 N/A · R19 N/A · R20 Checked · R21 N/A · R22 N/A · R23 N/A · R24 Finding F2 · R25 Checked · R26 N/A · R27 N/A · R28 Checked · R29 Finding F3 · R30 N/A · R31 Checked · R32 N/A · R33 N/A · R34 N/A · R35 Checked · R36 N/A · R37 N/A · R38 N/A · R39 N/A · R40 N/A · R41 Checked · R42 Finding F1 · R43 Checked · R44-R57 N/A

### Security expert
R1 ok · R2 ok · R3 ok · R4 n/a · R5 ok · R6-R13 n/a · R14 ok · R15 ok · R16 ok · R17 ok · R18 S5 · R19-R21 n/a · R22 ok · R23 n/a · R24 ok · R25-R28 n/a · R29 S1,S2,S4 · R30 ok · R31-R33 n/a · R34 S2 · R35 n/a · R36 ok · R37 n/a · R38 ok · R39 n/a · R40 n/a · R41 ok · R42 partial · R43 S1 · R44 ok · R45 n/a · R46 n/a · R47 S5 · R48 ok · R49 S1 · R50 ok · R51 S2,S3 · R52 ok · R53 n/a · R54 ok · R55 ok · R56 S1 · R57 n/a · RS1-RS3 n/a · RS4 ok · RS5 n/a · RS6 n/a

### Testing expert
R1 ok · R2 ok · R3 T1 · R4 n/a · R5 ok · R6-R13 n/a · R14 ok · R15 ok · R16 ok · R17 T3 · R18 T7 · R19-R23 n/a · R24 ok · R25-R28 n/a · R29 ok · R30-R41 n/a · R42 T1 · R43-R48 n/a · R49 ok · R50 T2 · R51-R53 n/a · R54 ok · R55 ok · R56 n/a · R57 n/a · RT1 ok · RT2 T2/T6 · RT3 ok · RT4 T4 · RT5 ok · RT6 n/a · RT7 T3 · RT8 ok · RT9 n/a · RT10 T5 · RT11 T2

---

# Plan Review: team-item-key-id-check
Date: 2026-11-20
Review round: 2

## Changes from Previous Round
Plan rewritten for the round-1 findings: marker 0 on every repair, H(e) adopt/relabel rules, histories one-way CHECK, high-water raise, teams lock dropped, deployment.md premise, C4 seed enumeration and per-clause red proofs.

## Functionality Findings
- F1 [Major, design] 0.5.0 restore re-mints an id for every restore of a NULL-id v1+ row, so "equal wrap under another non-NULL id" arises on clean data. The relabel rule would orphan attachments bound to the live id, and the conflict rule would hit healthy entries. → Resolved: the relabel and conflict rules are dropped (overrides round-1 S2), id'd entries are never relabelled, a restore-twice double-label control is added, and SC1 is widened.
- F2 [Minor, design] The histories ROW EXCLUSIVE → ACCESS EXCLUSIVE upgrade was unstated. → Resolved: both tables are locked up front, in app order.
- F3 [Minor, prose] The forbidden pattern matched the histories UPDATEs. → Resolved: scoped to entries.

## Security Findings
- Round-1 S1/S3/S4/S5 resolved. S2 is reverted per functionality F1, where clean-data evidence outweighs it. The security expert judged a wrong label recoverable through the pass, but a relabel on clean data would break attachments that work today, which is a regression the CHECK does not need.
- S6 [Minor, design] H(e) and the link used 3 wrap columns where the precedent uses 5. → Resolved: 5-column equality plus controls.
- S7 [Minor, prose] SC1 omitted the trimmed-evidence and propagated-stale-label cases. → Resolved.
- S8 [Minor, prose] Same as F3. → Resolved.

## Testing Findings
- U1 [Major, design] Deleting the rollout cells drops reachable coverage. → Resolved: the cells are converted to post-repair seeds.
- U2 [Major, design] Several mutants were vacuous (marker default 0, missing link rows, `hasId` maps, missing mutants). → Resolved: marker ≥ 1 seeds, a link row per arm, literal id map, and the added mutants.
- U3 [Major, design] The lock cell passed with LOCK TABLE removed. → Resolved: clean row, no DDL setup, `where` asserted, and a mutant row added.
- U4 [Minor, design] Helper wiring. → Resolved: the helper is split and each cell's mapping stated.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1-R28 Checked/N/A (unchanged) · R29 F1 · R42 F2 · others Checked/N/A
### Security expert
R29 S7 · R47 S8 · R48 S6 · all others ok/n/a · RS1-RS6 n/a/ok
### Testing expert
R1-R57 ok/n/a · RT2 U4 · RT4 U3 · RT5 U1 · RT7 U2/U3 · others ok/n/a

---

# Plan Review: team-item-key-id-check
Date: 2026-11-20
Review rounds: 3 and 4

## Round 3
- Functionality: no findings.
- Security S9 [Major, design]: the stale-label case is decidable by marker > 0 (no 0.5.0 writer leaves an equal wrap under another id with marker > 0). → Resolved: marker-only arm (id kept), controls split by marker, SC1 narrowed.
- Testing V1 [Major, design]: lock cell green for the "LOCK TABLE moved after UPDATEs" mutant. → Resolved: lock cell (b) via pg_locks. V2 [Minor]: same NULL column on both rows. → Resolved. V3 [Minor]: converted seeds tied to an exported repaired-shape constant. → Resolved.

## Round 4
- Security: no findings (draft SQL checked against the plan).
- Functionality F1 [Minor, prose]: the derivation omitted the v0→v1 upgrade PUT. → Resolved.
- Testing W1 [Major, design]: the H = {X, Y} control fell inside the marker-only arm. → Resolved: seeded as repaired, plus a some-vs-every mutant. W2 [Minor]: the mutant is reddened by NOTICE counts and the second run. → Resolved. W3 [Minor]: the attachments term in the constant. → Resolved.

## Exit
Saturation after round 4. No Critical or Major finding is open. The last design findings (S9, W1) were resolved in the plan, and the round-4 security and functionality passes over the plan and draft SQL returned no design findings. Every round-4 Minor was applied. No carried-forward findings.
