# Plan Review: overview-pairing-and-reexport-guard
Date: 2026-07-17
Review round: 2 (round 1 log preserved below)

## Round 2 — incremental review of plan revision 2

### Changes from Previous Round
C1 redesigned to one-direction refine; C2 gained pass-ordering, transitive fixpoint, route.ts scope, 7 fixtures; Testing strategy corrected.

### Round-1 finding status
All five merged round-1 findings verified **resolved** by all three experts. The C1 narrowing (two-direction → one-direction) was independently re-derived by the Security expert per R43: rotation rewrites blob+overview+keyVersion atomically for ALL entries (no archived/trash filter, `ENTRY_COUNT_MISMATCH` all-or-fail, `rotate-key-server.ts:275-294,320-336`), and lock ordering (guard FOR SHARE vs rotation FOR UPDATE on users) serializes writers — blob-only writes cannot desynchronize overview. Narrowing justified, not merely asserted.

### New findings (round 2 — all Minor, reflected in plan revision 3)
- **Sec-1 [Minor→resolved]** Named re-export chains at depth ≥2 with distinct aliases per hop were unproven; fixpoint name-registration ambiguity (original name vs post-alias local name). → Plan now mandates registering the re-exporting file's own post-alias export name + fixture 8 (2-hop named chain, distinct aliases).
- **Test-1 [Minor→resolved]** "Blob-only already covered" claim inaccurate at route-unit level (only the integration suite covers it). → Claim corrected; explicit blob-only PUT unit test per route added to C4.
- **Test-2 [Minor→resolved]** No extension-side shape pin for the passkey counter PUT body. → One assertion (`not.toHaveProperty("encryptedOverview")`) added to C4 + extension test run added to Testing strategy.
- Functionality expert: No findings (all round-1 items verified resolved against live code, incl. fixpoint feasibility via existing `getRouteFiles`/`sourceFiles` union).

### Recurring Issue Check (round 2)
- Functionality: R3/R34/R40/R42 resolved-verified; R43 pass (narrowing corrects an incorrect round-1 claim); all others pass/n/a unchanged.
- Security: R43 applied directly (narrowing justified with independently-verified lock/atomicity argument — pass); R42 re-applied to C2's revised design (Sec-1 is an R42-style coverage-claim gap, now closed); RS1-RS6 pass/n/a unchanged.
- Testing: RT7 pass (extended by Test-2, now closed); RT8 pass (non-mutation-on-reject specified); RT4 re-verified (integration contention tests unaffected); all others pass/n/a unchanged.

## Round 3 — convergence check of plan revision 3
All three round-2 reflections verified faithful and complete. Functionality: No findings. Security: No findings (post-alias name-registration rule + fixture 8 verified as asked). Testing: one Minor documentation drift — C4 said "7 red fixtures" vs C2's authoritative list of 8; fixed inline (no behavioral impact). **Converged: contracts C1-C4 locked.**

### Forward-looking observation (informational, out of scope — no action this plan)
The blob-only safety argument depends on rotation's no-filter, all-or-fail entry enumeration remaining unchanged. A future rotation change adding a filter would silently invalidate it; an integration pin (archived entry required in rotation payload) is worth considering in a future hardening pass.

---

# Round 1 log

## Changes from Previous Round
Initial review.

## Merged Findings (Ollama merge-findings + mechanical json join)

### F1 [Critical→resolved in rev.2] C1 refine breaks real passkey flow & integration tests
Perspectives: Functionality (Critical) + Testing (Major) — perspective convergence.
The round-1 two-direction refine rejects `extension/src/background/passkey-provider.ts:278-285` (passkey signature-counter persist: blob-without-overview, a shipped first-party flow) and breaks `src/__tests__/db-integration/key-version-guard.integration.test.ts` (blob-only bodies at 244-248/422-426/494-498 would 400 before reaching the guard).
Resolution: C1 redesigned to a ONE-DIRECTION refine (`encryptedOverview` requires `encryptedBlob`; blob-only stays valid). Safety of blob-only re-verified: the blob branch runs the guard (FOR SHARE) serializing against rotation (FOR UPDATE), and rotation rewrites blob+overview atomically, so overview cannot desynchronize. Round-1 plan's "mirror-image corruption" claim withdrawn as incorrect. Integration suite now passes unchanged; `npm run test:integration -- key-version-guard` added to Testing strategy as proof.

### F2 [Major→resolved in rev.2] C2 export-* resolution lacks multi-hop closure & pass ordering
Perspectives: Security (Major) + Functionality (Minor) — convergence.
`destructiveExportsByModule` is populated only by primitive-calling files; depth ≥3 `export *` chains evade one-hop resolution, and interleaving the scan into the derivation loop false-negatives on scan order.
Resolution: C2 now specifies (i) separate pass after full map build, (ii) transitively-closed lookup iterated to fixpoint, (iii) red fixtures for 3-hop chain and ordering-adversarial barrel.

### F3 [Minor→resolved in rev.2] `export * as ns from` not enumerated
Resolution: C2 detection case (c) + fixture 6.

### F4 [Minor→resolved in rev.2] Test-runner command wrong; fixture isolation discipline
`node --test` does not run the vitest-based checker self-test. Resolution: Testing strategy step 1 rewritten to a single `npx vitest run` invocation; C2 acceptance now mandates single-failure-code isolation per fixture (seedWrapperStubs pattern) with negative stderr assertions.

### F5 [Minor→resolved in rev.2] Scope clarifications (team.ts precedent, route.ts re-export)
Team refine is 4-field/two-direction vs C1's 2-field/one-direction → C1 requires an explicit code comment stating the deliberate difference. Re-export hosted inside route.ts was invisible to both scans → C2 re-export pass scope extended to include route.ts (fixture 7).

## Quality Warnings
None (merge-findings quality gate: no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags).

## Local LLM pre-screening disposition
One pre-screen finding ("refine must pair a separate `encryptedOverviewIv` field") REJECTED: `overviewIv` is a DB column; request shape is nested `encryptedOverview {ciphertext,iv,authTag}`; Zod strips unknown keys. Rejection independently confirmed by the Functionality expert.

## Recurring Issue Check

### Functionality expert
- R3: finding-ref F1 (unpaired-shape pattern not fully propagated across all consumers)
- R5, R17, R34: pass. R40: subsumed by F1. R42: finding-ref F1 (consumer member-set incomplete — extension passkey PUT omitted); overview-column-writer member-set independently re-verified complete.
- All other R1-R44: pass or n/a.

### Security expert
- R42: applied — F2 is an R42-style class-membership issue on C2's own coverage. R43: pass (plan strictly narrows). RS3: satisfied (boundary validation is the fix itself). RS5: n/a (keyVersion/aadVersion already bounded by existing schema).
- All other R1-R44 + RS1-RS6: pass or n/a.

### Testing expert
- R34: related F1 — integration-test cost folded into C4 (not deferred). R42: satisfied for C1 writer set; F1 was the analogous test-body gap.
- RT2/RT5/RT6/RT8: satisfied by plan (RT8 pattern exists at route.test.ts:807-810, 934-936). RT7: addressed by C4, refined by F4.
- All other R1-R44 + RT1-RT9: pass or n/a.

## Resolution Status (round 1 → plan revision 2)
All five merged findings reflected in plan revision 2 (C1 redesign, C2 ordering/transitivity/scope/fixtures, C3 unchanged, C4 expanded, Testing strategy corrected). No Skipped/Accepted/Deferred entries — no Anti-Deferral records required this round.
