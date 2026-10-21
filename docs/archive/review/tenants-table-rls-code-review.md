# Code Review: tenants-table-rls
Date: 2026-10-21
Review round: 2

## Changes from Previous Round

Initial review (incremental on the Phase 2 self-check, whose findings were fixed in 11ae815f7).
Seeds: skipped (optional step); experts reviewed the full diff against `origin/main`.

## Findings and Resolution Status

| ID | Expert | Sev | Finding | Resolution |
|----|--------|-----|---------|-----------|
| T1 / F1(func) | Test, Func | Major | Negative-test Cases 15/16 inherit Case 14's INITPLAN-violating throwaway policy; Block 1 aborts, both fail in CI | Fixed: reset + calibration run + only-expected-code assertion + post-restore verify; D9 |
| F1(sec) | Sec | Minor | `checkChainEnabled` reads a missing row as chain-disabled → unchained SENT | Fixed: throws `CHAIN_FLAG_UNREADABLE`; integration cells (allow + deny) |
| F2(sec) / T6 | Sec, Test | Minor | Empty check misses a scoped/partial enumeration | Fixed: sentinel absence → `TENANT_ENUMERATION_INCOMPLETE`; unit cells |
| F3(sec) / F6(func) | Sec, Func | Minor | Enumeration throw skips the heartbeat; recovery text cites a CI gate | Fixed: try/catch → `TENANT_ENUMERATION_FAILED`; alerts.md recovery rewritten |
| F4(sec) | Sec | Minor | Sentinel excluded silently even if its chain were enabled | Fixed: `SENTINEL_CHAIN_UNVERIFIABLE` |
| F5(sec) | Sec | Minor | Cases 15/16 per-case snapshot, no canonical check, no non-CI refusal | Fixed: single validated snapshot, CI-only, case 16 skipped on failed restore |
| T2 | Test | Minor | Decorative C5 count / C4 no-row | Fixed: C5 count removed; C4 commented as defence only |
| T3 | Test | Minor | 42501 cannot tell privilege denial from RLS refusal | Fixed: message pinned in cells and verify SQL; red-proved |
| T4 | Test | Minor | Global counts on shared dev DB | Fixed for trash (`>= 1` + specific row); `runTick` kept (passes on dev DB with 283 tenants; CI is clean) |
| T5 | Test | Minor | Block 1c (c2) UPDATE on seeded A0 uncoded under a WITH-CHECK-only mutation | Recorded as a coverage gap in the harness header (asymmetric mutation trips `[E-RLS-SYM]` first) |
| T7 | Test | Minor | Loose read-context assertion, no allow cell | Fixed |
| T8 / F4(func) | Test, Func | Minor | Drift gate skips silently; policy name not pinned | Fixed: fails when absent; exact name; self-test cells red-proved |
| T9 | Test | Minor | Synthetic adapter fixture labelled as real | Fixed: relabelled; realistic default-branch cell added |
| T10 | Test | Minor | Mutation table / C7 acceptance not recorded | Fixed: executed, D10 |
| F2(func) | Func | Minor | security-review.md says tenants has no RLS | Fixed |
| F3(func) | Func | Minor | tenant-boundary-matrix cites the removed probe | Fixed |
| F5(func) | Func | Minor | Block 1b pre-assert admits `''` | Fixed: `IS NULL` only |
| F7(func) | Func | Minor | "C1 migration" in a committed manifest | Fixed |

Side-fix: `audit-outbox-worker.test.ts` mocks answer the chain-flag query (broken by F1(sec)).

## Recurring Issue Check

Functionality: R3 F1; R29 F3, F6; R37 F7; R41 F1; R47 F4; R50 F1, F4; all others OK or N/A.
Security: R3 F1; R31 F5; R38 F1; R44 F5; R50 F2; all others OK or N/A; RS1–RS6 OK or N/A.
Testing: R3 T1; R6 T5; R14 T3; R16 T4; R21 T10; R29 T9; R31 T1; R35 T10; R41 T1; R47 T3; R49 T6;
R50 T1, T8, T10; R55 T6; RT1 T9; RT7 T1, T2, T10; RT10 T6, T7; all others OK or N/A.

## Environment Verification Report

- V1 (RDS owner under FORCE): `blocked-deferred` — plan V1 / SC3; runbook blocks (C7) run as a
  NOBYPASSRLS role locally (`verified-local`, D10).
- V2 (integration tests vs workers): `verified-local` — full integration suite with workers stopped.
- Negative-test Cases 15/16: `verified-CI` pending (CI-only harness).

## Round 2

Changes from previous round: all round-1 findings resolved (87fc3780b). Round 2 raised Minor only.

| ID | Expert | Sev | Finding | Resolution |
|----|--------|-----|---------|-----------|
| N1(sec) | Sec | Minor | `CHAIN_FLAG_UNREADABLE` invisible in logs (`code: unknown`); no requeue path before the 90-day purge | Fixed: error carries `code`; alerts.md documents cause, recovery and a requeue block (executed as `passwd_app` and `passwd_outbox_worker`, rolled back) |
| N2(sec) | Sec | Minor | Real-policy cases gated only on `CI=true`; a CI job without it SKIPs green | Fixed: explicit `RLS_NEGATIVE_MUTATE_REAL_POLICY=1` set only by the CI rls job; FAIL under GitHub Actions without it |
| N1(func) | Func | Minor | alerts.md counter invariant and sentinel text stale after D9 | Fixed |
| N2(func) | Func | Minor | One explanation logged for every enumeration reason | Fixed: per-reason text; cell asserts the FAILED line does not blame a missing sentinel |
| N3(func) | Func | Minor | Sentinel recovery contradicted the retention migration's explicit-decision rationale; no RDS-safe write | Fixed: explicit decision, write block executed (rolled back) |
| N1(test) | Test | Minor | No test drives the batch loop when the chain-flag read throws | Fixed: three unit cells (error path, no caching of the throw, allow side), red-proved |
| N2(test) | Test | Minor | C5 comment rationale inaccurate | Fixed |
| N3(test) | Test | Minor | `>= 1` where the count is exactly 1 | Fixed: `toBe(1)` |

Side effect: the sentinel parity gate's `alerts.md` count is now 10 (the recovery UPDATE spells it twice).

Recurring Issue Check (round 2): Security — R16, R31 N2; R38 N1; R50 N2; others OK or N/A; RS OK/N/A.
Functionality — R29 N1, N3; others OK or N/A. Testing — R29 N2; R38 N1; RT7 N3; RT8 N1; others OK or N/A.

## Round 3

Security: No findings. Functionality: No findings. Testing: one Minor.

| ID | Expert | Sev | Finding | Resolution |
|----|--------|-----|---------|-----------|
| N4(test) | Test | Minor | Runbook requeue selects by a `last_error` prefix the tests did not pin; the FAILED path had no cell | Fixed: anchored `/^CHAIN_FLAG_UNREADABLE: /` in both cells; new FAILED-path cell (`attempt_count` 7 of 8). Red-proved: prefixing the thrown message fails all three deny cells, the allow cell passes |

Recurring Issue Check (round 3): Security — all OK or N/A. Functionality — all OK or N/A.
Testing — R2, R38, R40, R41, R47 N4; others OK or N/A.
