# Plan Review: share-link-expiry-grace
Date: 2026-11-11
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen skipped (Ollama unavailable).

## Functionality Findings
- F1 [Major][design] Expired-never-accepted emergency invites retained 30d block re-invite (`DUPLICATE_GRANT`) and show as live PENDING (`src/app/api/emergency-access/route.ts:46`). Merged with S1. → Resolved: `emergency_access_grants` removed from scope (plan SC1).
- F2 [Minor][prose] C2/C3 "reviewer to confirm" TODOs. → Resolved: Round-1 enumeration recorded in C2/C3.

## Security Findings
- S1 [Major][design] Emergency duplicate check counts expired-PENDING (same as F1). → Resolved (SC1).
- S2 [Major][design] Revoked/rejected emergency grants would retain key-pair ciphertext, public keys, grantee email for 30d. → Resolved (SC1).
- S3 [Minor][design] Expired unexecuted admin-reset rows retain `encryptedToken`. → Accepted explicitly in plan Security consideration.
- S4 [Minor][prose] Risk acceptance omitted `encrypted_file`, `accessPasswordHash`, old master key version. → Resolved in plan Security consideration.
- S5 [Minor][prose] C4/C5 concurrence; reject-by-token lacks `tokenExpiresAt` gate. → C4/C5 notes folded in; reject-by-token is emergency (SC1) and unaffected by this plan.
- C2 member set verified fail-closed across all gating paths (recorded in plan C2).

## Testing Findings
- T1 [Critical][design] Plan's test map wrong: `api_keys`, `operator_tokens`, `admin_vault_resets`, `personal_log_access_grants` have no existing retention tests. → Resolved: new per-table tests specified with fixtures.
- T2 [Major][design] Existing share tests (cascade, worker-role, A2 race) go red/vacuous. → Resolved: enumerated; A2 positive control.
- T3 [Major][design] Emergency tests. → Moot (SC1).
- T4 [Major][design] api-keys cap test mock-only; toctou integration test re-implements old query. → Resolved: toctou predicate updated + unit test with `expect.any(Date)`.
- T5 [Major][design] C5 mocks lack `expiresAt`. → Resolved: mocks updated, new cases, fake timers.
- T6 [Major][design] C2 deny-side tests absent. → Resolved: C2 deny-side test obligation in Phase 2.
- T7 [Minor] Matrix regeneration must be committed; shared constant. → Resolved.
- T8 [Major][design] 29-day boundary blind gap; literal repeated; cleanup. → Resolved: G−1d / G+1h boundaries; shared constant; RT11 check.
- T9 [Minor][prose] Mislabelled test files. → Resolved.

## Adjacent Findings
- (Testing) Emergency expired-invite retrievability — moot (SC1).
- (Testing) Revoked rows retained to `expires_at + 30d` — accepted, plan C1.
- (Testing) `access_requests` 7d vs 30d — SC3.
- (Security A1/A2) Emergency UI / `updated_at` reset — moot (SC1).

## Quality Warnings
- Testing expert's Recurring Issue Check grouped R-ranges instead of one line per rule; accepted for Round 1 (findings themselves carried evidence), per-rule format requested in Round 2.

## Recurring Issue Check
### Functionality expert
R1 Checked; R2 Checked (literal repetition → constant); R3 Checked; R4-R5 N/A; R6 Checked (cascades unchanged); R7-R13 N/A; R14 Checked (worker table-level SELECT/DELETE); R15-R24 N/A; R25 Finding F1; R26-R28 N/A; R29 Checked (18-entry count re-derived; C3 findFirst claim refuted → F1); R30-R33 N/A; R34 Checked (C5 in scope); R35-R41 N/A; R42 Finding F1; R43-R51 N/A; R52 Finding F1; R53-R57 N/A.

### Security expert
R1-R3 Checked; R4 N/A; R5 Checked; R6 Finding S2; R7 N/A; R8 Checked; R9-R16 N/A; R17 Checked; R18-R24 N/A; R25 Checked; R26-R28 N/A; R29 Checked; R30-R35 N/A; R36 Checked; R37-R39 N/A; R40-R41 Checked; R42 Checked (S1 gap); R43 Checked (no widening); R44-R47 N/A; R48-R52 Checked; R53-R57 N/A; RS1 Checked; RS2 N/A; RS3-RS4 Checked; RS5-RS6 N/A.

### Testing expert
R1-R10 Finding T8 (literal repeated); R11-R20 N/A; R21-R30 out of scope (Adjacent); R31-R40 N/A; R41-R50 Finding T6 (C2 delegated); R51-R57 T7; RT1 Finding T4/T5; RT2 Checked; RT3 Finding T7/T8; RT4 Checked; RT5 Finding T2/T3; RT6 Checked; RT7 Findings T1/T3/T4/T5/T6; RT8 Minor T9; RT9 Checked; RT10 Findings T1/T5/T6; RT11 Finding T8.

---

# Review round: 2
Date: 2026-11-11

## Changes from Previous Round
Emergency grants removed (SC1); C2/C3 enumeration recorded; shared grace constant; testing strategy rewritten; Security consideration expanded.

## Findings
- Functionality: No findings (F1, F2 verified resolved).
- Security N1 [Minor][prose] SC1 left the pre-existing emergency expired-PENDING duplicate-check window unowned. → Resolved: new contract C6 fixes it in this PR (reviewer suggested record-and-defer; fixed instead, same class as C5).
- Testing N1 [Minor][design] toctou test hand-copies the cap predicate with no expired-key case. → Resolved: expired-key case added (red vs old predicate); helper extraction declined with reason.
- Testing N2 [Minor][prose] C2 deny-side obligation open-ended. → Resolved: per-gate checklist table.
- Testing N3 [Minor][prose] Forbidden pattern unenforced. → Resolved: `registry.test.ts` set-equality assertion.

## Recurring Issue Check
Per-rule sections received from all three experts (functionality R1–R57; security R1–R57 + RS1–RS6; testing R1–R57 + RT1–RT11), all Checked/N/A except the findings above (testing: R1/R17/R48/RT5/RT9 → N1; R42 → N2; R2/RT3 → N3; security: R34 → N1).

---

# Review round: 3
Date: 2026-11-11

## Changes from Previous Round
New C6 (emergency duplicate check excludes PENDING with `tokenExpiresAt <= now`); C2 checklist; toctou expired-key case; registry set-equality test.

## Findings
- Security: No findings. Every `granteeEmail` reader / grant resolver enumerated; none resolves by email alone; `tokenHash` unique; CAS includes unique id; `token_expires_at` NOT NULL.
- Functionality F1 [Minor][design] Expired PENDING card shown beside the re-issued one until next sweep. → Accepted, recorded in C6 (pre-existing state within a sweep interval).
- Testing M1 [Minor][design] C6 test plan mock-only; deny control vacuous; boundary and ACCEPTED/ACTIVATED control unpinned. → Resolved: exact-shape unit assertion with fake timers + real-DB predicate test via shared `where` builder.
- Testing M2 [Minor][prose] Live-duplicate case should assert the NOT clause. → Resolved.

## Recurring Issue Check
Per-rule sections received from all three experts; all Checked/N/A except: functionality R25 → F1; testing R19/RT1/RT5/RT8/RT10/R43 → M1/M2.

## Saturation call (Round 3)
1. Rounds completed: 3 (≥2).
2. Open Critical/Major: none in any category.
3. Design findings remaining open: none — the two Round-3 design-labelled Minors (F1, M1) were resolved in the plan by adopting the expert's own recommended action (F1 accept-and-record; M1 the exact test cases proposed).
4. Remaining open Minors: none.
Decision: plan phase complete; proceed to Phase 2. No Carried-Forward Plan Findings.
