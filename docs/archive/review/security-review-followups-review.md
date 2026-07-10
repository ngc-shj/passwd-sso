# Plan Review: security-review-followups
Date: 2026-07-11
Review round: 1 (rounds 2-3 appended below)

## Changes from Previous Round
Initial review. Local-LLM pre-screening ran first (4 Minor: C1 test seam, C3 fetchApi-only residual, C2 marker proximity, C5 worker-pool-config classification) — all addressed in the plan before expert review.

## Functionality Findings

**F1 Minor: C3's "181 call sites" figure for `fetchApi(` does not reconcile with a direct recount** (also raised as Security S2 — merged)
- File: plan §C3 rationale
- Evidence: `grep -rln "fetchApi(" --include='*.ts' --include='*.tsx' src/` → 110 files (108 excl. tests); occurrences 270 (263 excl. tests). No slicing lands on 181 (the original figure summed only `src/components` + `src/hooks`).
- Problem: quantitative claim presented as codebase-derived without a reproducible command.
- Impact: none on detector design; plan-trust only.
- Fix: recompute and cite the exact grep command, or drop the number.

Verification summary (no finding): C1 line/constant claims exact; C2's 3 routes + sibling tests + real 403→redirect conversions verified; C4 member-set recomputed and matched (incl. extension/iOS empty set), round-trip traced lossless, round-trip test scaffold already exists at `password-import-parsers.test.ts:204`; C5 member-set matched, `worker-pool-config.ts` exclusion sound; C6 `mcpClient` required relation + selected in findUnique + replay returns before client validation; C7 doc stub confirmed.

## Security Findings

**S1 Minor: `scripts/audit-chain-verify-worker.ts` is a DB-touching execution context that C5's stated member-set derivation cannot discover**
- File: `scripts/audit-chain-verify-worker.ts:20-31,72`; plan §C5 member-set
- Evidence: it imports `@prisma/client`/`PrismaPg`/`Pool` directly and runs `$queryRawUnsafe` inline; it has NO `src/workers/*` module counterpart, so the `find src/workers` glob structurally misses it (R42 clause ①a — the glob anchors on a directory convention, not the defining primitive).
- Impact: exactly the class C5 exists to prevent — a DB-driving context without a mechanically-enforced manifest entry.
- Fix: 4th manifest entry `audit-chain-verify-worker` with `modules: ["scripts/audit-chain-verify-worker.ts"]`; completeness check reconciles against BOTH the `src/workers` module glob AND the scripts entrypoint set; document the scripts-path exception.
- escalate: false

**S2** — merged into F1.

**S3 [Adjacent → Testing] Minor: widened regex now also catches leading-`\n`+trigger values; round-trip untested for that case**
- Evidence: `/^\s*[=+\-@\t\r]/.test("\n=cmd")` → true (old regex: false). Already quote-wrapped via `includes("\n")`; only the `'`-prefix decision changes. Traced consistent through `splitCsvRows` but unpinned.
- Fix: add a leading-`\n` round-trip case alongside the leading-space case.
- escalate: false

Verified clean: C1 no cache-poisoning/DoS angle; C2 proximity not trivially defeatable, fail-safe direction; C3 fail-closed by construction, empty-pathTokens forbidden closes vacuous completeness; C4 no ReDoS (empirical 50k-char 0ms), RS6 ordering preserved in all 3 escape functions, strip-truncation same accepted-cost class; C5 SECURITY DEFINER set complete (2 migrations); C6 storedClientId never reaches the HTTP response body (audit sink only) — no info-leak; C7 doc content accurate vs `access-restriction.ts:140-166`. No Critical — no escalation.

## Testing Findings

**T1 Major: C1's AC2 is not mutation-capable as worded (RT7 shape-a)**
- Evidence: eviction (incl. current `cache.clear()`) runs BEFORE `cache.set(...)` (route.ts:80-89), so the just-inserted entry is ALWAYS present under both fixed and buggy code — "newest still hits" cannot go red on revert.
- Fix: assert on a PRE-capping-insert entry: fill to cap, insert one more (E), assert oldest misses AND an entry filled just before E still hits with no upstream call. Only the latter distinguishes FIFO from full-clear.

**T2 Major: C1 silent on module-scoped `cache` state isolation between tests**
- Evidence: `cache` is module-private (route.ts:21); `vi.clearAllMocks()` does not reset it; existing tests already dodge leakage via unique prefixes; `vi.resetModules` idiom established elsewhere (`src/__tests__/env.test.ts`, `src/lib/redis.test.ts`).
- Fix: plan must fix the strategy: one sequential test against the same filled cache, or per-test `vi.resetModules()` + dynamic import.

**T3 Minor: C4 AC2 must route through `parseCsv`/`parseCsvLine` on a full synthetic CSV row — not a direct `stripCsvFormulaGuard` call**
- Evidence: `parseCsvLine` (parsers.ts:139,169) calls `.map(stripCsvFormulaGuard)` — real path wireable; AC2 wording ambiguous between mocked-half and real-path readings (R40).
- Fix: name the entry point explicitly in AC2.

**T4 Minor: C6 AC1 requires a genuinely NEW adversarial test case, not a parametrization of the existing replay test**
- Evidence: existing replay test (oauth-server.test.ts:1232) passes the row's own clientId ("mcpc_test") — storedClientId and presented value would coincide.
- Fix: new test with a mismatched clientId (e.g. `mcpc_ATTACKER_LIE`), assert `storedClientId === "mcpc_test"`.

Positive confirmations: C2/C3 fixture vehicle right, all 5 new failure modes coverable (RT2); guard already wired into pre-pr.sh:166 + CI static-checks (no new wiring, no RT7-b); CLI parity test is duplicate-cases pattern; `src/__tests__/workers/` placement consistent; C6 metadata assertions use `objectContaining` (R19 safe); 5k loop fits 10s testTimeout; full-gates list complete.

## Adjacent Findings
- S3 (Security → Testing): routed to Testing scope; accepted — folded into C4 acceptance criteria alongside T3.

## Quality Warnings
None flagged (merge-findings quality gate: all findings carry file/line evidence and concrete actions).

## Recurring Issue Check
### Functionality expert
- R1: N/A — no new shared helper; C1-C7 extend existing modules in place.
- R2: Checked — no issue.
- R3: Checked — no issue (C4 propagated to both definition sites with parity test; C6 scoped, no unpropagated sibling).
- R4: N/A — no new mutation sites.
- R5: N/A — C1 in-memory; C6 tx structure pre-existing.
- R6: N/A — no deletes introduced.
- R7: N/A — no E2E selectors/UI markup touched.
- R8: N/A — no UI components.
- R9: Checked — no issue (logAuditAsync already outside tx per convention).
- R10: Checked — no issue.
- R11: N/A. R12: Checked — no issue (metadata keys, not enum values). R13: N/A. R14: N/A. R15: N/A.
- R16: Checked — no issue (C5 test filesystem-only per VE2).
- R17: N/A. R18: Checked — no issue (additive only).
- R19: Checked — C6 additive optional field; both test trees committed in plan; no other consumers of exchangeRefreshToken's return shape found beyond route.ts.
- R20: N/A. R21: N/A (Phase-1). R22: N/A. R23: N/A. R24: N/A.
- R25: Checked — no issue (C4 symmetry analysed + verified by trace).
- R26: N/A. R27: N/A. R28: N/A.
- R29: N/A — no external spec section citations (CodeQL rule name and OWASP class name only).
- R30: Checked — no issue (plan doc, not GitHub-rendered body; recheck if pasted into PR body).
- R31: N/A. R32: N/A. R33: N/A.
- R34: Checked — no issue beyond F1; no other `cache.clear()`-at-cap pattern found elsewhere.
- R35: N/A — no deployment artifacts in file list.
- R36: N/A. R37: N/A (confirmed no messages/*.json in contracts). R38: N/A. R39: N/A.
- R40: Checked — no issue (C6 additive optional internal field; C5 manifest consumed by fs/JSON.parse test).
- R41: N/A.
- R42: Checked — recomputed member-sets for C2/C3 (`@browser-redirect` + step-up ids), C4 (CSV regex sites incl. extension/iOS absence), C5 (workers/entrypoints/definer migrations) — all matched. One numeric claim (fetchApi "181") did not reconcile → F1 (Minor).

### Security expert
- R1: Checked — no issue (C4 reuses SSoT regex via shared import; no new parallel escaper).
- R2: N/A. R3: Checked — C4 propagates to both twins; C6 covers both replay and concurrent-rotation audit paths. R4-R16: N/A.
- R17/R22: N/A — no new helper. R23-R30, R36, R37, R39, R41: N/A.
- R31-R35: Checked — no new destructive op or injection surface.
- R38: Checked — C1/C2/C3 fail-closed direction; C6 additive-only, revocation unaffected.
- R40: N/A.
- R42: Checked, one finding (S1) — C5's derivation glob anchors on a directory convention rather than the true defining primitive; C4 and C3 member-sets confirmed complete/self-deriving.
- RS1: Checked — no new credential comparison. RS2: N/A — no new endpoint. RS3: N/A. RS4: Checked — no PII in plan. RS5: N/A. RS6: Checked — ordering preserved in all three escape functions after widening.

### Testing expert
- R1: N/A. R2: N/A. R3: Checked — C4 scoped to both definition sites. R4-R16: N/A. R17: N/A. R18: N/A. R19: Checked — objectContaining, no exact-shape staleness. R20: N/A. R21: applies Phase 2, noted. R22-R28: N/A. R29: Checked. R30: Checked. R31: N/A. R32: N/A — C5 documents EXISTING workers only. R33: N/A — rides existing wiring. R34: Checked — nothing beyond T1/T2. R35: N/A. R36: N/A. R37: N/A. R38: N/A. R39: N/A. R40: Checked — T3 raised for phrasing precision only. R41: N/A. R42: Checked — C3/C5 member-sets code-derived; guard set-equality re-derives at run time.
- RT1: T4 raised. RT2: Checked — all proposed tests writable. RT3: N/A. RT4: N/A. RT5: Checked — both layers' call paths include their primitive. RT6: N/A (Phase 1). RT7: T1 raised (Major). RT8: Checked — AC1 negative-assertion form present; guard fixtures assert stdout denial signal.

## Resolution Status (Round 1)

| ID | Severity | Resolution |
|----|----------|------------|
| F1/S2 | Minor | Fixed in plan — figure replaced with reproducible grep-derived count |
| S1 | Minor | Fixed in plan — C5 member-set derivation reconciles both globs; 4th manifest entry added |
| S3 | Minor | Fixed in plan — leading-`\n` round-trip case added to C4 AC |
| T1 | Major | Fixed in plan — AC2 reworded to assert a pre-capping-insert entry survives |
| T2 | Major | Fixed in plan — module-state strategy specified (vi.resetModules + dynamic import per new test) |
| T3 | Minor | Fixed in plan — AC2 names parseCsv/parseCsvLine full-row entry point |
| T4 | Minor | Fixed in plan — AC1 requires a new adversarial mismatched-clientId test case |

---

# Round 2 (incremental)
Date: 2026-07-11

## Changes from Previous Round
All 7 round-1 findings applied to the plan: C1 AC1-AC3 rewritten (pre-capping-entry assertion, revert-mutation proof, vi.resetModules isolation); C3 fetchApi figure corrected to 263 with reproducible command; C4 AC2 routes through parseCsv/parseCsvLine full-row entry point + leading-\n case; C5 member-set union of src/workers glob + scripts entrypoint set, audit-chain-verify-worker manifest entry; C6 AC1 mandates a new adversarial mismatched-clientId test.

## Functionality Findings
No findings. All five round-1 fixes verified at the exact locations claimed; grep count 263 reproduced; no stale references; Go/No-Go and Testing strategy consistent.

## Security Findings

**S4 (new in round 2) Minor: C5's completeness reconciliation still glob-anchored — misses two DB-driving one-shot migration scripts**
- Evidence: `scripts/migrate-webhook-secrets-v1-to-v2.ts` and `scripts/migrate-account-tokens-to-encrypted.ts` construct PrismaClient/PrismaPg/Pool directly against MIGRATION_DATABASE_URL (highest-privilege DB contexts outside the workers) yet match neither `src/workers` glob nor `scripts/*worker*.ts`. Same root cause as S1, one level down (R42 clause ①b: the fix patched the instance, not the class). `prisma/seed.ts` (real PrismaClient, permanent no-op) undecided. Confirmed non-members: purge-*.sh / rotate-master-key.sh (HTTP-only), env-descriptions.ts (prose only).
- Fix applied: primitive-anchored candidate derivation (see round 3).
- escalate: false

S1/S3 verified resolved. T1/T2 fixes sanity-checked — no security impact; test-only, no external calls.

## Testing Findings
No findings. T1 discriminator verified genuinely mutation-capable; T2 resetModules precedent empirically validated by running `npx vitest run src/lib/redis.test.ts` (16/16 pass — hoisted vi.mock re-applies after resetModules + dynamic import); one advisory nuance (mixed static+dynamic import shape not present in precedent files; mechanically sound) — folded into C1 AC3 as an implementation note. T3/T4 verified resolved. S1's union derivation confirmed implementable in the route-policy-manifest.test.ts pattern (filesystem-only, mutation-capable both directions).

## Recurring Issue Check (deltas)
- Functionality: R42 improved (C5 union derivation), R40 improved (C4 real-path round-trip); all others unchanged from round 1.
- Security: R42 — still open for C5 after round 2 (S4); RS6 unchanged (preserved); others unchanged.
- Testing: RT7 improved (C1 discriminator now valid); feedback_effective_default_distributed_contract / feedback_triangulate_enumerate_completeness re-checked — satisfied; others unchanged.

## Resolution Status (Round 2)

| ID | Severity | Resolution |
|----|----------|------------|
| S4 | Minor | Fixed in plan (round 3) — candidate set re-derived from the connection-opening primitive (`new PrismaClient(|new Pool(|from "@/lib/prisma"` over scripts/*.ts + prisma/seed.ts, verified zero false positives); migrate scripts + seed.ts moved to $documented-exclusions with reasons (disposition (b)); completeness test fail-closed for future candidates (claim-or-exclude, both directions). |

Round-3 scope note: functionality expert skipped in round 3 — the only plan edit is the C5 member-set/governance text, fully within Security (S4 originator) + Testing (completeness-test mechanics) scopes; functionality round 2 already verified C5 implementability and no contract signature changed. Recorded per Anti-Deferral (out-of-scope routing): the edit's functional aspect is the test implementability, explicitly re-verified by the Testing expert in round 3.

---

# Round 3 (incremental — S4 fix verification)
Date: 2026-07-11

## Changes from Previous Round
§C5 member-set re-derived from the connection-opening primitive (R42 clause ①b): candidate set = src/workers glob UNION `grep -lE 'new PrismaClient\(|new Pool\(|from "@/lib/prisma"' scripts/*.ts prisma/seed.ts`; migrate scripts + prisma/seed.ts moved to $documented-exclusions with reasons; thin launchers reclassified as entrypoint doc fields (open no connection); completeness fail-closed (claim-or-exclude, both directions). C5 AC2 extended with the S4-direction and reason-length mutations. Functionality expert skipped this round (edit within Security+Testing scopes; rationale in Round 2 section).

## Security Findings
No findings. Candidate grep reproduced exactly (4 files, zero false positives/negatives). All 9 unmatched scripts + 3 thin launchers spot-checked — no indirection reaches a DB connection that the grep misses; the theoretical transitive-import residual is not instantiated and is proportionately covered by the fail-closed claim-or-exclude gate + per-PR review. Exclusion reasons verified honest (both migrate scripts genuinely one-shot, --dry-run-gated, bounded loops; worst case / likelihood / cost quantified — accepting exclusion is the correct proportional control; forcing worker-semantics prose onto non-recurring scripts would be the same false assurance the plan's own forbidden-pattern rule rejects).

## Testing Findings
No findings. Vitest implementability confirmed (filesystem-only; self-match pitfall structurally absent — test lives outside both globs, scripts/*.ts is non-recursive so scripts/checks/ is never swept). RT7 mutation-capability provable in all needed directions via live-tree re-derivation (no fixture needed); candidate set recomputation exact match; worker-pool-config.ts constants-only confirmed by inspection.

## Recurring Issue Check (deltas)
- Security: R42 (C5) — RESOLVED (S1 filename-anchored → S4 glob-union instance-level → primitive-anchored, stable under independent reproduction).
- Testing: RT7 (C5) — satisfied; the S4 direction provable without repo pollution.

## Convergence
Round 3: all participating experts return "No findings". Round 2 functionality: "No findings". Phase 1 review CONVERGED after 3 rounds (7 findings round 1, 1 finding round 2, 0 findings round 3). All contracts locked in the Go/No-Go gate.
