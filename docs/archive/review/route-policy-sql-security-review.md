# Plan Review: route-policy-sql-security
Date: 2026-07-04
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
## Findings

**F1 — Severity: Major.** Raw-SQL member-set recompute yields 29 files, not 28; file-category breakdown also diverges from the plan's stated split.

Problem: Plan §C2 "Member-set derivation (R42)" states the command yields "28 members (12 API route files + 2 src/app/s files + src/auth.ts + 8 src/lib files + 3 src/workers files + 2 scripts/ files)". Re-running the exact command produces **29** files: 13 API route files (not 12) + 2 src/app/s + 1 src/auth.ts + 8 src/lib + 3 src/workers + 2 scripts = 29.

Impact: C2's acceptance criterion is "every file... MUST appear in raw-sql-usage.txt". If the initial raw-sql-usage.txt is seeded from the stale 28-item inventory, the check will fail immediately on the missing 13th route file, or silently under-cover the surface.

Recommended action: Re-run the member-set derivation at implementation start and use the freshly computed 29-file set, not the 28-file count baked into the plan text.

Evidence: grep command re-run → wc -l = 29. 13 route.ts files under src/app/api/, including src/app/api/passwords/[id]/attachments/[attachmentId]/migrate/route.ts and src/app/api/passwords/[id]/attachments/route.ts — both counted separately, likely the source of the 12-vs-13 miscount.

**F2 — Severity: Major.** sideEffectingGet member-set recompute yields 4 members, not the 3 claimed, due to a false-positive match in the plan's own detection regex — and the plan does not document how to adjudicate it.

Problem: Plan §C1 claims "3 members". Running the plan's own write-primitive regex against all GET-only route files also matches src/app/api/watchtower/hibp/route.ts:84 — cache.delete(k), a plain in-memory Map.delete, not a Prisma write. Genuine false positive of the mechanical pattern the plan proposes as assertion 7's CI floor.

Impact: If assertion 7 is implemented literally, the parity test fails on watchtower/hibp/route.ts at implementation time, forcing an unplanned decision.

Recommended action: Either (a) tighten the assertion-7 regex to require a Prisma Client receiver shape (prisma., tx., or imported model accessor) to exclude Map/Set/plain-object .delete(, or (b) add watchtower/hibp to an explicit inline exemption list with reason ("in-memory cache eviction, not a DB write"). Correct plan text to acknowledge 4 raw hits with 1 adjudicated-clean.

Evidence: src/app/api/watchtower/hibp/route.ts:84: `if (v.expiresAt < now2) cache.delete(k);` — cache is new Map<string, CacheEntry>() declared at line 21, not a Prisma model.

**F3 — Severity: Major.** C1 assertion 8's "allowlisted stub" premise for dcr-cleanup is factually wrong — the route is NOT exempt from the maintenance auth pattern; it satisfies both required calls exactly like the other 5 maintenance routes.

Problem: Reading src/app/api/maintenance/dcr-cleanup/route.ts, both verifyAdminToken(req) (line 36) and requireMaintenanceOperator(auth.subjectUserId, {...}) (line 52) are present and called before the 410 response — fully-authenticated stub, not auth-bypassed.

Impact: Implementer would build infrastructure for a non-existent exemption; risks accidentally loosening the check if the exemption bypasses more than intended.

Recommended action: Drop the "allowlisted stubs" exemption path from assertion 8 entirely; current 6/6 maintenance routes all match the pattern with no exemption required.

Evidence: src/app/api/maintenance/dcr-cleanup/route.ts:36 (verifyAdminToken), :52 (requireMaintenanceOperator) — both present, matching all 5 other maintenance routes' pattern (confirmed via grep across all 6 files).

**F4 — Severity: Major.** C6/C7/C8's guard mechanism ("required-headings entry added to check-security-doc-exists.sh") assumes a data-driven, multi-document extension point that does not exist — the script is single-purpose, hardcoded to exactly one file (audit-anchor-verification.md) and one inline heading array, with no loop, no config, no per-doc parameterization.

Impact: Implementing three "entries" without first refactoring the script requires either copy-pasted blocks or an unplanned mid-implementation refactor. Neither path is specified.

Recommended action: Add an explicit sub-contract specifying the refactor: generalize check-security-doc-exists.sh into a loop over an array of {doc path, required heading list} tuples (optionally externalized to a JSON/txt config mirroring the C2 pattern), then add each new doc as one entry.

Evidence: scripts/checks/check-security-doc-exists.sh lines 1-71 — hardcoded DOC= (line 10), single required_headings=(...) array (lines 28-35), no iteration, no config input.

**F5 — Severity: Minor.** C1's consumer-flow walkthrough omits the route-class-patterns.json consumer set (check-permanent-delete-stepup.sh via jq, check-raw-sql-usage.sh, parity test) — the walkthrough covers only route-policy-manifest.json's 3 consumers.

Recommended action: Add a one-line consumer-flow entry for route-class-patterns.json alongside the existing manifest walkthrough so both machine-readable artifacts get equal contract-completeness treatment.

Evidence: plan "Verification method per field" section (pattern-file consumers) vs Consumer-flow walkthrough section (manifest-only) — two different consumer lists for two different files, not merged.

## Recurring Issue Check
### Functionality expert
- R1: Checked-clean — plan reuses existing check-bypass-rls.mjs / aad-scope-manifest.json patterns; confirmed present.
- R2: Checked-clean — patterns centralized into route-class-patterns.json.
- R3: Applicable — see F3 and F2; propagation-shaped gaps in a defining primitive reused across three checks.
- R4-R16: N/A (no event dispatch, no new read-write logic, no cascade, no E2E/UI, no fire-and-forget, no circular imports [route-policy.ts explicitly avoids importing cors-gate.ts], no display/subscription grouping, no new enums, no delivery loops, no DB role grants, no migrations, no dev/CI privilege assertions in this plan).
- R17: N/A — no new shared helper; reuses classifyRoute/isBearerBypassRoute.
- R18: Checked-clean — DELETE_SIGNAL move to route-class-patterns.json preserves behavior; current regex in script matches plan's claimed re-derivation exactly.
- R19: N/A — no existing mocked module changes.
- R20: N/A — no mechanical multi-line insertion.
- R21: N/A — plan-review round.
- R22: N/A — no shared-helper migration.
- R23-R28: N/A — no UI changes.
- R29: Checked-clean — no external spec citations in plan.
- R30: Checked-clean — no bare autolink-prone tokens.
- R31: N/A — no destructive operations executed by plan.
- R32: N/A — no new long-running runtime artifact.
- R33: N/A — plan explicitly verifies CI wiring (C3).
- R34: Applicable [Adjacent] — C4's A1-A3 are pre-existing patterns in sibling worker files; plan tracks them as candidates (satisfies R34); final severity is Security's call.
- R35: N/A — no deployment-artifact changes.
- R36-R41: N/A / Checked-clean (no suppressions, no user-facing strings, no async state machine, no zeroization surface, no cross-boundary strict decoder, R41 checked-clean: manifest capability backed by concrete test contract).
- R42: Applicable — see F1 (raw-SQL 29 vs 28), F2 (sideEffectingGet 4 vs 3), F3 (dcr-cleanup premise false). Destructive (9), maintenance (6), route universe (212) recomputes matched exactly.

## Security Findings
## Findings

**S1 — Major — Maintenance-class definition excludes structurally-identical privileged routes outside /api/maintenance/**

C1 assertion 8 defines maintenance ⇔ path prefix src/app/api/maintenance/. The /api/admin/rotate-master-key/** routes use the exact same auth gate (verifyAdminToken + requireMaintenanceOperator) and classifyRoute() puts them in api-default. Path-prefix-only derivation means: (a) assertion 8's check never runs against them; (b) C5's matrix silently omits them from the maintenance row-class despite being the highest-privilege destructive-adjacent surface (dual-approval master-key rotation); (c) C6/C8 docs reference "maintenance routes" as a closed set.

Impact: A future regression dropping requireMaintenanceOperator( from an admin/rotate-master-key handler is not caught by the parity test — exactly the "control-plane drift between parallel paths" risk the plan names as the central threat. Direct instance of R42 clause ① (member-set anchored on assumed path-prefix instead of the defining auth primitive).

Recommended action: Define the class by the auth-primitive grep (requireMaintenanceOperator( AND verifyAdminToken( co-occurring in a route.ts), or explicitly enumerate /api/admin/rotate-master-key/** as members of a shared "operator-gated" class in the manifest and matrix.

Evidence: src/lib/proxy/route-policy.ts:171-175; src/app/api/admin/rotate-master-key/initiate/route.ts:15,27,116,155 vs src/app/api/maintenance/purge-audit-logs/route.ts:17,24,90,111 (identical pattern); plan maintenance class defined by path + ls only.
escalate: false

**S2 — Major — Destructive-class DELETE_SIGNAL grep is route.ts-scoped and structurally blind to the retention-gc worker's hard-delete of the same rows (R42 clause ③)**

src/workers/retention-gc-worker/sweep.ts:533,541 performs tx.teamPasswordEntry.deleteMany / tx.passwordEntry.deleteMany — the identical hard-delete primitives defining the destructive class — but check and manifest are scoped to src/app/api/**/route.ts. The plan documents the analogous page.tsx exclusion for C1 but not the worker-delete exclusion.

Recommended action: Add an explicit note to C1 (manifest header or plan text) that the destructive-class member-set is route-file-scoped by construction, cross-referencing that retention-gc worker hard-deletes of the same tables are covered by C5's Deletion/Retention Matrix + C4's worker review — documented design decision rather than silent gap.

Evidence: src/workers/retention-gc-worker/sweep.ts:533,541; plan destructive grep --include=route.ts; existing documented exclusion for page.tsx with no analogous worker note.
escalate: false

**S3 — Major — Raw-SQL allowlist file-level granularity leaves room for a new dangerous call site to hide in an already-allowlisted high-fanout file (residual risk not acknowledged)**

check-bypass-rls.mjs precedent implements per-call-site/per-model granularity (SCAN_RADIUS). C2 is file-level: audit-outbox-worker.ts (~24 call sites) and sweep.ts (~18) each sit under a single line. A future PR adding one more raw call — even interpolating unvalidated input — passes C2 silently once the file is listed. C2's acceptance criteria only test "unlisted file → fail".

Recommended action: Either (a) per-call-site granularity for high-density files, or (b) explicitly document the accepted residual risk with a stated compensating control — the C2 Forbidden-patterns template-literal regex (\$executeRawUnsafe with ${) catches the Unsafe-interpolation shape regardless of allowlist status, IF implemented as a per-line scan not gated on the file being unlisted. Verify that compensating control fires per-line.

Evidence: scripts/checks/check-bypass-rls.mjs:16-21; plan C2 file-level path # purpose; sweep.ts:180,217,317,404 (template-interpolated DELETE FROM ${entry.table}).
escalate: false

**S4 — Major — jq missing-key fallback in the shared-pattern consumer is fail-open, not fail-closed**

Verified empirically: jq -r '.deleteSignal' on valid JSON missing the key returns literal "null" with exit code 0. check-permanent-delete-stepup.sh runs set -euo pipefail (line 57) which only traps non-zero exits; a null DELETE_SIGNAL makes grep search for literal "null", silently changing the destructive member-set derivation instead of crashing. (Fully malformed JSON exits non-zero — fine; missing-key is the gap.)

Impact: A key rename (deleteSignal → deleteSignals) without updating both consumers silently disables step-up enforcement detection instead of failing CI.

Recommended action: Use jq -er (sets exit status on null/false output) in every jq-based consumer of route-class-patterns.json, so missing keys fail closed under set -e.

Evidence: empirical test (echo '{}' | jq -r → "null", exit 0); check-permanent-delete-stepup.sh:57; plan shared pattern-file consumption via jq -r.
escalate: false

**S5 — Minor — C6/C7/C8 freshness guards check heading structure only, not content truth, for safety-critical semantic claims (A1 decision)**

Heading-only grep -qF cannot detect stale content. If a later PR changes audit_log_purge semantics without updating the threat-model doc's Retention-purge interaction section, the guard passes while the documented claim is false — misleading an incident responder during exactly the anti-forensics scenario A1 addresses.

Recommended action: No mechanical fix required now (plan already assigns content accuracy to Phase 3 human review) — add a lightweight cross-reference comment near the audit_log_purge SQL function or retention-gc registry entry pointing back to the doc section, so future code reviewers are nudged to update the doc.

Evidence: scripts/checks/check-security-doc-exists.sh:36-51; plan C8 acceptance criteria; plan testing strategy ("content accuracy is verified in Phase 3 review").
escalate: false

**S6 — Minor — Bare #9 reference in the plan's scope-contract table (R30 autolink footgun)**

Plan SC1 row contains "assessment target #9" — bare #<number> autolinks on GFM surfaces.

Recommended action: Wrap in backticks or reword to "assessment target 9".

Evidence: docs/archive/review/route-policy-sql-security-plan.md SC1 row.
escalate: false

## Recurring Issue Check
### Security expert
- R1-R9: N/A — static-check/manifest/doc infrastructure only.
- R10-R13: N/A.
- R14-R16: N/A — no new DB role/grant changes proposed.
- R17, R22: Partially applicable — checked (S3): C2 reuses .sh allowlist convention vs more granular check-bypass-rls.mjs pattern; granularity gap flagged, not missing-adoption.
- R18: Checked — C1/C2 are themselves new allowlist mechanisms; S1-S3 cover their completeness.
- R19-R21: N/A.
- R23-R28: N/A.
- R29: Checked — no external spec citations with section numbers in the plan. No violation.
- R30: Checked (S6) — bare #9 found, Minor.
- R31: Checked — C4 process requires impact analysis before security-sensitive fixes; no violation.
- R32: N/A — no new long-running artifact.
- R33: N/A — single-path pre-pr registration (but see Testing expert for STATIC_ONLY placement).
- R34: Checked — A1-A3 adjudication mechanism satisfies Anti-Deferral; 30-minute rule stated.
- R35: N/A.
- R36-R41: N/A.
- R42: Central to this review — re-derived all class member-sets (destructive 9/9 reproduced; side-effecting-GET 3 true + 1 grep false-positive; raw-SQL reproduced). Clause ③ failures: S2 (worker hard-deletes invisible to route-scoped grep), S1 (admin routes structurally identical to maintenance class excluded by path-prefix derivation). Symmetric-counterpart checked: no personal/team mirror gap in side-effecting-GET or destructive classes.
- RS1: N/A — no credential comparison code.
- RS2: N/A — no new API route.
- RS3: N/A — no new request-parameter validation.
- RS4: Checked — plan file grepped for emails/handles; no PII (S6's #9 is assessment numbering, flagged under R30).
- RS5: Checked — no externally-supplied crypto/authz parameter introduced; N/A to this class of change.

## Testing Findings
## Findings

**T1 — Critical — C1 assertion 3 regex does not match all route export styles; two files would fail the parity test or force an undocumented special-case**

Plan assertion 3 regex `export (async function|const) (GET|POST|PUT|PATCH|DELETE)` misses 2 of 212 route files using non-async `export function GET() {`:
- src/app/api/health/live/route.ts:5
- src/app/api/mobile/.well-known/apple-app-site-association/route.ts:31

Impact: false failures on a correct manifest, or undocumented ad-hoc regex tweak during implementation (RT1 mock-reality analog: the plan's written contract is wrong on 2 real files).

Recommended action: make `async ` optional in the regex: `export (async )?(function|const) ...`; re-verify the full 212-file universe with the corrected regex (arrow exports, re-exports, multi-line signatures).

Evidence: the two files above; plan line ~125.

**T2 — Major — C2/C5 pre-pr registration placement (STATIC_ONLY-gated vs ungated) unspecified — risk of a check that exists in pre-pr.sh but never runs in CI's static-checks job (RT7(b) authored-but-ungated)**

pre-pr.sh structural split: lines 158-170 unconditional run_step for .sh checks (what CI static-checks executes via PRE_PR_STATIC_ONLY=1); vitest/build gated behind `if STATIC_ONLY != 1`. check:env-docs (line 182) — the exact precedent for C5's drift check — is registered UNGATED. The plan never states which side of the gate the new run_steps land on. If C5's drift check (tsx/generator-based, "feels like" the vitest category) is nested inside the STATIC_ONLY guard, it silently never runs in CI.

Recommended action: C3 acceptance criteria must state exact insertion section (ungated, alongside check:env-docs) for BOTH the C2 run_step and the C5 drift-check run_step, and require proving execution under `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` output (grep for the new check names), not just full-mode.

Evidence: scripts/pre-pr.sh:158-170, :176, :182; .github/workflows/ci.yml "Run static check guards (PRE_PR_STATIC_ONLY)" step; plan C3/C5 sections lack placement.

**T3 — Major — RT7 manual mutation-verification specified only as "verified once manually" with no artifact or record location — unverifiable/unfalsifiable claim**

C1 (plan line ~178) and C2 (~214) fail-path proofs have no defined record. No route-policy-sql-security-manual-test.md exists.

Recommended action: name the concrete mutation for each (C1: delete the vault/reset entry from the manifest → run parity test → confirm failure names path → revert; C2: add $queryRawUnsafe to an unlisted file → check exits 1 naming file → revert) and record pass/fail transcripts in the plan's manual-test notes file.

**T4 — Major — C5 determinism claim has no automated test named; drift-check (committed-vs-regenerated) is NOT a run-twice determinism test**

Committed-file drift check detects "docs changed" drift, not cross-machine nondeterminism (unstable key iteration could match committed output by chance on one machine, differ in CI → intermittent drift failures). Precedent scripts/generate-env-example.ts:156-160 documents explicit .sort() strategy — C5 should mirror.

Recommended action: add scripts/__tests__/generate-security-matrices.test.mjs (vitest include glob covers scripts/__tests__/**/*.test.mjs) invoking the generator twice in-process asserting byte-identical output; document order-stability of each data source (manifest JSON key order, Prisma.dmmf declaration order) as code comments.

**T5 — Minor — RT6 gap: generate-security-matrices.ts ships with no content-correctness test (determinism alone passes even if every row is wrong the same way twice)**

Recommended action: one unit test asserting a known registry-managed model produces the expected row shape and a known non-registry model appears in the "no automated purge" bucket.

**T6 — Minor — Two-tier sideEffectingGet invariant has no re-check cadence for the review-enforced remainder**

Recommended action: consider running the consume|redeem|markUsed sweep as an advisory (warn-only) part of the CI check so growth is visible, rather than relying purely on future manual review.

## Recurring Issue Check
### Testing expert
- R1-R2: N/A — plan consolidates regex patterns into route-class-patterns.json.
- R3: N/A for testing scope.
- R4-R6: N/A.
- R7: N/A — no E2E selector changes.
- R8: N/A.
- R9-R13: N/A.
- R14-R16: N/A — no new roles/migrations added by this plan.
- R17, R22: N/A — no new shared helper mandated.
- R18: N/A — C2's allowlist is new, not a migration.
- R19: N/A — new self-contained test only.
- R20-R21: N/A.
- R23-R28: N/A.
- R29-R30: N/A.
- R31: N/A.
- R32: N/A — no new long-running artifact.
- R33: Applies — see T2 (PRE_PR_STATIC_ONLY placement ambiguity = one-config-path-not-verified pattern).
- R34: N/A — A1-A3 framed as adjudication candidates with defined process.
- R35: N/A — no deployment artifacts.
- R36-R41: N/A.
- R42: Applies — plan performs derivation; see T6 for missing re-check cadence on review-enforced remainder.
- RT1: Applies — found. See T1 (Critical): export regex misses non-async form in 2 of 212 files.
- RT2: Applied throughout — all recommendations verified against vitest include globs / db-integration harness before proposing.
- RT3: N/A.
- RT4: N/A now; forward-looking condition on C4's A2 regression test (must assert both branches occurred).
- RT5: Applies — no present finding; existing db-integration worker tests call real worker modules (good precedent); condition on C4 fixes (test must exercise the real primitive call site).
- RT6: Applies — found. See T5 (Minor).
- RT7: Applies — found. See T2 (shape b) and T3 (unrecorded fail-path proof).
- RT8: N/A for C1-C9 deliverables; forward-looking condition on C4 fixes.

## Adjacent Findings
- F (R34, [Adjacent]): C4's A1-A3 adjudication candidates are pre-existing patterns in sibling worker files; plan tracks them as candidates (satisfies R34); final severity adjudication routed to Security expert during C4 execution.

## Quality Warnings
None flagged by merge quality gate (local LLM merge produced no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM tags; all findings carry file:line evidence).

## Merge Note
Local LLM merge-findings (gpt-oss:120b) found no cross-expert duplicates; findings preserved per-expert verbatim. Perspectives tags: T1 Testing; F1-F5 Functionality; S1-S6 Security; T2-T6 Testing.

---

# Plan Review Round 2 (2026-07-04)

## Changes from Previous Round
All 17 Round-1 findings applied: assertion-3 regex async-optional (T1); raw-SQL member set corrected to 29 (F1); assertion-7 receiver-shape regex + hibp adjudication + consume/redeem/markUsed floor (F2+T6); operatorGated class replacing maintenance flag (F3+S1); check-security-doc-exists.sh data-driven refactor prerequisite (F4); patterns-file consumer walkthrough (F5); worker-delete class-boundary exclusion note (S2); two-layer C2 (S3); jq -er fail-closed (S4); C8 cross-reference comments (S5); autolink fix (S6); PRE_PR_STATIC_ONLY placement contract (T2); manual-test artifact with named mutations (T3); determinism + content-correctness tests (T4+T5).

## Functionality Findings (Round 2)
## Functionality Round 2

F1: resolved. F2: resolved. F3: resolved (sibling gap F6). F4: resolved. F5: resolved.

**F6 (Major, new in round 2): assertion 8a's path floor is unsatisfiable for src/app/api/admin/rotate-master-key/route.ts; the 10-member operatorGated set silently excludes it.**
find src/app/api/admin -name route.ts returns 5 files, not 4 — the base rotate-master-key/route.ts is a legacy single-actor 410 Gone stub with "no auth check (the 410 itself is the answer)" per its own doc comment; contains neither verifyAdminToken( nor requireMaintenanceOperator(. 8a forces operatorGated: true on it; 8b then fails. The plan's "both directions verified" claim omitted this 5th admin route.
Suggested resolution: allow explicit `operatorGated: false` + `handlerAuthReason` (410-stub-needs-no-auth rationale) satisfying 8a's floor via documented declaration, keeping the invariant machine-checked. (Or carve out Gone-stub pattern from the floor.)

**F7 (Minor, new in round 2): stale `maintenance` field references** — Consumer 1 walkthrough field list ({...sideEffectingGet, maintenance}) and Technical approach "destructive / maintenance / side-effecting-GET member-sets" not renamed to operatorGated.

**F8 (Minor, new in round 2): dcr-cleanup citation drift** — plan cites route.ts:36,52; current file (modified by P1 session) has verifyAdminToken at 29, requireMaintenanceOperator at 40. Assertion is grep-based so harmless; make citation symbol-based, not line-based.

Recurring Issue Check: enumerate-completeness feedback newly applies (F6 = enumeration anchored on expectation not `find`); all others unchanged from Round 1.

## Security Findings (Round 2)
## Security Round 2

S1: resolved (admin/ contains only rotate-master-key today per agent's grep of requireMaintenanceOperator — NOTE: functionality F6 found a 5th no-auth 410 stub file the auth-primitive grep cannot see). S2: resolved. S3: partially → S7. S4: resolved (jq -er verified empirically; empty-string case covered by parity-test non-empty assertion). S5: resolved. S6: resolved.

**S7 (Major, new in round 2, escalate: true) — raw-sql-ident marker anchors don't match source; marker mechanism unconstrained**
1. Factual mismatch: plan says "4 sites: sweep.ts:187,225,273,316,403 region" — those are the CALL lines; actual ${...} interpolations sit at ~12 lines across 5 functions (180,182,183,217,219,220,274,275,317,404,406,408; sweepTrashEntry:473 hardcodes literals). Marker-per-line placement from stale numbers under/mis-covers.
2. No precedent for inline markers: check-bypass-rls.mjs uses an EXTERNAL centralized allowlist, not inline comments. A bare marker can bless a genuinely-unsafe interpolation in the same commit with any freeform reason; nothing ties it to proof the value passed assertIdentifier. A refactor removing assertIdentifier but leaving the marker passes CI.
Recommendation: (a) marker must cite the validator; check greps preceding N lines (SCAN_RADIUS-style) for the literal validator call — "marker + provable adjacency"; or (b) external allowlist keyed by file+range+validator; or (c) ≥10-char reason + human confirmation at C4.

**S8 (Minor, new in round 2)** — SC6 TODO in test header needs mechanical tripwire: include the exact post-P1-merge grep in the TODO text.

**S9 (Minor, new in round 2)** — verb-lexical floor (consume|redeem|markUsed) is gameable by renaming; plan's two-tier "detection floor" honesty language already covers this accurately; no change requested.

No control weakened by any Round 1 fix (jq -er strengthens; operatorGated is a strict superset; C2 layer 2 is additive).

Recurring Issue Check: S3 → carried forward as S7 (Major); all others unchanged from Round 1.

## Testing Findings (Round 2)
T1-T6: all resolved (T1 regex re-verified 212/212 match; T6 verb-floor grep returns zero current hits, no exemption pre-seed needed).

**T7 (Major, new in round 2)**: layer-2 marker matching unit unspecified (per-physical-line vs template-span; sweep.ts interpolations sit 1-5 lines from the RawUnsafe( token) and site count internally inconsistent (says 4 sites, lists 5 line numbers). A naive line-based checker would never fire on the real multi-line sites — the compensating control silently not compensating.
**T8 (Minor, new in round 2)**: marker STALE direction unspecified — orphaned markers must fail (strict pairing), else a marker budget masks future unmarked interpolations.
**T9 (Minor, new in round 2)**: A2 regression-test shape unspecified (concurrency-shaped; needs raced-transactions design without sleeps, RT4 both-branches guards).

## Round 2 Resolutions (applied to plan)
- F6 → operatorGated now requires EXPLICIT true/false declaration under the path floor; false requires >=10-char handlerAuthReason; admin/rotate-master-key/route.ts (no-auth 410 legacy stub, 5th admin file) declared false. Member-set derivation now dual (auth-primitive grep 10 files + path-floor find 11 files, delta adjudicated).
- F7 → both stale maintenance-flag references renamed operatorGated.
- F8 → dcr-cleanup citation made symbol-based (file being edited on P1 branch).
- S7+T7+T8 → layer-2 redesigned: span-based matching (backtick-span tracking), check reimplemented as check-raw-sql-usage.mjs (Node; jq removed for this consumer), strict two-way pairing with centrally-declared ident-markers=N in raw-sql-usage.txt, marker reason >=10 chars naming the validation mechanism; validator-adjacency grep explicitly rejected (sweep.ts validates at boot via validateRegistry(), not lexically adjacent); marker counts seeded from fresh span-scan (R42 refresh). Fail-path proof (4) added for orphaned markers.
- S8 → SC6 TODO embeds the mechanical post-P1 grep.
- S9 → no change requested (detection-floor honesty language confirmed accurate).
- T9 → A2 test shape committed in C4 (Promise.all-raced transactions, exactly-one-emits assertion, RT4 both-branches guards, no sleeps).

---

# Plan Review Round 3 (2026-07-04) — convergence

## Changes from Previous Round
All 9 Round-2 findings applied (operatorGated explicit true/false declaration; layer-2 span-based .mjs redesign with strict two-way pairing; stale references; citation symbol-based; SC6 mechanical TODO; A2 test shape).

## Functionality (Round 3)
F6/F7/F8: resolved (verified live: path-floor find = 11 files, auth-primitive greps = 10 files, delta = the no-auth 410 stub; 8a/8b/8c has no unsatisfiable case; no stale flag references; layer-2 redesign functionally coherent). No new findings.

## Security (Round 3)
S7: core redesign resolved; residual downgraded to Minor — absent ident-markers suffix default unspecified (fail-open risk (b) reading possible). S8: resolved. F6-resolution consistency: confirmed (false+reason has same mechanically-required/semantically-reviewed shape as handlerAuthReason and BYPASS_PURPOSE precedents; single-commit blast radius equivalent to accepted check-bypass-rls.mjs residual). No S10.

## Testing (Round 3)
T7/T8/T9: resolved (pre-pr .mjs registration form verified byte-for-byte against existing check-bypass-rls.mjs run_step lines in the ungated region). T10-a (Minor): fail-path mutation (3) must be multi-line to prove span logic.

## Round 3 Resolutions (applied to plan, verbatim from expert recommendations)
- S7 residual → explicit fail-closed default: absent ident-markers suffix ⇒ N=0; 5th RT7 fail-path scenario added (marker+interpolation with suffix-less txt entry → exit 1).
- T10-a → mutation (3) now requires a backtick template spanning >=2 physical lines, with rationale (single-line would pass under a regressed line-based matcher).

## Convergence Note
Functionality returned No findings in Round 3. Security and Testing residuals were editorial spec-completeness additions adopted verbatim from the experts' own recommended wording; presence verified by the orchestrator (grep). Plan review closed at Round 3; all 9 contracts flipped to locked in the Go/No-Go gate.
