# Plan Review: close-coverage-and-clipboard-gaps
Date: 2026-11-22
Review round: 1

## Changes from Previous Round
Initial review

## Merged findings (manual dedup; Ollama merge skipped)

| Merged ID | Sources | Severity | Class | Subject | Disposition |
|---|---|---|---|---|---|
| M1 | func F1, test T1 | Major | design | Member-set pathspec misses top-level src files | Plan C1: `:(glob)` pathspec + positive controls |
| M2 | func F7, test T2, T3 | Major | design | C1 matcher/authority/red-proof clauses | Plan C1 rewritten: vitest picomatch, pure split, per-clause red-proofs, json-summary key check in app-coverage |
| M3 | func F10, test T4, sec F10 | Major | prose | Derived numbers did not re-derive | Re-derived with replacement config; prose corrected |
| M4 | test T5, T16 | Major | design | 60 floor vs 65 target; red-proof path | C3 target >=65; C2 red-proof via shard+merge, exit code |
| M5 | test T6 | Major | design | No bar against decorative tests | C3 quality bar: AST scan, mutation ledger, orchestrator re-run |
| M6 | test T7, sec F9 | Major | design | Security dirs only under 60 floor | C2b glob ratchets + per-file branch floors, deny-arm tests |
| M7 | test T8 | Major | design | Type-only modules count the directive | C3: drop directive |
| M8 | test T10 | Major | design | Extraction w/o characterization | C3: characterize before extract, name E2E |
| M9 | test T11 | Major | design | Mocked Prisma/Redis | C3 per-module strategy + named integration proof |
| M10 | func F2, test T12, sec F3, F4 | Major | design | ESLint block layout + selectors + self-test | C4 lint layout rewritten |
| M11 | func F3, F4 | Major | design | Post-create copy fallback + outcome mapping | C4 post-create contract rewritten; grant-card dead copy removed |
| M12 | func F5, sec F8 | Major | design | Fourth unlock mapping; no-leak assertions | C6 member set 4; sentinel tests |
| M13 | func F6, sec F7, func F13 | Major | design | C7 fix approaches; reveal timer test | C7 approaches specified + tests |
| M14 | test T9, func F9 | Major | design | Generator unmount timer unfalsifiable | Dropped from C10 (no observable defect) |
| M15 | sec F2, F1 | Minor | prose/design | Auto-clear best-effort; manual copy residual | R-4 reworded; C4b retry-on-focus clear |
| M16 | sec F5 | Minor | design | v8 ignore comments bypass floor | C2c zero-count lint |
| M17 | func F11, test T15, sec F6 | Minor | design | Vacuous forbidden pattern | Removed; C1 asserts include deep-equals |
| M18 | func F8 | Minor | design | C8 hooks rule | Extract ProtectedDownloadButton |
| M19 | func F12, test T14 | Minor | prose | CI budget | Measure both jobs; 4-shard rule |
| M20 | test T13 | Minor | design | C7 wiring + setTimeout | pre-pr.sh step; exclusions |
| M21 | test T17 | Minor | design | Page test bar | Technical approach |
| M22 | test T18 | Minor | design | Root proxy.ts / instrumentation-client.ts | Added to C1 scope |

## Adjacent Findings
- func F9, F13 (testing scope) — folded into M14, M13.

## Quality Warnings
None flagged.

## Recurring Issue Check
### Functionality expert
R1 F6; R2 ok; R3 F5,F9; R4-R6 N/A; R7 ok; R8 F4; R9 N/A; R10 ok; R11-R16 N/A; R17 F5; R18 F2; R19 N/A; R20-R21 N/A; R22 ok; R23-R24 N/A; R25 F6; R26-R28 N/A; R29 F1,F7,F10; R30-R32 N/A; R33 F12; R34 F3; R35 ok; R36 ok; R37 ok; R38-R40 N/A; R41 F3; R42 F1,F5,F9; R43-R44 N/A; R45 ok; R46 N/A; R47 F7; R48 F5; R49 ok; R50 F7; R51 N/A; R52 ok; R53 ok; R54 N/A; R55 ok; R56-R57 N/A.
### Security expert
R1 ok; R2 ok; R3 ok (F1 manual path); R4-R6 N/A; R7 ok; R8 ok; R9 N/A; R10 ok; R11-R16 N/A; R17 ok; R18 N/A; R19 ok (F8); R20-R21 N/A; R22 ok; R23-R24 N/A; R25 ok; R26-R28 N/A; R29 F10; R30-R32 N/A; R33 ok; R34 F2; R35 N/A; R36 F3; R37 ok; R38 N/A; R39 F2,F7; R40-R41 N/A; R42 ok re-derived; R43-R44 N/A; R45 ok; R46 ok; R47 F4; R48 ok; R49 F2,F5,F6; R50-R51 N/A; R52 ok; R53 ok (F9); R54-R57 N/A; RS1-RS3 N/A; RS4 ok; RS5-RS6 N/A.
### Testing expert
R1 ok; R2 ok; R3 ok(T12); R4-R6,R9,R11-R16,R24,R25,R32,R35,R38,R39,R40,R51,R54,R56,R57 N/A; R7 T10; R8,R23,R26-R28,R37 N/A; R10 ok; R17 ok; R18 N/A; R19 T11; R20 N/A; R21 T6; R22 N/A; R29 T4,T14; R30 N/A; R31 ok; R33 T14; R34 ok; R36 ok; R41 N/A; R42 T1,T4; R43 N/A; R44 T16; R45 ok; R46 N/A; R47 T2; R48 ok; R49 ok; R50 T2,T4; R52 T7; R53 T5,T7; R55 ok; RT1 T11; RT2 ok; RT3 ok; RT4 N/A; RT5 T6,T11; RT6 ok; RT7 T3,T9,T12,T16; RT8 T11; RT9 ok; RT10 T2,T12,T13; RT11 ok.

## Raw expert findings
## Functionality expert — Round 1
F1 Major design: member-set pathspec misses top-level src files (1112 vs 1116).
F2 Major design: eslint block 1 has no ignores; clipboard/toast restriction there flags src/lib/clipboard + tests. New src block with ignores between block1 and block2; add to block 2 too; document order.
F3 Major design: create-grant fallback relies on grant-card copy path unreachable (GET /api/emergency-access never returns token, route.ts:169). Show created URL inline with CopyButton; remove dead handleCopyLink.
F4 Major design: reportCopyOutcome non-OK toasts error, contradicting "created, link not copied"; team-invite UX regresses. Branch outcome locally; close/onCreated always after POST success; mention 30s clear.
F5 Major design: fourth unlock-error mapping in team-create-dialog.tsx:79-96; type lockedUntil param nullable; keep passphrase-not-cleared on sessionExpired.
F6 Major design: C7 ref approach breaks use-sidebar-sections-state hydrate-then-update ordering; deleteNotification useCallback([]) stale closure. Persist in effect after hydration; test hydrate+functional update. entry-history: follow useRevealSet timersRef (manual hide does not cancel timer today).
F7 Minor design: C1 matcher is isIncluded/getGlobMatchers pm(include,{dot:true,ignore:exclude}) with vitest's picomatch 4.0.7; config object not as vitest loads it.
F8 Minor design: C8 conditional handler conflicts with hooks rules; extract ProtectedDownloadButton or guard; drop hardNavigate import.
F9 Minor design [Adjacent]: C10 generator timer has no observable defect under React 19; class has 5 more sites. Drop or enumerate.
F10 Minor prose: numbers don't re-derive (556 unmeasured; 65 vs 60; nextauth already tested; C4 grep ~30 lines).
F11 Minor design: C1 forbidden pattern can never match; assert include deep-equals in test.
F12 Minor design: untested-file transform per shard; app-coverage 10-min timeout.
F13 Minor design [Adjacent]: use-local-storage.test.ts tests a re-implementation; replace it.
Settled: perFile object form verified; 0-statement files = 100%; async server components already rendered in repo tests (s/[token]/page.test.tsx:73, admin/layout.test.tsx:72); ESLint override semantics correct.


---

# Review round 2
Date: 2026-11-22

## Changes from Previous Round
Revision 2 rewrote C1 (two layers), C2 (ratchets, ignore-comment gate, headroom), C3 (quality bar, extraction order, per-module store strategy), C4 (post-create contract, refocus retry, ESLint layout), C6 (4 consumers), C7 (fix approaches) and dropped the generator-timer item.

## Dispositions (all applied in plan revision 3)
| Finding | Severity | Disposition |
|---|---|---|
| F1, T2-1 | Major | Root runtime files added as literal pathspecs (1,120); four positive controls |
| F2, T2-2 | Major | Shared module scripts/checks/lib/coverage-members.mjs; sibling self-test check-coverage-scope.test.mjs |
| F3, S7 | Major/Minor | C6 consumer table: team-create keeps inline error, passphrase cleared on every outcome, reset() on close |
| F4, T2-8 | Major | use-local-storage pendingWriteRef; setItem-spy tests |
| F5, S1, T2-5 | Major/Minor | C4b focus-only listener gated on hasFocus; digest not plaintext; leak-free tests with stateful fake |
| F6, T2-12 | Major/Minor | C5 member set gains line 233; selector covers ??/ternary arms and bare toast() |
| F7 | Major | Headroom records global aggregates; raise coverage, never lower floors |
| F8, S6, F13 | Major/Minor | create-grant: onCreated after res.ok, reset on every close, unavailable-link state, dead token field and key removed |
| T2-4 | Major | C2a red-proof recipe (spread real config, root, dedicated blob dir, file-specific red line) |
| T2-6, T2-7 | Major | Reveal and badge tests reshaped so they fail on current code |
| S2 | Minor | Residuals per browser; digest held |
| S3 | Minor | Quoted-key destructure selector; copySecretWithoutClear restricted with recovery-key-dialog exemption |
| S4, F9, T2-10 | Minor | Ignore-hint gate via provider regex over full member set |
| S5, F11 | Minor | checkThresholdKeys |
| F10 | Minor | Path filters gain sentry and instrumentation-client |
| F12 | Minor | ProtectedDownloadButton owns error state |
| F14 | Minor | Redundant clipboard block dropped; layout comment |
| F15, T2-3 | Minor | Summary keys relativised; total ignored; reporter list stated |
| T2-9 | Minor | All five shard-count places; measure on shard+merge path |
| T2-11 | Minor | scan-test-assertions.mjs named, self-tested; ledger rows carry commands |
| T2-13 | Minor | createRequire(import.meta.url) |

## Recurring Issue Check
### Recurring Issue Check (Functionality expert R2)
R1 F3; R3 F6,F13; R8 F8; R17 F6; R18 F14; R25 F4; R29 F1,F6; R33 F7; R34 F8; R41 F8; R42 F1,F6; R47 F2,F15; R48 F3; R49 F11; R50 F2; others ok/N/A.
### Recurring Issue Check (Security expert R2)
R1 ok; R3 S3,S6; R17 S7; R25 S7; R29 S4; R34 S1; R36 S3; R39 S2; R42 S3,S4; R47 S4; R49 S1,S5; R53 S5; RS4 S6; others ok/N/A.
### Recurring Issue Check (Testing expert R2)
R3 T2-12; R21 T2-11; R29 T2-1; R33 T2-9; R42 T2-1; R44 T2-4; R47 T2-13; R50 T2-2; R53 T2-9; RT1 T2-5; RT7 T2-4,T2-6,T2-7,T2-8,T2-11; RT9 T2-5; RT10 T2-2; others ok/N/A.

## Raw expert findings (round 2)
## Functionality expert — Round 2
Resolved: M1(src),M3,M10,M14,M17,M20,M21. Member sets re-derived: prod 1116 (0 root files); C4 5 writes+1 read; C5 2 by regex (+1 missed); C6 4; C7 3.
F1 Major design: member-set command omits root runtime files → listMembers positive control throws on real tree; C1(b) never checks them. Append 4 root pathspecs (1120); positive control for proxy.ts and a sentry file.
F2 Major design: check-coverage-scope.mjs needs sibling scripts/__tests__/check-coverage-scope.test.mjs (check-gate-selftest-coverage.sh); pure core shared module location.
F3 Major design: C6 team-create-dialog: keep inline setUnlockError + setPassphrase(""); sessionExpired keeps setOpen(false)+toast+clear; render test.
F4 Major design: use-local-storage persist effect writes/freezes defaults; hydration flag race. Persist only setValue-produced values via pendingWriteRef; tests: mount w/o stored item writes nothing; functional update after hydration persists merged value.
F5 Major design: C4b retry consumed by visibilitychange before focus; retry on focus or visibilitychange only when document.hasFocus(); remove both listeners; tab-switch manual step + unit test.
F6 Major design: create-delegation-dialog.tsx:233 `toast.error(message ?? "Failed to create delegation")` — literal in ?? arm + untranslated server message; map via apiErrorToI18nKey+tApi; widen selector to Conditional/Logical arms.
F7 Major design: global aggregate floors not measured on expanded scope; measure after C3, record, decision rule if below.
F8 Major design: create-grant: reset on every onOpenChange(false); onCreated right after res.ok; missing token handled; test reopen after Esc.
F9 Minor design: C2c terms miss node:coverage ignore + whitespace variants.
F10 Minor design: ci.yml changes.app filter and pre-pr.sh app_paths omit sentry.*.config.ts (+instrumentation-client.ts in pre-pr).
F11 Minor design: glob ratchet matching zero files passes vacuously; C1(a) assert each threshold key matches.
F12 Minor design: ProtectedDownloadButton must own downloadError banner or onError.
F13 Minor prose: remove Grant.token? (grant-card.tsx:43, emergency-access/page.tsx), EmergencyAccess.copyLink key, grant-card.test.tsx:165; created-state strings (Done, link label); Anti-Deferral list add create-grant field.
F14 Minor prose: final clipboard ESLint block redundant; rationale wrong.
F15 Minor design: C1(b) normalize absolute json-summary keys via path.relative, ignore total; red-proof.


---

# Review round 3
Date: 2026-11-22

## Changes from Previous Round
Revision 3 applied all round-2 dispositions (root pathspecs, shared coverage-members module, focus-only digest retry, create-grant reset, C6 consumer table, C7 approaches and tests, path filters).

## Dispositions (applied in plan revision 4)
| Finding | Severity | Disposition |
|---|---|---|
| N1 (func), T3-1 | Major (convergent) | COVERAGE_THRESHOLDS exported unconditionally; checkThresholdKeys runs on it, refuses undefined/empty, skips reserved keys; recorded run with VITEST_COVERAGE_SHARD=1 |
| N1 (sec) | Minor | C4b engine reality: Chromium only; Firefox/Safari never clear; header, manual steps and scenarios corrected |
| N2 (sec) | Minor | Ignore-hint gate scans raw lines for start/stop; fixtures in string/template/JSX |
| N3 (sec) | Minor | copySecretWithoutClear via no-restricted-imports; file block turns only that rule off |
| N2 (func) | Minor | create-grant ignores close while loading; in-flight test |
| N3 (func), T3-3 | Minor | Lock-screen asserts session-expired card; team-create calls reset() explicitly; reopen test |
| N4 (func) | Minor | Floors 75/75/65; SC2 wording |
| T3-2 | Minor | Digest before registration; waitFor registration; hasFocus spy restored; second-focus no-call assertion |
| T3-4 | Minor | renderHook reactStrictMode |
| T3-5 | Minor | Self-test clause and fixture matrix completed |

## Measurement (below-target derivation, replacing config)
- Coverage keys 1,120 == members 1,120 (no missing, no extra).
- Below 65% statements or lines: 145 files (104 under src/app).
- Global aggregate: statements 87.54, lines 88.67, branches 80.93, functions 83.10.
- One load-induced timeout in scripts/__tests__/check-fail-closed-routes-have-test.test.mjs (60 s per-test limit; the file takes 80 s alone and passes 56/56 alone). Pre-existing; unrelated to this change.

## Recurring Issue Check
### Recurring Issue Check (Functionality expert R3)
R1 N3; R3 N2; R8 N2; R17 N3; R25 N2; R29 N4; R34 N1; R47 N1; R48 N3; R49 N1; R50 N1; R53 N4; others ok/N/A.
### Recurring Issue Check (Security expert R3)
R3 N3; R29 N1,N2; R34 N1; R36 N3; R39 N1; R42 N2; R49 N2,N3; others ok/N/A; RS4 ok.
### Recurring Issue Check (Testing expert R3)
R3 T3-5; R42 T3-5; R47 T3-1; R50 T3-1; RT1 T3-2; RT7 T3-1..T3-5; RT9 T3-2; RT10 T3-1; others ok/N/A.

## Raw expert findings (round 3)
## Functionality expert — Round 3
F1–F15 resolved (F11 vacuous in CI, see N1; F8 in-flight close, N2). Member sets re-derived: C1 1120; C4 5+1; C5 213/236/233; C6 4; C7 3.
N1 Major design: checkThresholdKeys vacuous in CI — app-test sets VITEST_COVERAGE_SHARD=1 so imported config thresholds undefined; self-test must unset env and re-import fresh, assert non-empty thresholds, refuse undefined/empty; skip reserved keys (perFile/autoUpdate/100/lines/functions/statements/branches); observed red with env set.
N2 Minor design: create-grant close during in-flight POST lets created state land after reset; block close while loading or generation ref; test.
N3 Minor design: lock-screen has no input after UNAUTHORIZED (assert session-expired view); team-create direct setOpen(false) bypasses onOpenChange → call reset() explicitly; reopen test.
N4 Minor prose: floors are statements 75 / lines 75 / branches 65; SC2 must acknowledge existing named branch floors.


---

# Review round 4
Date: 2026-11-22

## Changes from Previous Round
Revision 4 applied every round-3 disposition: COVERAGE_THRESHOLDS export, an engine-accurate C4b, a raw-line start/stop scan, copySecretWithoutClear moved to no-restricted-imports, the create-grant in-flight close, team-create reset(), and the self-test matrix.

## Findings and dispositions (applied in the final plan)
| Finding | Severity | Class | Disposition |
|---|---|---|---|
| func F4-1, test T4-1 (convergent) | Minor | design | The team-create red test now seeds a team name that only reset() clears. The passphrase check is kept as a positive control. |
| func F4-2 | Minor | design | One close handler serves Cancel, Done and onOpenChange; the created state shows only Done in its footer. Done/Cancel reopen tests added. |
| test T4-2 | Minor | design | Identity pin: `cfg.test.coverage.thresholds` is checked with `toBe(COVERAGE_THRESHOLDS)`, and is `undefined` when VITEST_COVERAGE_SHARD=1. |
| test T4-3 | Minor | design | The negative C4b tests assert that digest is never called and count the focus-listener registrations. |
| test T4-4 | Minor | design | Per-test timeout rule: measure check-fail-closed-routes-have-test.test.mjs in a CI-equivalent run. If it exceeds 30 s, move it to a no-coverage job. The round-3 note calling it "unrelated" was wrong: C3 enlarges its input. |
| test T4-5 | Minor | design | Required-path reds are table-driven over all four paths. |
| sec F1 | Minor | design | no-restricted-imports `patterns` with a `**/lib/clipboard/copy-secret` group catches relative specifiers. A relative-import deny fixture is added. Dynamic import() is added to the known bypasses. |

## Exit decision
The loop ends after round 4. All three experts reviewed. No Critical or Major finding was raised in round 4. Every Minor finding is resolved in the plan file, so none is carried forward. No finding is open against the design. All ten contracts are locked.

## Recurring Issue Check (round 4)
### Functionality expert
R3 F4-2; R42 F4-2; red-claim validity F4-1; others ok or N/A.
### Security expert
R42 F1; RS1–RS6 ok; others ok or N/A.
### Testing expert
R3 T4-5; R21 T4-1; R29/R33/R53 T4-4; R42 T4-5; R47/R50 T4-2; RT1/RT9 T4-3; RT7 T4-1, T4-3; RT10 T4-2, T4-5; others ok or N/A.
