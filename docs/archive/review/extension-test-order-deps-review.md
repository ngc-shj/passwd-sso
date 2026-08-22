# Plan Review: extension-test-order-deps
Date: 2026-08-22
Review round: 1

## Changes from Previous Round
Initial review.

## Merged Findings (convergence-corrected)

Convergence stamps applied per 'Perspective Convergence as a Severity Signal':
- MF1 (M3 derivation/load-axis acceptance): convergent functionality+testing — Major, fix first.
- MF6 (A6 red-proof re-seed fallback): convergent functionality+testing — severity floor raised Minor → Major.
All other findings retain their single-perspective severity.

| ID | Severity | Title | Convergent |
|----|----------|-------|------------|
| MF1 | Major | M3 load-race: no member derivation, no load-axis acceptance; fact-5 closure claim unverifiable | func+test |
| MF2 | Major | Set B Once-less grep misses direct-handle spellings; lib/messaging.test.ts in neither set | — |
| MF3 | Major | Suppression-spelling member set incomplete (it.fails, skipIf, options-object, assertion deletion) | — |
| MF4 | Major | Per-suite { shuffle: false } overrides C3 gate in-band; 'no spelling to bypass' overstated | — |
| MF5 | Major | I3 keyed-mock miss behavior unspecified (silent divergence or unhandled-rejection flake) | — |
| MF6 | Major (floored) | A3/A6 red-proofs assume ordering stability; no re-seed fallback | func+test |
| MF7 | Minor | C2 classification coverage ambiguous for 23 stubGlobal candidates | — |
| MF8 | Minor | SC2 deferral lacks security-triage classification for confirmed production race | — |
| MF9 | Minor | Residual-risk detection floor unquantified (~4.3% @ 95% over ~69 runs) | — |
| MF10 | Minor | rtk output proxy strips seed line; evidence capture needs file redirect | — |

## Major Findings

### Severity: Major
**Problem**: The plan's Established fact 5 claims the pre-pr plain-run failure is M3 (fire-and-forget async load-dependent race), but provides no derivation command for M3 members (e.g., files pairing `mockResolvedValueOnce` with fire-and-forget imports) and no acceptance criterion (A1–A7) runs the suite under CPU contention or reproduces the pre-pr environment. Recorded seeds at a single seed only prove order-dependence, not interleaving-dependence; reverting a file's fix may still red via its order-dependent component while leaving the M3 component unproven.
**Impact**: The pre-pr failure that partly motivated issue #784 can survive the PR while all acceptance evidence is green. An incomplete or wrong M3 fix passes all acceptance and re-flakes in pre-pr under parallel load later.
**Recommended action**: Keep shuffled/default suites green, and add: (1) a derivation command for M3 candidates feeding the C2 classification table; (2) an acceptance that runs affected files under the reproducing condition (e.g., concurrent CPU load or pre-pr batch). If unreplicable locally, log it explicitly and downgrade fact 5's closure to "hypothesized". Make red-proof per-mechanism: revert to positional Once queue AND deterministically flush the fire-and-forget consumer (via `await` or `vi.waitFor`) so misalignment reds every run.
**Flagged by**: Functionality expert, Testing expert

### Severity: Major
**Problem**: Set B's pattern-2 grep (`*Mock(s).method.mockX`) misses persistent overrides through direct `vi.fn()` handles. Recomputing with a wider pattern (`handle.Mock|Resolved|Implementation(`) surfaces additional files. Specifically, `extension/src/__tests__/lib/messaging.test.ts` (lines 18, 38) has M1-shaped once-less overrides in test bodies with only `vi.clearAllMocks()` in `beforeEach`. This file is absent from both Set A and Set B.
**Impact**: Under-derived M1 worklist means latent members ship past the 50-seed sweep and surface later as random-red pain. The plan's fallback (dynamic gate as authority) softens but does not remove this risk.
**Recommended action**: Widen the derivation grep to any handle spelling of `.mock(ReturnValue|ResolvedValue|Implementation)(`. Add every newly matched file to the C2 classification table. Contained occurrences remain untouched, but the classification row is mandatory. Treat a grep that cannot match known spellings as "not-run" until fixed.
**Flagged by**: Functionality expert

### Severity: Major
**Problem**: Plan lines 211–215 forbid only `\.skip\(` and `\.todo\(`. Vitest 4.1.10 offers additional suppression spellings that the execution gate cannot catch because masked tests never execute: `it.fails(` / `test.fails(`, options-object forms `{ skip: true }` / `{ fails: true }`, `it.skipIf(cond)(` / `it.runIf(cond)(`, and assertion deletion. Victims in Set A include security-control tests (`dpop-key.test.ts`, `totp-handlers.test.ts`).
**Impact**: An implementer can neutralize a security-relevant test with a spelling the forbidden list never flags; every standing gate stays green because the masked test does not run.
**Recommended action**: Widen the forbidden pattern to `\.(skip|skipIf|todo|fails|runIf|only)\s*\(` and options-object `(skip|todo|fails)\s*:\s*true` in test diffs. Pair with an allow path requiring a deviation-log entry for legitimate conditional skips. Add an acceptance clause to C1 requiring victim test assertions to be unchanged or strengthened.
**Flagged by**: Security expert

### Severity: Major
**Problem**: Plan line 194 claims the gate has "no spelling enumeration to bypass". However, vitest resolves per-suite shuffle with suite options taking precedence over the config (`this.shuffle ?? options.shuffle ?? currentSuite?.options?.shuffle`). `describe("x", { shuffle: false })` or `describe.shuffle` permanently exempts that suite from the C3 gate. This is deterministic and author-controllable, yet absent from the known-bypass list and forbidden-pattern list.
**Impact**: The plan's architecture relies on C3 as the controlling gate. A suite-level opt-out makes the gate fail-open per suite with no signal, defeating the control's purpose and allowing flaky security tests to be permanently exempted.
**Recommended action**: Add `shuffle` (suite/test option or chainable) to the forbidden-pattern list (deny). Pair allow: seed-pinning for local bisection stays available via CLI `--sequence.seed=N`. Amend C3's known-bypass list to honestly name this opt-out and correct the "no spelling enumeration to bypass" claim.
**Flagged by**: Security expert

### Severity: Major
**Problem**: C1-I3 dictates input-keyed mocks but leaves miss behavior undefined. Two unbounded shapes exist: (a) miss returns `undefined` → silent default/parsing error, hiding mock-reality divergence; (b) miss throws → the thrower may be the unawaited background consumer, creating an unhandled rejection that vitest attributes to another test, minting a new flake class.
**Impact**: Either silent divergence (worse than positional queues which fail visibly) or a new nondeterministic failure mode replacing the old one.
**Recommended action**: Specify that the keyed mock must throw on unmapped input with the input named in the error message (fail loudly). The key map must cover every input the production background path can request during tests, including fire-and-forget consumers. Prove coverage via the deterministic flush described in the M3 action.
**Flagged by**: Testing expert

---

## Minor Findings

### Severity: Minor
**Problem**: A6's point-mutation ("restore `totp-handlers.test.ts:327` to persistent `mockReturnValue`") and seed-based red-proofs assume ordering stability. If C1/Phase 2 adds files, renames tests, or alters test counts, seed 12345's permutation changes, potentially placing the culprit after the victim. The mutation may also be neutralized by C1's own `afterEach` restores or permutation shifts. A6's both-directions requirement detects non-red, but no scripted recovery exists.
**Impact**: The gate red-proof stalls at execution time with no scripted recovery, inviting ad-hoc substitutes or false negatives.
**Recommended action**: Specify mutation as "revert that file's entire C1 fix on the scratch copy". Add: "if no recorded seed reds after revert, sweep seeds 1..50 for a red and record the new seed". Deny MUST fail on the new seed; allow MUST pass. (Applies to A3/A6).
**Flagged by**: Functionality expert, Testing expert

### Severity: Minor
**Problem**: C2's signature says "for each Set B candidate file, Phase 2 classifies the pattern occurrence", but the stubGlobal bullet says "Phase 2 classifies only the ones where a stub is installed mid-file". C2's invariant covers `real-leak`-without-fix and fix-without-classification. A candidate never receiving a classification row trips nothing.
**Impact**: Up to ~20 files can silently drop out of the audit with no deviation-log trace; intention is undecidable from the plan.
**Recommended action**: State explicitly which set the classification table must cover. Either "all 23 candidates get a classification row (e.g., `contained — beforeEach stub`)", or amend C2's invariant so that "a Set B candidate absent from the table is itself a deviation-log entry".
**Flagged by**: Functionality expert

### Severity: Minor
**Problem**: "Residual risk (rare orderings) is accepted" carries no numerical threshold. The standing gate runs ~69 shuffled iterations. A latent member firing in fraction `p` of orderings escapes all runs with probability `(1-p)^69`. 95% detection requires `p ≥ 4.3%`. Members firing at 1% escape ~50% of the time, surfacing later as random CI reds.
**Impact**: Post-merge random CI reds from the tail will look like gate regressions unless the accept decision was made with the quantification in view.
**Recommended action**: Record the ~4.3%/95% detection floor in C3's control-class paragraph so the accepted bypass is quantified. Future tail-trips are triaged as expected behavior, not broken gates. No extra runs needed.
**Flagged by**: Testing expert

### Severity: Minor
**Problem**: Vitest's `Running tests with seed "N"` line is stripped by the session's `rtk-compressed` Bash proxy. A5/A6/C4 require "seeds recorded from output", but the Phase-2 executor runs in this environment. Evidence silently comes back empty.
**Impact**: Acceptance runs fail to capture required seed evidence; executor either blocks incorrectly or skips recording.
**Recommended action**: Add execution note to Testing strategy: capture acceptance-run output with `> file 2>&1` (or `rtk proxy`) and grep the file for the seed line. Treat a missing seed line as a capture failure. Pass/fail exit codes are unaffected.
**Flagged by**: Testing expert

### Severity: Minor
**Problem**: SC2 defers "Refactoring production `background/index` fire-and-forget async" as a routine report-only item. The mechanism (M3) is unawaited async in a password manager's service worker. If Phase 2 confirms it in production, the failure mode is credential/overview mis-association (OWASP A04), not a hygiene refactor. The plan doesn't specify issue classification.
**Impact**: A confirmed credential-adjacent race filed as an ordinary issue can sit unprioritized, losing the security signal.
**Recommended action**: Add to SC2: "If Phase 2 confirms the race with real decrypt inputs, the filed issue is labeled security and states the credential-mis-delivery hypothesis; if mock-positional only, note that and close the hypothesis."
**Flagged by**: Security expert

---

## Recurring Issue Check

### Functionality expert
| Rule | Status | Note |
|---|---|---|
| R1 | N/A | No shared-utility reimplementation; no new infra planned |
| R2 | N/A | No constants duplicated |
| R3 | Finding F2 | Once-less-fix pattern must propagate to all member files; spelling hole under-derives the set |
| R4 | N/A | No event dispatch |
| R5 | N/A | No DB/transactions |
| R6 | N/A | No cascade deletes |
| R7 | N/A | No E2E selectors |
| R8 | N/A | No UI |
| R9 | N/A | M3 is a test-mock race, not a tx-boundary fire-and-forget |
| R10 | N/A | No module graph change |
| R11 | N/A | — |
| R12 | N/A | — |
| R13 | N/A | — |
| R14 | N/A | No migrations |
| R15 | OK | Config-level gate makes dev/pre-pr/CI identical; all three consumers verified |
| R16 | N/A | No helper adoption |
| R17 | OK | Forbidden patterns block per-consumer `--sequence.shuffle` drift |
| R18 | N/A | — |
| R19 | N/A | — |
| R20 | N/A | Plan review, no subagent output accepted |
| R21 | N/A | — |
| R22 | N/A | — |
| R23 | N/A | — |
| R24 | N/A | — |
| R25 | N/A | — |
| R26 | N/A | — |
| R27 | N/A | — |
| R28 | N/A | — |
| R29 | OK | Isolate default, grep counts, seed-12345 result, duration — all spot-checked and reproduce |
| R30 | N/A | — |
| R31 | N/A | No destructive ops |
| R32 | N/A | No new runtime artifact |
| R33 | OK | Gate lives in one config; forbidden pattern enforces non-duplication |
| R34 | OK | SC2 defers the production fire-and-forget with explicit report-only justification; adjacent latent test leak covered under F2 |
| R35 | N/A | Not production-deployed behavior |
| R36 | OK | `.skip`/`.todo`/setTimeout-widening explicitly forbidden |
| R37 | N/A | No user-facing strings |
| R38 | N/A | No state machine |
| R39 | N/A | No secrets lifecycle |
| R40 | N/A | No serialization boundary |
| R41 | OK | Shuffle, seed printing, and CLI override verified working in the installed vitest — declared capability has a backing path |
| R42 | Finding F1, F2 | M3 members have no derivation (F1); M1 static worklist misses direct-handle spellings (F2) |
| R43 | N/A | No security boundary widened |
| R44 | OK | All consumers read vitest's exit code directly through `npm test` |
| R45 | OK | No perf regression; duration claim verified (~6.25 s) |
| R46 | N/A | No analyzer binding resolution |
| R47 | OK | Adjudication is execution-based (the runner); statics declared as worklist only |
| R48 | OK | Single adjudicator (one config), all consumers inherit |
| R49 | Finding F1 | C3's tripwire class is properly declared, but fact 5's "C1 closes the pre-pr failure too" is a claim stronger than any planned verification |
| R50 | OK | Seeds printed/recorded; red-proofs on scratch copies with both directions executed |
| R51 | N/A | — |
| R52 | N/A | — |
| R53 | N/A | Sweep sizes are discovery breadth, not pass/fail thresholds |
| R54 | N/A | — |
| R55 | N/A | — |
| R56 | N/A | — |
| R57 | N/A | — |

### Security expert
| Rule | Status |
|---|---|
| R1 | N/A (no shared-utility work) |
| R2 | N/A |
| R3 | OK (fix propagation governed by dynamic sweep + C2 classification) |
| R4 | N/A |
| R5 | N/A (no DB) |
| R6 | N/A (no E2E selectors) |
| R7 | N/A (no UI) |
| R8 | N/A |
| R9 | N/A |
| R10 | N/A |
| R11 | N/A |
| R12 | N/A |
| R13 | N/A |
| R14 | N/A |
| R15 | N/A |
| R16 | OK (same `npm test` path in dev/pre-pr/CI; plan's consumer walkthrough covers parity) |
| R17 | N/A |
| R18 | N/A |
| R19 | OK (mock changes confined to files whose tests adjudicate them) |
| R20 | N/A (plan stage) |
| R21 | N/A (no subagent output consumed) |
| R22 | N/A |
| R23 | N/A |
| R24 | N/A |
| R25 | N/A |
| R26 | N/A |
| R27 | N/A |
| R28 | N/A |
| R29 | OK — seed-12345 failure count and seed-print claim independently reproduced this review |
| R30 | N/A |
| R31 | N/A (no destructive ops; red-proofs on scratch copies) |
| R32 | N/A |
| R33 | OK — single-config gate with forbidden pattern against duplication |
| R34 | OK — SC1–SC4 each carry owner + justification |
| R35 | N/A |
| R36 | Finding F1 |
| R37 | N/A |
| R38 | N/A |
| R39 | N/A |
| R40 | N/A |
| R41 | OK (seed-repro path verified to exist in installed vitest) |
| R42 | Finding F1 (suppression-spelling member set), F2 (bypass member set) |
| R43 | N/A |
| R44 | OK (pre-pr consumes exit code directly; seed line lands in captured log) |
| R45 | N/A (no scaling gate; ~70 runs ≈ 9 min, measured) |
| R46 | N/A |
| R47 | Finding F1 (forbidden-pattern surface-form list incomplete; C3 itself is genuinely execution-based) |
| R48 | N/A (one adjudicator — the runner) |
| R49 | Finding F2 ("no spelling enumeration to bypass" is overstated; per-suite opt-out exists) |
| R50 | OK (acceptance requires recorded outputs, not proxy signals) |
| R51 | N/A |
| R52 | N/A |
| R53 | N/A |
| R54 | Finding F2 (in-band per-suite gate suspension) |
| R55 | N/A |
| R56 | N/A |
| R57 | N/A |
| RS1 | N/A (no comparisons touched) |
| RS2 | N/A (no routes) |
| RS3 | N/A (no boundary input) |
| RS4 | OK — fixtures are canonical fake material; recorded evidence contains seeds/test names only |
| RS5 | N/A |
| RS6 | N/A |

### Testing expert
| Rule | Status | | Rule | Status | | Rule | Status |
|---|---|---|---|---|---|---|---|
| R1 | N/A | | R21 | OK (scratch-copy rule stated) | | R41 | OK |
| R2 | N/A | | R22 | N/A | | R42 | OK (dynamic derivation; F4 quantifies) |
| R3 | N/A | | R23 | N/A | | R43 | N/A |
| R4 | N/A | | R24 | N/A | | R44 | Finding F5 |
| R5 | N/A | | R25 | N/A | | R45 | OK (~7 s suite, no scaling) |
| R6 | N/A | | R26 | N/A | | R46 | N/A |
| R7 | N/A | | R27 | N/A | | R47 | OK (vitest execution adjudicates) |
| R8 | N/A | | R28 | N/A | | R48 | OK (single gate, no parallel adjudicator) |
| R9 | N/A | | R29 | OK (facts 1,3 reproduced; commands present) | | R49 | OK (tripwire declared; F4 refines) |
| R10 | N/A | | R30 | N/A | | R50 | Finding F5 (evidence channel) |
| R11 | N/A | | R31 | N/A | | R51 | N/A |
| R12 | N/A | | R32 | N/A | | R52 | N/A |
| R13 | N/A | | R33 | OK (config-once + forbidden per-consumer flags) | | R53 | N/A |
| R14 | N/A | | R34 | OK (SC1–SC4 owned) | | R54 | N/A |
| R15 | N/A | | R35 | N/A | | R55 | N/A |
| R16 | OK (pre-pr/CI/dev all inherit via npm test; verified) | | R36 | OK (.skip forbidden pattern) | | R56 | N/A |
| R17 | N/A | | R37 | N/A | | R57 | N/A |
| R18 | OK (CI filter covers extension/vitest.config.ts; verified) | | R38 | N/A | | RS1–RS6 | N/A |
| R19 | N/A | | R39 | N/A | | | |
| R20 | N/A | | R40 | | | | |

| RT rule | Status |
|---|---|
| RT1 | Finding F2 (keyed-mock miss behavior unbounded) |
| RT2 | OK (all contracts locally testable) |
| RT3 | N/A |
| RT4 | Finding F1 (no acceptance exercises the load axis); F4 (sweep floor quantified) |
| RT5 | N/A (test-only change) |
| RT6 | N/A (no production exports) |
| RT7 | Finding F1 (M3 red-proof cannot fail for the claimed reason); F3 (seed-stability fallback) |
| RT8 | N/A |
| RT9 | OK (test-only edits; production twins untouched) |
| RT10 | OK (A6 runs deny AND allow every time) |
| RT11 | OK (scratch-copy mutations; no fixture outlives its run) |

## Quality Warnings
No findings triggered quality flags. All merged findings contain specific file/line references, concrete commands/regexes, or explicit spec amendments, and do not rely on unverified claims or untested test targets.

---

# Plan Review: extension-test-order-deps — Round 2
Date: 2026-08-22
Review round: 2

## Changes from Previous Round
All 10 Round-1 merged findings were applied to the plan (M3 hypothesized + A3m/A8, widened Set B grep, suppression/opt-out forbidden patterns, keyed-mock miss spec, re-seed fallback, C2 full coverage, SC2 triage, detection floor, rtk evidence capture). Round 2 verified those fixes and reviewed the new material.

## Round-2 verdicts on Round-1 fixes
All three experts confirm every Round-1 finding resolved in substance; all Round-2 findings target construction defects INSIDE the Round-1 remedies or newly re-derived class members.

## Merged Findings (convergence-corrected)

| ID | Severity | Title | Convergent |
|----|----------|-------|------------|
| R2-1 | Major | A3m flush placement unspecified/conflated with I3 flush; natural placement greens the deny run | func(F9)+test(F1) |
| R2-2 | Major | shuffle opt-out regex brace-anchored; misses multi-key option objects | func(F7)+sec(F6) |
| R2-3 | Major | A7 after-number from pre-pr contended run; cross-environment comparison invalid | func(F8)+test(F4) |
| R2-4 | Major | Set B commands exclude .test.tsx; 5 files dropped, M1-shaped hits in popup/App.test.tsx | func(F5) |
| R2-5 | Major | M3 candidate set name-supplied; input-derive from all mockResolvedValueOnce files | func(F6) |
| R2-6 | Major | retry/repeats options absorb gate trips markerlessly; missing from forbidden patterns | sec(F4) |
| R2-7 | Major (floored) | C4 'A1–A8' lexically excludes A3m | func(F10)+test(F3) |
| R2-8 | Minor | Re-seed fallback lacks exhaustion exit | test(F2) |
| R2-9 | Minor | Options pattern omits only:true; destructured ctx.skip unlisted | sec(F5) |
| R2-10 | Minor | I4 scoped to victims; culprit tests outside assertion-weakening check | sec(F7) |

Convergence stamps per 'Perspective Convergence as a Severity Signal': R2-1/R2-2/R2-3 take max severity (Major); R2-7 floored Minor→Major (two perspectives).

## Merged Findings

### Major

**Severity**: Major  
**Problem**: The widened pattern-2 command and the module-scope-`let` count use `--include='*.test.ts'`, excluding 7 `.test.tsx` files. Recomputation reveals 5 dropped files carry `.mock(ReturnValue|ResolvedValue|RejectedValue|Implementation)(` hits (including M1-shaped Once-less overrides in `popup/App.test.tsx`). Reconciliation is self-referential against the same filtered commands.  
**Impact**: Five candidate files structurally drop out of the C2 audit, and C2's row-count reconciliation cannot notice because it reconciles against the same filtered commands' output.  
**Recommended action**: Change include filters to `--include='*.test.ts*'` (or drop `--include`), re-run, add new hits to the C2 table. Boundary: the filter must admit every file vitest's default include admits; reconcile counts from corrected commands.  
*Flagged by*: Functionality

**Severity**: Major  
**Problem**: The M3 derivation command keys on the literal `background/index`, leaving Phase 2 name-supply to judgment. Recomputation finds 12 files containing `mockResolvedValueOnce`; the command matches only 4. Excluded files (e.g., `content/token-bridge.test.ts`, `popup/App.test.tsx`, `popup/MatchList.test.tsx`) have unawaited consumers by construction. Verdicts are never recorded.  
**Impact**: An M3-class race in an excluded file stays latent; the shuffle gate cannot sample it (bypass (b)) and A8's single pre-pr run is one sample.  
**Recommended action**: Make the candidate set input-derived: every `mockResolvedValueOnce` file is an M3-classification candidate (12 rows). Reconciliation then counts against `grep -rl 'mockResolvedValueOnce' .`, which cannot under-derive its own left side.  
*Flagged by*: Functionality

**Severity**: Major  
**Problem**: The test-side opt-out regex `\{\s*shuffle\s*:\s*false` is brace-anchored, missing multi-key option objects like `describe("x", { concurrent: true, shuffle: false }, …)`. The companion `shuffle\s*:` is scoped only to `extension/vitests.config.ts`. Zero hits exist under `extension/src/__tests__/`, so a maximally broad pattern carries zero false-positive cost.  
**Impact**: A suite can opt out of the gate through a spelling the declared residue control does not flag.  
**Recommended action**: Replace the test-side pattern with unanchored `shuffle\s*:\s*false` (or bare `shuffle`) under `extension/src/__tests__/`. Keep `describe\.shuffle` for readability. Explicitly state the config-side scope.  
*Flagged by*: Functionality, Security

**Severity**: Major  
**Problem**: A7 compares `npm test` wall-clock before/after. The before-side is fact 4's idle-machine measurement (~6.2–7.2 s). A8 designates the "Extension: Test" step duration from pre-pr's batch 1 (concurrent with Lint/Test/Build/CLI: Build) as the after-number. This measures CPU contention, not the shuffle delta.  
**Impact**: Either a spurious "materially worse" report to the user, or a real shuffle regression hidden inside contention noise. Both corrupt C4's closure evidence.  
**Recommended action**: Derive A7's two numbers from the same idle environment: idle `npx vitest run --sequence.shuffle=false` (before) vs. idle config-shuffled `npm test` (after). Keep A8's step duration as supplementary contended-environment evidence.  
*Flagged by*: Functionality, QA/Testing

**Severity**: Major  
**Problem**: A3m's "reds EVERY run" depends on flush placement, but I3 specifies the flush only as "before the test ends". Natural end-of-test placement allows intended consumers to drain the Once queue in order, leaving the fire-and-forget consumer with an exhausted queue. This causes the deny-run to green instead of red, breaking the minimal-pair property.  
**Impact**: The acceptance criterion built to prove M3 can fail to red for a construction reason, leaving M3 falsely "hypothesized" or requiring ad-hoc executor fixes that break the minimal-pair property.  
**Recommended action**: Specify in A3m that the red-proof flush sits **at the steal window** — immediately after the fire-and-forget trigger (post-unlock), before intended consumers. The deny/allow pair must use the identical test body, differing only in mock keying. I3's end-of-test flush coexists for miss-attribution.  
*Flagged by*: Functionality, QA/Testing

**Severity**: Major  
**Problem**: `TestOptions.retry` (and config-level `retry`/`repeats`) exists on the installed surface but matches no forbidden pattern. `{ retry: 2 }` permanently absorbs the gate's exit-code signal for intermittent members without a skip marker, neutralizing the tail-closure mechanism of C3.  
**Impact**: The gate stays green while the order-dependence class re-accumulates; the standing gate's closure is bypassed by a socially normal "flaky test fix".  
**Recommended action**: Add forbidden patterns: `retry\s*:` and `repeats\s*:` under `extension/src/__tests__/` and `extension/vitests.config.ts`. Require a deviation-log entry naming the nondeterminism source and an issue link for genuine retries. Verified zero false positives in current extension tests.  
*Flagged by*: Security

### Minor

**Severity**: Minor  
**Problem**: C4's acceptance clause states "all acceptance IDs A1–A8 present with commands and outputs." A3m falls outside the lexical A1..A8 range. A checklist-driven executor can omit A3m's evidence without triggering the clause.  
**Impact**: The M3 proof — the plan's most fragile evidence item — is at risk of being skipped by strict ID-range checklists.  
**Recommended action**: Update text to "A1–A4, A3m, A5–A8 present with commands and outputs (A3m may instead be a named deviation-log entry per its fallback)".  
*Flagged by*: Functionality, QA/Testing

**Severity**: Minor  
**Problem**: The options-object pattern bans `(skip|todo|fails)\s*:\s*true` but omits `only?: boolean`. `it("x", { only: true }, fn)` narrows suites without a dot-form `.only(`. Additionally, destructured `ctx.skip` contains no `.skip(` substring.  
**Impact**: Local pre-pr runs without `CI` would silently pass narrowed suites; destructured skip goes uncaught by grep-based residue control.  
**Recommended action**: Change the options pattern to `(skip|todo|fails|only)\s*:\s*true`. Add destructured `ctx.skip` to the un-greppable-residue sentence so C1-I4's diff inspection explicitly owns it.  
*Flagged by*: Security

**Severity**: Minor  
**Problem**: I4 (C1 assertion-weakening check) is scoped to "victim tests", but the plan's fixes typically edit *culprit* tests. Reading I4 literally excludes the actually-edited tests from assertion-strengthening verification.  
**Impact**: Assertion-weakening in culprit tests escapes adjudication.  
**Recommended action**: Reword I4 from "victim tests'" to "all tests in files edited under C1/C2" — assertions unchanged or strengthened, verified by PR-diff inspection.  
*Flagged by*: Security

## Recurring Issue Check

### Functionality expert
| Rule | Status | Note |
|---|---|---|
| R1 | N/A | — |
| R2 | N/A | — |
| R3 | OK | Handle-spelling gap closed; residual extension-filter gap tracked as F5 (R42) |
| R4–R15 | N/A | — |
| R16 | OK | Consumers unchanged; single-config gate confirmed again |
| R17 | N/A | — |
| R18 | OK | Anchoring defect is F7, not a sync gap |
| R19–R28 | N/A | — |
| R29 | Finding F10 | Detection-floor math and run counts verified correct; A3m/"A1–A8" cross-reference is the one inaccuracy |
| R30–R32 | N/A | — |
| R33 | OK | — |
| R34 | OK | SC2 triage pre-commitment strengthens Round-1 posture |
| R35 | N/A | — |
| R36 | OK | Suppression class widened with an allow path; un-greppable residue handled by C1-I4 |
| R37–R40 | N/A | — |
| R41 | OK | Bypass-(c) chain quote matches vitest semantics; CLI overrides re-verified empirically |
| R42 | Finding F5, F6 | Extension-filter hole; M3 module-set name-supplied |
| R43 | N/A | — |
| R44 | OK | Evidence-capture note closes the rtk lossy-channel risk |
| R45 | OK | — |
| R46 | N/A | — |
| R47 | Finding F7 | Brace-anchored opt-out regex misses non-first-property spelling |
| R48 | OK | — |
| R49 | OK | Fact 5 hypothesized; honest residues; tail-trip expected behavior |
| R50 | Finding F8 (and F9) | A7 cross-environment; A3m flush placement underspecified |
| R51–R57 | N/A | — |

### Security expert
| Rule | Status |
|---|---|
| R1–R2 | N/A |
| R3 | OK |
| R4–R15 | N/A |
| R16 | OK (A8 adds the pre-pr parallel-load environment to the evidence set) |
| R17–R28 | N/A (R19 OK; R20 N/A plan stage) |
| R29 | OK — detection-floor math reproduced; resolution-chain quote matches installed runner source |
| R30–R32 | N/A |
| R33 | OK |
| R34 | OK (SC1–SC4 owned; SC2 triage pre-committed) |
| R35 | N/A |
| R36 | Finding F4 (retry as markerless weakening), F7 (I4 scope) |
| R37–R41 | N/A (R41 OK) |
| R42 | Finding F4 (retry member missed on class re-derivation), F5 (options-`only`, destructured skip) |
| R43 | N/A |
| R44 | OK |
| R45–R46 | N/A |
| R47 | Finding F6 (test-side opt-out regex weaker than the spelling it bans) |
| R48 | N/A |
| R49 | OK — residue: "two surface-form residues" becomes three once F4's retry member is admitted — fold into the F4 fix |
| R50 | OK (A8; recorded outputs, not proxies) |
| R51–R57 | N/A (R54: setConfig runtime-suspension vector checked and closed) |
| RS1–RS3 | N/A |
| RS4 | OK — keyed-mock throw messages and evidence logs carry fixture data and seeds only |
| RS5–RS6 | N/A |

### QA/Testing expert
| Rule | Status | | Rule | Status | | Rule | Status |
|---|---|---|---|---|---|---|---|
| R1 | N/A | | R21 | OK | | R41 | OK |
| R2 | N/A | | R22 | N/A | | R42 | OK (M3-candidate derivation added; widened grep closes the spelling hole) |
| R3 | N/A | | R23 | N/A | | R43 | N/A |
| R4 | N/A | | R24 | N/A | | R44 | OK (rtk note: exit codes intact, seed via file capture) |
| R5 | N/A | | R25 | N/A | | R45 | OK |
| R6 | N/A | | R26 | N/A | | R46 | N/A |
| R7 | N/A | | R27 | N/A | | R47 | OK (two-residue statement now accurate; residues pattern-gated) |
| R8 | N/A | | R28 | N/A | | R48 | OK |
| R9 | N/A | | R29 | Finding F4 (A7 after-number derivation); bypass-(c) quote verified OK | | R49 | OK (tripwire + quantified floor + named bypasses a/b/c) |
| R10 | N/A | | R30 | N/A | | R50 | OK |
| R11 | N/A | | R31 | N/A | | R51 | N/A |
| R12 | Finding F3 (A1–A8 range excludes A3m) | | R32 | N/A | | R52 | N/A |
| R13 | N/A | | R33 | OK | | R53 | N/A |
| R14 | N/A | | R34 | OK | | R54 | N/A |
| R15 | N/A | | R35 | N/A | | R55 | N/A |
| R16 | OK | | R36 | OK (suppression spellings + options-object + I4 diff inspection) | | R56 | N/A |
| R17 | N/A | | R37 | N/A | | R57 | N/A |
| R18 | OK | | R38 | N/A | | RS1–RS6 | N/A |
| R19 | N/A | | R39 | N/A | | | |
| R20 | N/A | | R40 | N/A | | | |

| RT rule | Status |
|---|---|
| RT1 | OK (I3 miss-throws with named input; full consumer key map) |
| RT2 | OK |
| RT3 | N/A |
| RT4 | OK (M3 axis covered by A3m + A8; F1 is the RT7 construction defect, not a coverage gap) |
| RT5 | N/A |
| RT6 | N/A |
| RT7 | Finding F1 (A3m flush placement can green the deny run); Finding F2 (re-seed exhaustion has no exit) |
| RT8 | N/A |
| RT9 | OK |
| RT10 | OK (A3, A3m, A6 all state deny AND allow every time) |
| RT11 | OK (scratch-copy mechanics; A6 whole-file revert) |

## Quality Warnings
No findings failed the quality gate checks. All merged items contain specific file/line references, concrete recommended actions, and are backed by grep output or interface/runner source verification. No [VAGUE], [NO-EVIDENCE], or [UNTESTED-CLAIM] flags were triggered.

---

# Plan Review: extension-test-order-deps — Round 3
Date: 2026-08-22
Review round: 3

## Changes from Previous Round
All 10 Round-2 merged findings applied (A3m steal-window minimal pair, bare-token shuffle pattern, A7 like-for-like, .tsx include filter, input-derived M3 set, retry/repeats pattern, C4 lattice, exhaustion exit, only:true + ctx.skip residue, I4 rescope). Round 3 verified those fixes: all three experts confirm every Round-2 finding resolved; new findings target residual spelling surfaces and one incompletely-propagated coverage clause.

## Merged Findings (convergence-corrected)

| ID | Severity | Title | Convergent |
|----|----------|-------|------------|
| R3-1 | Major | Seed-pinning + consumer-file retry spellings unlisted (--sequence.seed/--retry/--repeats in committed consumer files; seed: in config); A5 lacks pairwise-distinct-seeds clause | sec(F8)+func(F11) |
| R3-2 | Major | C2 coverage enumeration omits let-subset; stubGlobal bullet stale + two bullets lacked derivation commands | test(F1)+func(F12) |
| R3-3 | Major (floored) | Bare-token shuffle pattern: no allow path; 'any new match IS forbidden' overclaim (comment/string false positives) | func(F13)+test(F2) |
| R3-4 | Minor | I4's assertion-only criterion cannot fire on destructured ctx.skip early-exit; needs explicit clause | sec(F9) |

Saturation labels as filed by experts: R3-1 prose-only(R42,R44)/design-level(R47) [func labels design]; R3-2 prose-only (R12/R29); R3-3 prose-only/design-small (R29/R36); R3-4 prose-only (R36).

# Functionality Review — Round 3 (incremental)

## Round-2 resolution verification
F5 (.tsx filter) resolved — matches recomputation exactly. F6 (M3 input derivation) resolved — 12 files, unfiltered grep admits .tsx, reconciliation self-consistent. F7 (anchored regex) resolved — bare token + config-side scope; residual ergonomic gap = F13. F8 (A7/A8) resolved — like-for-like idle, internally consistent. F9 (flush placement) resolved — steal-window + identical-body pair + DISPROVEN/deviation split; I3 "do not conflate" closes ambiguity. F10 (A1–A8 range) resolved.

New claims verified by execution: `(retry|repeats)\s*:` corpus clean; vi.setConfig RuntimeConfig = `sequence?: { hooks?: SequenceHooks }` only (config.d.A1h_Y6Jt.d.ts:224-228).

## New findings

### F11 — Major (design-level, R47): retry-absorption and order-pinning residues un-forbidden in the consumer-file surface the list already knows about — `--retry`/`--repeats` and `--sequence.seed` in package.json/pre-pr/workflows, and `seed:` in the config
`"test": "vitest run --retry=3"` in extension/package.json absorbs failures for every standing consumer and matches no pattern; `--sequence.seed=N` committed in any consumer file — or `seed:` in the config's sequence block — pins every run to ONE ordering: the gate still "runs shuffled with a printed seed" (I1 satisfied to the letter) while the accumulating-samples closure mechanism silently dies, and A5's soak becomes 10 samples of the same permutation — vacuous evidence.
Fix: extend the retry row's scope with `--retry|--repeats` in the consumer files (same file set as the `--sequence.shuffle` row), and add a pinning row: `--sequence.seed` in consumer files and `seed\s*:` in extension/vitest.config.ts. Allow: ad-hoc CLI seed for local bisection (no committed file); committed retry keeps the deviation-log allow path. Boundary: forbidden surface = committed files standing consumers execute.

### F12 — Minor (prose-only, R29): stubGlobal Set B bullet still carries the pre-Round-2 "classifies only mid-file" sentence, contradicting C2's ALL-23 clause, and is the one bullet with no derivation command
Count re-verified: 23 (unfiltered, .tsx admitted). Fix: replace stale sentence with pointer to C2's coverage clause and paste the derivation command verbatim; let-set bullet likewise wants its command verbatim.

### F13 — Minor (design-level small, R36): bare-token `shuffle` forbidden pattern has no allow path, and this PR's own fix diff is likely to contain the token in comments
I2 mandates culprit-naming; natural vocabulary is this token ("leak surfaced by the shuffle gate at seed 12345"). Fix: keep the deny; add the allow the sibling rows have — comment-only match acceptable when the hunk shows no `shuffle` token in executable code, adjudicated at C1-I4's diff inspection; code-position match remains forbidden.

## Recurring Issue Check
R29: Finding F12 (all other quantitative claims re-verified: 12 M3 files, 10 let files, 7 tsx, corpus-clean, RuntimeConfig shape). R36: Finding F13. R47: Finding F11. R18/R33: OK (consumer-file gap filed as F11, not config drift). R42: OK (Round-2 gaps closed; F11 filed under R47). R3/R16/R41/R44/R45/R48/R49/R50/R53: OK. All others N/A.

```json
[
  {"id":"F11","severity":"Major","title":"Retry-absorption and seed-pinning spellings un-forbidden in consumer files (--retry/--repeats, --sequence.seed) and config (seed:)","file":"docs/archive/review/extension-test-order-deps-plan.md","line":330,"adjacent":false,"escalate":null},
  {"id":"F12","severity":"Minor","title":"Stale stubGlobal bullet contradicts C2 ALL-23 coverage clause; only Set B bullet without a derivation command","file":"docs/archive/review/extension-test-order-deps-plan.md","line":141,"adjacent":false,"escalate":null},
  {"id":"F13","severity":"Minor","title":"Bare-token shuffle forbidden pattern lacks an allow path; mandated culprit-naming comments are a likely false positive","file":"docs/archive/review/extension-test-order-deps-plan.md","line":331,"adjacent":false,"escalate":null}
]
```
# Security Review — Round 3 (incremental)

Verification: no `.spec.*`/`.test.js` files exist under `extension/src` (the `*.test.ts*` include-filter claim holds), the 7 `.test.tsx` and 12 `mockResolvedValueOnce` counts reproduce (R29 clean), and the token `seed` has ZERO occurrences in `extension/src/__tests__`, `vitest.config.ts`, and `package.json`.

**Round-2 fix verification:**
- **F4 (retry/repeats) — fix correct.** Pattern + deviation-log allow + corpus-clean note present; three-residue adjudication paragraph with vi.setConfig closure. Re-checked chainable surface: `ChainableTestContextMap` has no `retry` member, so the option spelling is the only in-test spelling. One location-axis member remains — F8.
- **F5 (options-only, destructured skip) — substantially fixed.** One delegation mismatch remains — F9.
- **F6 (bare shuffle token) — fix correct and complete.**
- **F7 (I4 rescope) — fix correct.**

## Findings

### F8 — Severity: Major — `sequence.seed` pinning (config `seed:` / script `--sequence.seed`) freezes the gate to one permutation and is unlisted; A5 would not detect it (saturation: prose-only; R42, R44)

**Problem:** The installed vitest only generates a random seed when none is supplied: `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:481` — `resolved.sequence.seed ??= Date.now()` — and the in-file shuffle consumes that seed directly (`@vitest/runner/dist/chunk-artifact.js:3155-3156`). So `sequence: { shuffle: true, seed: 42 }` in `extension/vitest.config.ts`, or `--sequence.seed=42` appended to the `test` script in `extension/package.json`, keeps the gate visibly "on" (shuffled order, seed line printed) while sampling the SAME single permutation forever — killing the plan's declared tail-closure mechanism ("the standing gate keeps accumulating samples"). Neither spelling matches any forbidden pattern: the config pattern is `shuffle\s*:` only; the script pattern is `--sequence.shuffle`, which does not match `--sequence.seed` (nor a script-side `--retry`, the same location-axis gap for the F4 member). And A5 requires "10 consecutive runs … seeds recorded" but never requires the recorded seeds to be pairwise distinct — a pinned-seed run satisfies A5's letter with 10 identical recorded seeds.

**Impact:** An in-diff, marker-free spelling neutralizes the gate's only probabilistic guarantee while every acceptance clause still reads green; post-merge, order-dependence members that don't fire at the pinned permutation never fire.

**Recommended action:** (1) Extend the config-side pattern to `(shuffle|seed)\s*:` outside the single gate line — verified corpus-clean: zero `seed` occurrences in tests, config, or package.json. (2) Extend the location pattern to `--(sequence\.(shuffle|seed)|retry|repeats)` in `extension/package.json`, `scripts/pre-pr.sh`, `.github/workflows/*` (closes the script-side `--retry` spelling at the same time). (3) Add to A5: "the 10 recorded seeds are pairwise distinct; a repeated seed is adjudicated as pinning or a capture failure and fails the acceptance loudly." Paired allow stays: seed pinning for local bisection via CLI on a developer's machine, touching no committed file.

### F9 — Severity: Minor — destructured-`ctx.skip` residue delegated to C1-I4, but I4's criterion inspects only assertions, which a destructured `skip()` leaves intact (saturation: prose-only; R36)

**Problem:** The un-greppable-residue sentence says the destructured form is "covered by C1-I4 diff inspection". I4 instructs the inspector to verify "assertions are unchanged or strengthened". A destructured `skip()` inserted as the first statement leaves every assertion textually unchanged — it makes them unreachable. An inspector applying I4's stated criterion faithfully would pass the diff.

**Recommended action:** One clause in I4: "…assertions are unchanged or strengthened, AND no new early-exit or skip invocation (including destructured `TestContext.skip`) is introduced ahead of them." Allow unchanged (deviation-log path).

**No other new holes:** `*.test.ts*` include-filter sound; input-derived M3 set cannot under-derive its left side; exhaustion exits fail loudly (R50-clean); A3m steal-window pair + DISPROVEN branch keep fact 5 honest; no secret material in fixtures/errors/evidence (RS4 clean).

## Recurring Issue Check

| Rule | Status |
|---|---|
| R1–R2 | N/A |
| R3 | OK |
| R4–R15 | N/A |
| R16 | OK (A7 idle-vs-idle; A8 contended context separated) |
| R17–R28 | N/A |
| R29 | OK — Round-3 spot checks reproduced: 7 .test.tsx, 12 mockResolvedValueOnce files, zero seed corpus hits, no .spec.*/.test.js escapes |
| R30–R32 | N/A |
| R33 | OK for shuffle flags; Finding F8 extends the same location set to --sequence.seed/--retry |
| R34 | OK |
| R35 | N/A |
| R36 | Finding F9; F8 secondary |
| R37–R41 | N/A |
| R42 | Finding F8 (seed-pinning member missed on neutralization-class re-derivation) |
| R43 | N/A |
| R44 | Finding F8 (pinned seed freezes the sampled permutation while appearing random); rtk capture handling OK |
| R45–R46 | N/A |
| R47 | OK — bare-token shuffle pattern at least as strong as the spellings it bans |
| R48 | N/A |
| R49 | OK — three-residue statement accurate for surfaces enumerated; fold F8's member in as fourth or absorb into bypass (c) when fixed |
| R50 | OK |
| R51–R57 | N/A |
| RS1–RS3 | N/A |
| RS4 | OK |
| RS5–RS6 | N/A |

```json
[
  {"id":"F8","severity":"Major","title":"sequence.seed pinning (config seed: / script --sequence.seed) freezes the shuffle gate to one permutation; unlisted in forbidden patterns and undetected by A5","file":"docs/archive/review/extension-test-order-deps-plan.md","line":331,"adjacent":false,"escalate":null},
  {"id":"F9","severity":"Minor","title":"Destructured ctx.skip residue delegated to C1-I4, whose assertion-only criterion cannot fire on it","file":"docs/archive/review/extension-test-order-deps-plan.md","line":333,"adjacent":false,"escalate":null}
]
```
# QA/Testing Review — Round 3 (incremental)

## Verification performed
A3m steal-window construction verified EXECUTABLE against background.test.ts:705-720 (deny = flush after UNLOCK_VAULT forces overview refresh to take slot 1 → AUTOFILL decrypts slot 2 as blob → NO_PASSWORD, red every run; allow = identical body + keyed mock greens). Coexistence with I3's end-of-test flush consistent. Exhaustion exit present in A3, mirrored in A6, both directions preserved. C4 lattice resolved. A7/A8 internally consistent. All new quantitative claims verified: 7 .test.tsx, 12 mockResolvedValueOnce files, 0 bare-shuffle, 0 retry/repeats, popup/App.test.tsx:167/204 real M1-shaped hits, 10 let-files incl. options/App.test.tsx, RuntimeConfig verbatim. No forbidden pattern matches the planned fix itself.

## Findings

### F1 — Major (prose-only, R12 + R29): C2's coverage enumeration omits the module-scope-`let` subset, and that subset alone has no recorded derivation command
The em-dash enumeration lists four of Set B's five bullets; the let-set (10 files) is absent, and its derivation command is unrecorded, so the reconciliation has nothing to reconcile for it. Both fail-loud guards (enumeration + reconciliation) miss this subset simultaneously — the round-2 fix incompletely propagated. Candidates unique to this subset: background/inline-matches.test.ts, content/cc-identity-detector.test.ts, lib/disconnect-reason.test.ts, lib/storage.test.ts.
Fix: add the fifth subset to the enumeration and record the command: `grep -rln --include='*.test.ts*' -E '^let ' .` → exactly 10 files. Allow unchanged: contained one-liners suffice.

### F2 — Minor (prose-only, R29): bare-token `shuffle` pattern claims "any new match IS the thing being forbidden" — false for comment/string matches; the one pattern with no allow path
Fix: state the boundary — options-position or chainable occurrence is forbidden; comment/string match is a named false positive to note in review, not an automatic reject.

## Round-2 resolution assessment
All four Round-2 findings correctly and completely resolved (F1 steal-window verified executable; F2 exhaustion exit both directions; F3 C4 lattice; F4 A7 like-for-like). Round-2 revisions from other experts check out against the repo (widened .tsx filter, input-derived 12-file M3 set, bare-token scope, retry/repeats zero baseline, RuntimeConfig closure) — modulo F2's overclaim sentence.

## Recurring Issue Check
R3: Finding F1 (coverage fix not propagated to fifth subset). R12: Finding F1. R29: Finding F2; all other claims verified OK. R16/R18/R33/R34/R36/R41/R42(dynamic)/R44/R45/R47/R48/R49/R50/R54: OK. RT1/RT2/RT4/RT7/RT9/RT10/RT11: OK. Others N/A.

```json
[
  {"id":"F1","severity":"Major","title":"C2 coverage enumeration omits the module-scope-let subset and its derivation command is unrecorded, disarming both fail-loud guards","file":"docs/archive/review/extension-test-order-deps-plan.md","line":259,"adjacent":false,"escalate":null},
  {"id":"F2","severity":"Minor","title":"Bare-token shuffle pattern overclaims 'any new match IS the thing forbidden' — comment/string false positives unbounded, no allow path","file":"docs/archive/review/extension-test-order-deps-plan.md","line":331,"adjacent":false,"escalate":null}
]
```
---

# Plan Review: extension-test-order-deps — Round 4
Date: 2026-08-22
Review round: 4

## Changes from Previous Round
All 4 Round-3 merged findings applied (consumer-file + config seed/retry patterns with A5 pairwise-distinct clause and four-residue statement; C2 five-subset enumeration with verbatim derivation commands; bare-shuffle deny boundary + allow path; I4 early-exit clause).

## Round-4 verdicts on Round-3 fixes
All three experts confirm every Round-3 finding fully resolved, with the supporting claims independently re-verified by execution (vitest seed-default line verbatim; corpus-clean claims; command counts 23/10/12/3; A5 distinctness cannot false-fail).

## Merged Findings — Minor only, no Critical/Major

| ID | Severity | Saturation label | Title | By |
|----|----------|------------------|-------|----|
| R4-1 | Minor | prose-only (R42) | Config file lacks the exclusivity clause consumer files have (exclude/include/passWithNoTests escape key enumeration) | sec(F10) |
| R4-2 | Minor | prose-only (R29) | Bare-shuffle allow path misattributes culprit-naming comments to an I2 mandate | test(F1) |
| R4-3 | Minor | design-level narrow (R47) | Committed sequencer: in config un-randomizes the file-order axis (secondary axis, zero known members) while the gate looks on | func(F14) |

All three applied to the plan immediately after Round 4 (C3 signature exclusivity clause; I2-mandate reword; (shuffle|seed|sequencer) config pattern). Round 5 verifies.

# Security Review — Round 4 (incremental)

**Round-3 fix verification:**
- **F8 (seed pinning) — fix correct and complete on all three parts.** Consumer-file row + rationale + allow boundary; config-side `(shuffle|seed)\s*:` + corpus-clean; A5 pairwise-distinct with loud failure. Four-residue adjudication paragraph accurate.
- **F9 (destructured ctx.skip) — fix correct.** I4 early-exit clause; owner's criterion now fires.
- **Convergent items `#3`/`#4` — no security holes introduced.** Five-subset enumeration with verbatim commands; bare-shuffle deny/allow boundary sound (named-flagged-adjudicated, cannot smuggle options-position occurrence).

**Final class re-derivation over writable surfaces:**
- In-test options/chainables: closed (dot-form, options-object, retry/repeats options, suite shuffle any position, destructured ctx.skip via I4). expect.soft still fails the task; tags inert without filter flag; no retry chainable.
- Runtime API: vi.setConfig closed by construction; Math.random stubbing cannot reorder (sequencer's shuffle(tasks, sequence.seed) is seeded, order fixed before any test body runs).
- Consumer scripts: closed at MECHANISM level — C3 signature forbids any change to those files; the pattern row is defense-in-depth. Every unenumerated flag (--exclude, --testNamePattern, --passWithNoTests, …) already denied wholesale.
- Config keys: the one surface still guarded by enumeration only — F10.

## Findings

### F10 — Severity: Minor — config file lacks the exclusivity clause its consumer files have; unenumerated config keys (exclude:/include:/passWithNoTests:) ride along un-adjudicated (saturation: prose-only; R42)

**Problem:** Consumer-file surface closed by an exhaustive signature statement ("No change to package.json scripts, pre-pr, or CI workflows"). The config has no equivalent: the signature says the config "gains test.sequence.shuffle: true" — implies but never states that the gain is the ENTIRE diff to that file — and the forbidden list polices it by key enumeration only. Unenumerated gate-neutralizing keys exist: `test.exclude: ['**/dpop-key.test.ts']` removes all 10 DPoP security-control tests from every standing consumer; narrowed `include` + `passWithNoTests: true` shrinks the adjudicated set arbitrarily. Four rounds added config-key spellings one at a time (isolate → shuffle: → retry:/seed:) — the recurring signal that the mechanism, not the member list, should carry the control.

**Impact:** Low — a rogue key must survive PR-diff review of a ~16-line file; but adjudication is implicit where every other surface's is explicit, and the enumeration game has no terminating move.

**Recommended action:** One mechanism-level clause in the C3 signature: "the diff to extension/vitest.config.ts is exactly the single sequence.shuffle: true gate line; any other hunk in that file is a named deviation-log entry, whatever its spelling" (deny = any extra hunk; allow = deviation-log path; fails loudly by construction — diff-shape, not key-name). Keep the existing key-enumerated patterns as high-risk callouts.

No other findings. A5 distinct-seeds has no false-positive path (Date.now()-derived seeds across multi-second runs); comment/string allow path cannot admit options-position occurrences; RS4 unchanged, clean.

## Recurring Issue Check

| Rule | Status |
|---|---|
| R1–R2 | N/A |
| R3 | OK |
| R4–R15 | N/A |
| R16 | OK |
| R17–R28 | N/A |
| R29 | OK — Round-3 additions carry their own derivation commands and corpus-clean verifications |
| R30–R32 | N/A |
| R33 | OK — consumer-flag drift closed at both pattern and signature level |
| R34 | OK |
| R35 | N/A |
| R36 | OK — suppression class closed over dot, options, retry, destructured-skip, assertion-deletion spellings |
| R37–R41 | N/A |
| R42 | Finding F10 (config-key surface enumeration-guarded; exclusivity clause missing) |
| R43 | N/A |
| R44 | OK — seed-pinning laundering closed |
| R45–R46 | N/A |
| R47 | OK — every banned spelling's regex at least as strong as the spelling; residues honestly listed |
| R48 | N/A |
| R49 | OK — four-residue statement matches implementation |
| R50 | OK |
| R51–R57 | N/A |
| RS1–RS3 | N/A |
| RS4 | OK |
| RS5–RS6 | N/A |

```json
[
  {"id":"F10","severity":"Minor","title":"Config file lacks the exclusivity clause consumer files have; unenumerated keys (exclude/include/passWithNoTests) escape the pattern list","file":"docs/archive/review/extension-test-order-deps-plan.md","line":285,"adjacent":false,"escalate":null}
]
```
# QA/Testing Review — Round 4 (incremental)

## Verification performed
- `#1` (C2 five-subset enumeration + commands): coverage clause enumerates all five subsets matching the five Set B bullets one-to-one; every bullet records a derivation command. Commands verified: stubGlobal for-loop → 23 (ran it); let-set → 10; M3 → 12; spyOn → 3; widened override grep. Reconciliation's left side exists for every subset. Stale sentence replaced. Resolved.
- `#2` (bare-shuffle deny/allow): overclaim gone; deny boundary + allow path stated. Config-side corpus claim verified: zero `seed` occurrences (case-insensitive) in tests, config, package.json. Resolved (one wording nit — F1).
- `#3` (consumer row + A5 distinctness + four residues): vitest citation verified verbatim (coverage.DM_a_rWm.js:481). A5 false-fail check: seed granularity is ms and each run is a fresh ~7 s process, so pairwise-distinct seeds are guaranteed on legitimate execution — the clause cannot false-fail, and composes with the rtk capture note. Four-residue statement maps one-to-one onto the pattern rows. No forbidden row matches the PR's own planned diff.
- `#4` (I4 early-exit clause): consistent with residue note; destructured skip I4-owned in both places. Resolved.

## Findings

### F1 — Minor (prose-only, R29): allow-path example misattributes culprit-naming comments to an I2 mandate
The bare-shuffle row says "the culprit-naming comments I2 mandates". I2 mandates culprit naming IN THE PHASE 2 DEVIATION LOG, not as in-code comments; no clause mandates such comments in test files. Impact: mild executor confusion (harmless extra work, or a reviewer demanding comments). Allow-path function unaffected.
Fix: reword to "e.g., an optional culprit-naming comment such as 'leak surfaced by the shuffle gate at seed N' (the mandated location for culprit naming is I2's deviation log)". Nothing else changes.

No other findings. Coordinator-flagged hazards checked and clean: A5 distinctness cannot false-fail; five-subset enumeration matches bullets exactly with verified command per subset; no acceptance can false-fail on legitimate execution; four-residue statement / pattern rows / I4 / residue note mutually consistent.

## Round-3 resolution assessment
Both Round-3 findings fully resolved (F1 fifth subset enumerated + command recorded + fail-loud guard armed; F2 overclaim removed, deny boundary + flagged-not-failed allow path wired to I4).

## Recurring Issue Check
R29: Finding F1 (I2-mandate misattribution); all other claims verified OK. R3/R12/R16/R18/R21/R33/R34/R36/R41/R42/R44/R45/R47/R48/R49/R50/R54: OK. Others N/A.
RT1/RT2/RT4/RT7/RT9/RT10/RT11: OK; RT3/RT5/RT6/RT8: N/A. RT4 note: A5 soak now provably samples 10 distinct permutations.

```json
[
  {"id":"F1","severity":"Minor","title":"Bare-shuffle allow path misattributes culprit-naming comments to an I2 mandate (I2 mandates the deviation log, not code comments)","file":"docs/archive/review/extension-test-order-deps-plan.md","line":344,"adjacent":false,"escalate":null}
]
```# Functionality Review — Round 4 (incremental)

## Round-3 resolution verification
- F11 resolved: consumer row + config row + A5 distinctness + four residues. Claims verified by execution: `resolved.sequence.seed ??= Date.now()` exists verbatim (coverage.DM_a_rWm.js:481, gated on shuffle active); zero-`seed` corpus claim accurate; new consumer-file regex has zero baseline matches in package.json / pre-pr.sh / workflows. A5 distinctness logic sound (Date.now()-derived seeds per run; a repeat can only mean pinning or capture failure).
- F12 resolved: stale sentence gone; stubGlobal bullet carries verbatim command (→23, re-verified); let bullet carries command (→10); all five Set B bullets carry commands — claim true.
- F13 resolved: deny boundary + allow path stated; overclaim removed.
- Security F9 consistent: I4 early-exit clause closes the unreachable-assertions hole; coheres with residues note.

## New findings

### F14 — Minor (design-level narrow residue, R47): a committed `sequencer:` in the config silently un-randomizes the file-order axis while the gate still looks fully on
Verified against installed 4.1.10 (coverage.DM_a_rWm.js:470-481): boolean-shuffle assigns RandomSequencer only under `if (!resolved.sequence?.sequencer)` — a user-supplied `sequence: { shuffle: true, sequencer: BaseSequencer }` is respected, so file order reverts to cache/duration sort while shuffle stays truthy: in-file shuffling continues AND the seed line still prints (cli-api:1993 fires on the `|| shuffle` arm). Config-side pattern `(shuffle|seed)\s*:` does not match `sequencer\s*:`. Neutralizes only the SECONDARY axis (cross-file guard; zero known members today — fact 1, isolate default), hence Minor. CLI exposure nil (option takes a class, not a string) — consumer row needs no change.
Fix: widen config pattern to `(shuffle|seed|sequencer)\s*:` — corpus-clean (none of the three tokens in current config; verified), no false-positive baseline, allow path unchanged; a legitimate custom sequencer takes the sibling rows' deviation-log path.

No other findings: the four revisions are correct and internally consistent; every new quantitative/cited claim reproduced under execution.

## Recurring Issue Check
R29: OK (all Round-4 claims verified: seed-default line verbatim; zero-seed corpus true; regex baselines clean; five-bullets-with-commands true). R47: Finding F14. R3/R16/R18/R33/R34/R36/R41/R42/R44/R45/R48/R49/R50/R53: OK. Others N/A.

```json
[
  {"id":"F14","severity":"Minor","title":"Committed sequencer: in config un-randomizes the file-order axis while seed printing and in-file shuffle keep the gate looking on; config-side pattern misses the spelling","file":"docs/archive/review/extension-test-order-deps-plan.md","line":344,"adjacent":false,"escalate":null}
]
```
---

# Plan Review: extension-test-order-deps — Round 5 (final)
Date: 2026-08-22
Review round: 5

## Changes from Previous Round
All 3 Round-4 Minor findings applied (config-diff exclusivity clause; I2-mandate reword; (shuffle|seed|sequencer) config pattern).

## Round-5 verdicts
- Functionality expert: No findings (all Round-4 fixes verified; three-token corpus re-verified by execution; exclusivity clause composes with the setup.ts contingency from the functionality reading).
- Security expert: No findings (all four writable surfaces closed at mechanism level or by construction; reviewer also corrected their own Round-2 isolated-line reading of the sequencer guard).
- Testing expert: 1 Minor, prose-only (R48) — exclusivity clause vs setup.ts contingency adjudicate one predicate differently. RESOLVED in the plan immediately: the clause now names the setupFiles contingency as the single plan-foreseen exception, admitted with its own red-proof/full-sweep evidence and still recorded as a named entry.

## Saturation call (per Step 1-6 criteria)
All four conditions hold for Round 5:
1. Five rounds completed (Round 1 full; Rounds 2-5 incremental).
2. No Critical or Major finding open in any category (Round-5's single Minor is resolved in the plan file, not dispositioned away).
3. No finding against the design itself — the sole Round-5 finding was labeled prose-only (R48) by the expert who filed it; the two other experts returned No findings.
4. Every remaining finding: none remain open. (The resolved Minor was kind (a) prose-only.)
Per-finding labels as filed: test-F1 = prose-only/R48. No Carried-Forward Plan Findings — nothing is open.

Exit: Phase 1 review loop closes at Round 5. Go/No-Go Gate: C1-C4 all locked (no round after locking materially changed a contract's signature/invariants/forbidden list/acceptance without re-review — every change was itself reviewed in the following round, and Round 5 ends with two No-findings and one resolved prose Minor).

# Functionality Review — Round 5 (incremental)

## Round-4 resolution verification
- **F14 (sequencer:) — resolved.** Config pattern `(shuffle|seed|sequencer)\s*:` with the exact mechanism in the reason text; `if (!resolved.sequence?.sequencer)` guard matches installed 4.1.10 (coverage.DM_a_rWm.js:476-477). Three-token corpus claim re-verified by execution: zero matching files across tests, config, package.json.
- **Security F10 (exclusivity clause) — verified from the functionality side.** Diff-shape adjudication closes the unenumerated-key family without spelling enumeration; key patterns correctly demoted to callouts. Checked the one potential collision: the Testing-strategy contingency (shared setup.ts → setupFiles hunk) COMPOSES with the clause — the sanctioned path for that hunk is exactly the named deviation-log adjudication the clause prescribes, not a bypass. Single-gate-line diff shape feasible (`sequence: { shuffle: true },` is one line in the existing test object).
- **Testing F1 (allow-path rewording) — verified.** Consistent with I2's own wording; no drift.

## Findings

No findings.

Cross-checks this round: exclusivity clause vs every plan section touching vitest.config.ts (isolate/(retry|repeats) rows remain consistent as callouts; SC3 keeps environmentMatchGlobs untouched); three-token corpus by execution; A-ID cross-references (A1–A4, A3m, A5–A8) consistent; new citations match lines independently verified in Round 4. Every quantitative or cited claim now has a reproducing command or verified citation; each control declares class, deny boundary, allow path, fail-loud exit.

## Recurring Issue Check
R3: OK (all propagation gaps rounds 1-4 closed; exclusivity clause closes the residual key-name class mechanically). R16/R18/R29/R33/R34/R36/R41/R42/R44/R45/R47/R48/R49/R50/R53: OK. R47 note: exclusivity clause converts the config surface from spelling enumeration to diff-shape adjudication — the mechanism-level fix for the class F14 instanced. All others N/A.

```json
[]
```
# Security Review — Round 5 (incremental)

Verification: installed source coverage.DM_a_rWm.js:475-477 confirms the ternary assignment IS guarded by `if (!resolved.sequence?.sequencer)` (corrects the reviewer's own Round-2 isolated-line reading) — the plan's sequencer rationale is accurate. Corpus: zero `sequencer` occurrences in tests, config, package.json — three-token corpus-clean claim holds.

**Round-4 fix verification:**
1. **F10 (config exclusivity clause) — fix correct and complete.** Config diff pinned to exactly the single gate line, adjudicated by diff-shape; other hunks = named deviation entries "whatever its spelling"; examples carried; key patterns retained as callouts. Config surface closed at MECHANISM level — terminates the per-key enumeration game. All four writable surfaces now closed: config (diff-shape exclusivity), consumer scripts (signature no-change + flag pattern), in-test spellings (patterns + I4 absence-inspection), runtime API (closed by construction).
2. **Testing F1 rewording — no security hole introduced.** Deny boundary unchanged; allow path still named-flagged-passed at C1-I4; rewording narrows, not widens.
3. **Func F14 (sequencer:) — fix correct, mechanism claim independently verified this round** (supersedes reviewer's Round-2 unconditional-assignment reading). Corpus-clean verified. Layering consistent: exclusivity clause subsumes; pattern = defense-in-depth callout.

Taxonomy note, below finding threshold: adjudication paragraph counts "four surface-form residues" while sequencer: is a partial-freeze variant of residue `#4` (freezes the file-order axis only). Member denied by two layers; an undercounted taxonomy does not overstate the control — wording preference, not a defect.

**No findings.**

## Recurring Issue Check

| Rule | Status |
|---|---|
| R1–R2 | N/A |
| R3 | OK |
| R4–R15 | N/A |
| R16 | OK |
| R17–R28 | N/A |
| R29 | OK — sequencer guard claim reproduced against installed source; three-token corpus-clean reproduced (0 hits) |
| R30–R32 | N/A |
| R33 | OK |
| R34 | OK |
| R35 | N/A |
| R36 | OK — suppression class closed; allow paths fail loudly through the deviation log |
| R37–R41 | N/A |
| R42 | OK — config surface converted from enumeration to mechanism; all four writable surfaces closed at mechanism level or by construction |
| R43 | N/A |
| R44 | OK — exit-code laundering members (retry, seed pinning, sequencer) all denied; A5 distinct-seeds stands |
| R45–R46 | N/A |
| R47 | OK — every pattern at least as strong as its target spelling |
| R48 | N/A |
| R49 | OK — control class accurate; taxonomy undercount does not overstate |
| R50 | OK |
| R51–R57 | N/A |
| RS1–RS3 | N/A |
| RS4 | OK |
| RS5–RS6 | N/A |

```json
[]
```
# QA/Testing Review — Round 5 (incremental)

## Verification performed
- `#2` (Round-4 F1): allow-path example now matches I2's actual text exactly. Resolved.
- `#3` (sequencer row): verified against installed vitest (coverage.DM_a_rWm.js ~477-481): `if (!resolved.sequence?.sequencer)` → `sequencer = shuffle ? RandomSequencer : BaseSequencer` — config `sequencer:` preempts RandomSequencer while in-file shuffle and seed printing continue. Corpus-clean verified: zero case-insensitive occurrences of shuffle/seed/sequencer across tests, config, package.json.
- `#1` (exclusivity clause): coexistence with key-enumerated rows coherent (shape check = mechanism, key rows = callouts; both converge on named-deviation adjudication). One internal tension — F1.
- No acceptance criterion gained a false-fail path; A5–A8, A1–A4, A3m, four-residue statement, consumer walkthrough mutually consistent.

## Findings

### F1 — Minor (prose-only, R48): config-diff exclusivity clause contradicts the plan's own setup.ts/setupFiles contingency
C3 Signature says the config diff "is EXACTLY that single gate line", but the Testing strategy pre-sanctions a second hunk (setupFiles: src/__tests__/setup.ts) with its own evidence protocol and no mention of the deviation entry the clause demands. Two clauses adjudicate the same predicate by different semantics. Bounded impact: both routes fail-loud-adjacent; no key pattern falsely fires on a setupFiles hunk (checked).
Fix: one sentence in the exclusivity clause naming the setupFiles contingency as the single plan-foreseen exception, admitted WITH its evidence and still recorded as a named entry; any other hunk remains a deviation.

No other findings.

## Round-4 resolution assessment
Round-4 F1 resolved exactly per remedy. Other two revisions check out against ground truth (sequencer mechanism + three-token corpus verified; exclusivity clause mechanically sound — its one prose conflict is F1).

## Recurring Issue Check
R29: OK (sequencer guard + three-token corpus verified verbatim). R48: Finding F1. R12/R16/R18/R21/R33/R34/R36/R41/R42/R44/R45/R47/R49/R50/R54: OK. RT1/RT2/RT4/RT7/RT9/RT10/RT11: OK. Others N/A.

```json
[
  {"id":"F1","severity":"Minor","title":"Config-diff exclusivity clause contradicts the plan's own sanctioned setupFiles contingency (two clauses adjudicate the same hunk differently)","file":"docs/archive/review/extension-test-order-deps-plan.md","line":287,"adjacent":false,"escalate":null}
]
```