# Code Review: route-policy-sql-security
Date: 2026-07-04
Review round: 1

## Changes from Previous Round
Initial code review (Phase 3 Round 1).

## Functionality Findings
## Seed Finding Disposition
1. Rejected — false claim: publish_paused_until reset-to-PENDING is picked up on normal poll cadence (pollIntervalMs, setTimeout line 1204), not a tight loop; documented in adjacent comment. No code defect.
2. Rejected — false claim: INSERT...RETURNING and UPDATE audit_chain_anchors are in the SAME prisma.$transaction in deliverRowWithChain (198-360); crash rolls back both atomically. No stall window.
3. Rejected — README TODO is the SC1 tracker per plan Scope Contract; grep-able TODO(branch) markers are the project convention (siblings in check-doc-paths.mjs, parity test SC6, registry.ts). Matches intent.

## Functionality Findings

**F1 — Minor — purge-history diverges from sibling purge-audit-logs on tenant-not-found; untested**
src/app/api/maintenance/purge-history/route.ts:79-97: when tx.tenant.findUnique returns null, the null-guard is skipped (tenant is null) and effectiveRetentionDays falls to the raw unfloored request retentionDays, then deleteMany runs. Sibling purge-audit-logs/route.ts:61-69 returns {ok:true,purged:0} early (no-op) for the same case AND has a test (route.test.ts:200-210). Route comment says "Mirrors ... purge-audit-logs" but the mirror is broken for this branch. Today unreachable (Tenant/TenantMember/OperatorToken cascade-delete; no tenant.delete( in repo), so not exploitable now — hence Minor. Fix: early no-op {purged:0} when tenant is null + add "tenant no longer exists" regression test.

**F2 — Minor — generate-security-matrices.ts dbName-fallback untested, would mis-key a future un-@@map'd model**
scripts/generate-security-matrices.ts:270 `const table = model.dbName ?? model.name`. All 57 current models have @@map so dbName never null; test fixtures only cover non-null dbName. If a future model lacks @@map AND is RETENTION_REGISTRY-managed, managedTables.has(table) compares PascalCase vs lowercase registry name → never matches → managed model silently leaks into "no automated purge" bucket, breaking the plan's "every model in exactly one section" guarantee. Fix: assert in test that every current Prisma model has non-null dbName (mechanical), or add a dbName:null fixture exercising the fallback.

## Recurring Issue Check
### Functionality expert
- R1-R2: clean (route-class-patterns.json shared source implemented; 3 consumers fail-closed; ran all 3, pass).
- R3: N/A (no propagation gap; prior F2/F3/F6/S1/S4/S7 closed).
- R4-R16: N/A (no event dispatch/cascade/UI/DB-role/migration novel this round).
- R17,R22: clean (deliverRowWithChain, reapStuckRows exported-not-duplicated, setBypassRlsGucs, withBypassRls reused).
- R18: clean (DELETE_SIGNAL externalization behavior-identical, ran stepup check exit0).
- R19-R21: N/A.
- R23-R28: N/A (no UI).
- R29-R30: clean (no spec citations, no bare #N).
- R31: N/A. R32: N/A (no new long-running artifact). R33: clean (C2/C5 run_steps above STATIC_ONLY gate).
- R34: [Adjacent] A1 false-tamper tracked via TODO (Security's domain).
- R35: N/A. R36-R41: clean (no suppressions; 2 new i18n keys en/ja consistent).
- R42: central — re-ran all derivations: raw-SQL 29, destructive/operatorGated 10 true+1 false+11 path floor, RLS tables 55, ALLOWED_USAGE 94 — all match docs, no drift. F1 is R42-adjacent (mirror class, one member diverging, caught by tracing not trusting the "mirrors" comment).

## Security Findings
## Seed Finding Disposition
1. purge-audit-logs null-retention — CONFIRMED FIXED complete. null-check (76-78) before dryRun (86-93) AND real-delete (94-102); both paths short-circuit before any audit read/write. 409 wired.
2. purge-history floor — CONFIRMED FIXED complete + allowlist updated. null-check (89) before dryRun count + real deleteMany; 409 wired; check-bypass-rls.mjs:52 = ["tenant","passwordEntryHistory"] matches usage.
3. sweep.ts A2 double-emit — CONFIRMED FIXED, correct reorder. DELETE...RETURNING (278-288) before emit loop over RETURNING rows (292-325); row-lock → each row to at most one tx → no double-emit. Regression test races 2 connections batchSize=100, asserts per-row toHaveLength(1).

## Security Findings

**S1 — Minor — audit-chain-threat-model.md:129 cites audit-chain-verify/route.ts:198 but seedPrevHash is at :204**
Doc's Retention-purge section points to :198 (a toSeq clamp) for the seedPrevHash genesis default; actual `let seedPrevHash = Buffer.from([0x00])` is :204. An incident responder following the pointer during a false-tamper alert (D2) lands on the wrong section. Fix: reference the seedPrevHash SYMBOL name (drift-resilient), not the line number.

**S2 — Minor (design-limit, plan-acknowledged) — check-raw-sql-usage.mjs:357-373 marker truthfulness is review-enforced not CI-enforced**
ident-markers pairing verifies marker presence + ≥10-char reason + count==N, but NOT that the reason is true for the span. Copy-pasting a marker onto a new genuinely-unsafe interpolation + bumping N passes (reproduced live, exit 0). Plan explicitly accepts this ("Why not validator-adjacency"). Low-cost strengthening (recommended, not blocking): require the marker reason to name a validator function that actually appears (grep) in the same file — catches a copy-pasted marker naming an absent mechanism.

**S3 — Minor (latent, not present today) — check-raw-sql-usage.mjs:230-255 resolveArgSpan silently skips reassignment-built SQL**
Bare-identifier SQL arg only resolved when bound via `const|let <id> = \`` within 60 lines back. Reassignment/concat (`let sql=f(); sql=sql+\`...${x}...\``) → resolveArgSpan returns null → call silently skipped (no flag). A future refactor introducing ${untrustedValue} in an appended segment evades Layer 2. Reproduced live (exit 0). No current call site uses this shape. Fix: fail-closed — flag any Unsafe call whose arg resolves to neither a direct literal nor a simple binding, rather than silently skipping.

**S4 — [Adjacent] informational — SC3 path-guard deferral means new security docs' file-path refs not CI-checked**
check-doc-paths.mjs SKIP_GLOBS still excludes docs/security/**; scoped out (SC3). No broken ref found in samples. Manual spot-check only, as intended.

## Recurring Issue Check
### Security expert
- R1-R42 (grouped): tenant-scoping intact in both fixed routes (whereClause.tenantId present, no new system-wide where); RLS bypass-GUC discipline — the one new allowlist edit verified against actual usage; step-up/destructive drift — DELETE_SIGNAL now shared via route-class-patterns.json jq -er fail-closed (C1 preemptive R42 fix); no new secrets/deps/client-crypto. No unaddressed recurrence.
- RS1: N/A (no credential comparison in diff).
- RS2: N/A (no new API route; manifest classifies existing).
- RS3: N/A (no new request-param validation; purge routes' bodies validated by existing zod).
- RS4: clean (no PII in diff/docs).
- RS5: N/A (no externally-supplied crypto/authz parameter).
No Critical — no escalation.

## Testing Findings
## Seed Finding Disposition
Seed unavailable — no dispositions to record.

## Testing Findings
No findings. All C1/C2/C5 checks and C4 concurrency/RT5 tests verified by LIVE re-execution (not just reading).

Verification detail:
- V1: route-policy-manifest.test.ts imports REAL classifyRoute/isBearerBypassRoute (RT5); assertions 1-8c build concrete mismatch arrays → toEqual([]); bijection catches missing AND extra route; 56/56 pass; no it.skip/describe.skip.
- V2: RT7 fail-path proofs re-run live — check-raw-sql-usage.mjs (exit0), check-permanent-delete-stepup.sh (exit0), check-security-doc-exists.sh (exit0). 5 C2 + 2 C1 + 1 C6 proofs each show a DISTINCT real failure cause (MISSING_FROM_ALLOWLIST / STALE_EXEMPT / UNMARKED_INTERPOLATION / IDENT_MARKERS_MISMATCH ×2 opposite dirs / bijection / classifier mismatch / missing-heading).
- V3: check-raw-sql-usage.mjs:149-179 real brace-depth span tracking; Layer1/Layer2 independent (line353 unconditional on entries.has); ident-markers default-0 fail-closed (line358) confirmed live (sweep.ts N=4 has 4 markers; audit-outbox-worker no suffix no markers).
- V4: generate-security-matrices.test.mjs has determinism (twice byte-identical) AND content-correctness (registry-model row, non-registry bucket, no-leak guard) — RT6.
- V5: T2 real deliverRowWithChain asserts chain_seq [1,2]; T8 real runCadence asserts ["lock_held","published"]+settings len1; A2 real sweepAuditProvenanceEntry asserts per-row exactly-1 audit; batchSize=100 rationale holds (select-first regression → 12 rows caught). No sleeps. All wired to CI integration glob.
- V6: T1 real deliverRowWithChain (hand-rolled SQL removed); T3 real reapStuckRows (export purely testability, narrow).
- V7: RT8 — both purge route null-retention tests assert 409 AND mutation-spy not-called; clamp tests assert the actual SQL param threaded (not just response body).
- V8: check-security-doc-exists.sh genuine data-driven refactor (parallel arrays + check_doc(), bash-3.2, no assoc arrays); doc-0 behavior preserved incl. Overview-optional; live exit 0.
- V9: pre-pr.sh:183,188 register check:security-matrices + check:raw-sql-usage in UNGATED region; package.json scripts match.

## [Adjacent] deviation (not a defect)
T2 uses raceTwoClients pre-warm + Promise.all instead of the Deferred barrier D3 planned. Synchronization correctness comes from production FOR UPDATE row lock; assertions don't depend on race-winner identity → does not weaken the test. Record as deviation-log note.

## Recurring Issue Check
### Testing expert
- R1-R42: no instances (no silent catch, missing await, any-casts, hardcoded secrets, unparameterized SQL introduced, skipped tests; R42 .sh/vitest drift mitigated by shared route-class-patterns.json, verified non-drifted by re-running both consumers).
- RT1: not found (every assertion live-reproduced to fail or reads as concrete violation array, not tautology).
- RT2: N/A (testability verified via live execution).
- RT3: not found (null-retention 409, GUC-guard failure, STALE_EXEMPT, IDENT_MARKERS both directions covered).
- RT4: not found (T2/T8/A2 assert concrete both-branch outcomes).
- RT5: not found (all 6 tests call real exported functions; reapStuckRows export testability-only, narrow).
- RT6: not found (generator has determinism + content-correctness).
- RT7: not found (all fail-path proofs re-executed, distinct correctly-attributed failures).
- RT8: not found (both purge routes assert mutation-spy not called + 409).

## Adjacent Findings
- S4 (Security→docs/CI): SC3 path-guard deferral, informational, no broken ref found. Tracked by existing SC3 TODO.
- T2-deviation (Testing): T2 test uses raceTwoClients not the D3-planned Deferred barrier; does not weaken the test (production FOR UPDATE provides synchronization). Record in deviation log.
- R34 (Functionality→Security): A1 false-tamper tracked via watermark TODO.

## Quality Warnings
None — all findings carry file:line evidence; several were reproduced live by the experts.

## Environment Verification Report
Phase 1 declared VE1-VE3 (all verifiable-local, no blocked-deferred). Status:
- VE1/VE2/VE3: verified-local — pre-pr.sh full run PASSED (11968 unit tests + build + CLI + extension); DB-integration C4 tests re-run green against live Postgres; all static checks (parity, raw-sql-usage, security-doc-exists, drift) re-executed exit 0 by the Testing/Security experts.

## Resolution Status
(pending fixes — see below)

## Resolution Status (Round 1)

### F1 [Minor] purge-history tenant-not-found asymmetry — FIXED
- Action: added early `return NextResponse.json({ purged: 0 })` when tenant lookup is null (mirrors purge-audit-logs); added "tenant no longer exists" regression test asserting 200/{purged:0} + no deleteMany/count.
- Modified: src/app/api/maintenance/purge-history/route.ts:85-95, route.test.ts

### F2 [Minor] generator dbName fallback untested — FIXED
- Action: added a test asserting every real Prisma.dmmf model has a non-null dbName, mechanically keeping the renderer's `?? name` fallback dead.
- Modified: scripts/__tests__/generate-security-matrices.test.mjs

### S1 [Minor] doc line-number drift (:198 vs :204) — FIXED
- Action: replaced the line-number citation with a symbol reference (seedPrevHash), drift-resilient.
- Modified: docs/security/audit-chain-threat-model.md:129

### S2 [Minor] marker truthfulness review-enforced — HARDENED (partial, per Security's recommendation)
- Action: check-raw-sql-usage.mjs now rejects a raw-sql-ident marker whose named validator function (empty-paren call or validator-verb-prefixed call) is absent from the same file. Catches copy-pasted markers naming an absent mechanism. Free-prose reasons that explain safety inline without naming a function remain valid (regex deliberately excludes "word (parenthetical)"). Marker-truthfulness for a validator that DOES exist but doesn't cover the specific span remains review-enforced (plan-acknowledged design limit).
- Verified: live mutation (marker naming nonExistentValidator()) → MARKER_VALIDATOR_ABSENT exit 1; clean tree exit 0.
- Modified: scripts/checks/check-raw-sql-usage.mjs

### S3 [Minor] span resolver silently skips reassignment-built SQL — FIXED
- Action: resolveArgSpan now returns an UNRESOLVED sentinel (vs null) for a bare-identifier arg it cannot bind to a single backtick literal (reassignment/concat/imported const/fn result); the scanner fails closed (UNRESOLVED_SQL_ARG) instead of silently skipping.
- Verified: live mutation (let sql=...; sql=sql+`...${evil}`) → UNRESOLVED_SQL_ARG exit 1; clean tree exit 0.
- Modified: scripts/checks/check-raw-sql-usage.mjs

### S4 / T2-deviation / R34 — Adjacent, no fix
- S4 (SC3 path-guard): tracked by existing SC3 TODO, informational.
- T2 raceTwoClients vs Deferred barrier: does not weaken test (production FOR UPDATE synchronizes); recorded as deviation.
- R34 (A1 false-tamper): tracked by watermark TODO.

## Resolution Status (Round 2)

### T5 [Major] check-raw-sql-usage.mjs has no permanent regression test — FIXED
- Action: added scripts/__tests__/check-raw-sql-usage.test.mjs (5 cases: UNRESOLVED_SQL_ARG on reassignment SQL; MARKER_VALIDATOR_ABSENT on absent-validator marker; NEGATIVE case — marker naming a PRESENT validator passes, previously unverified even manually; UNMARKED_INTERPOLATION; fully-parameterized call passes). Runs the real CLI via execFileSync against an isolated fixture tree using new RAW_SQL_CHECK_ROOT / RAW_SQL_CHECK_ALLOWLIST env overrides (mirrors STEPUP_GUARD_* convention; defaults unchanged, verified checker still exits 0 on real tree). getSourceFiles now tolerates a missing scan root.
- Modified: scripts/checks/check-raw-sql-usage.mjs (env overrides + missing-root tolerance), scripts/__tests__/check-raw-sql-usage.test.mjs (new)

### S5 [Major] MARKER_VALIDATOR_ABSENT checks validator existence, not invocation-on-tainted-value — ACCEPTED (review-enforced residual)
- Anti-Deferral check: acceptable risk, quantified.
  - Worst case: a contributor adds a genuinely-unsafe ${userInput} interpolation + a decoy function with a validator-shaped name + a marker naming it → passes CI.
  - Likelihood: low — requires BOTH a malicious/careless author AND a git-diff reviewer who reads the marker but does not check the named function is actually called on the value; Layer 1 file-allowlist + the review requirement on any new raw-SQL call site are compensating controls.
  - Cost to fix properly: high and still gameable — a tighter heuristic (require the validator call's args to include the interpolated identifier's name) is AST-free-fragile and defeatable; full dataflow is out of proportion for a lexical CI guard (YAGNI/KISS).
- This is the plan-acknowledged ceiling of the marker mechanism ("Why not validator-adjacency" in C2); the Round-1 S2 hardening closed only the absent-NAME case, exactly as its finding stated. Documented as a RESIDUAL comment at the check site pointing to the C2 residual, and the checker's error message accurately says "does not appear in the same file" (no over-claim). Not a regression — it is the pre-existing ceiling, now partially closed.
- Orchestrator sign-off: acceptable-risk exception satisfied (three values stated); review-enforced per the plan's own C2 framing.

## Resolution Status (Round 3) + Convergence

### S6 [Minor] bare catch on readdirSync swallows non-ENOENT errors (fail-open) — FIXED
- Action: narrowed the missing-scan-root catch to `if (err.code === "ENOENT") continue; throw err;` — a real EACCES/EIO now fails loudly instead of silently skipping a whole scan root (which would make the gate report green having scanned nothing). Introduced by my own Round-2 test-support plumbing; a fail-open branch in a file that fails closed everywhere else.
- Verified BOTH directions: fixture tree without src/ still passes via ENOENT (test-support path intact); real errors rethrow. Full checker exit 0; 5/5 regression tests pass.
- Modified: scripts/checks/check-raw-sql-usage.mjs:66-76

### Convergence (Round 3 → close)
S6's fix is a self-contained mechanical catch-narrowing. Its only interaction — the
fixture-tree ENOENT path the Round-2 test depends on — was verified directly (a
scripts/-only tree still passes without crashing). No new finding surface; Phase 3
converges at Round 3. Total code-review findings across 3 rounds: R1 (5 Minor: F1/F2/S1/S2/S3)
+ R2 (T5 Major fixed, S5 Major accepted-with-rationale) + R3 (S6 Minor) — all resolved
or accepted with recorded justification.
