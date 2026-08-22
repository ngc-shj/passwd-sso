# Code Review: extension-test-order-deps
Date: 2026-08-23
Review round: 1

## Changes from Previous Round
Initial review (incremental on top of the Phase 2 self-R-check baseline).

## Merged Findings (convergence-corrected)

| ID | Severity | Title | Convergent |
|----|----------|-------|------------|
| CR1 | Major | keyed decryptData install in 1 of 10 describes; impl+map leak across suites (background.test.ts) | func(F1) |
| CR2 | Major | vi.useFakeTimers restore trailing in-body; assertion throw leaks fake clock (login-detector) | test(1 Major)+func(F2) |
| CR3 | Major (floored) | getComputedStyle spy restore not failure-safe (form-detector.test.ts) | sec(F1)+func(F4) |
| CR4 | Major (floored) | deleteTestDb onblocked→resolve fail-open baseline reset (dpop-key) | sec(F2)+func(F5)+test(3) |
| CR5 | Minor | find-mock overrides persist; no C2 row (login-detector) | test(2) |
| CR6 | Minor | Stale comment references removed decryptResponses (background.test.ts:1129) | func(F3) |
| CR7 | Minor | Listener teardown drops registration options (form-detector-entry) | test(4) + sec Adjacent |
| CR8 | Minor | Seed 52 provenance unrecorded in A3 evidence row | test(5) |
| CR9 | Minor | C2 contained-table path typo | test(6) |

Convergence per 'Perspective Convergence as a Severity Signal': CR2 max severity Major; CR3/CR4 floored Minor→Major (multi-perspective).

## Ollama merged prose

## Recurring Issue Check
### Functionality expert
R1 OK (helper extracted, both consumers import). R2 OK. R3 Finding F1/F2/F4 (fix patterns incompletely propagated within changed files). R17 Finding F1. R19 OK. R21 OK. R29 Finding F3 (stale reference; other citations verified accurate). R33 OK. R34 F2/F4/F5 carry fixes not deferrals. R36 OK. R42 F2 class note (fake-timer state never a Set B bullet) + F1 (fix-introduced state outside derivation). R47 OK. R49 OK. R50 Finding F5. RT1 OK. RT7 OK (verify-not-redo). RT11 Finding F1, F5. Others N/A.

### Security expert
R1 Pass (helper extracted). R17/R19 Pass. R21 Pass. R29 Pass (dpop constants claim verified; D5 verified against source). R33 Pass. R34 Pass. R36 Pass. R42 Pass. R47/R49 Pass. R44/R50 Pass. RS1-RS3, RS5, RS6 N/A. RS4 Pass. RT1 Pass with F1/F2 notes. RT4 Pass. RT5 Pass. RT7/RT10 Pass. RT9 Pass. RT11 F1, F2 (Minor). Others N/A.

### Testing expert
R21 clean (name-only diff verified; probe absent). R36/C1-I4 clean (zero suppression spellings; assertions byte-identical or strengthened). RT7 evidence recorded deny/allow; one provenance gap → Finding 5. C3 forbidden patterns clean. R19 twins untouched. R42 counts carry commands; one occurrence-level gap → Finding 2; background.test.ts:2779 verified contained. RT1 keyed mock fidelity increased; fail-loud miss. Gate not vacuous (execution + printed seed; consumers read exit code). Others N/A or owned by siblings.

## Merged Findings

### 1. background.test.ts:236
- **Severity:** Major
- **Problem:** Keyed `decryptData` mock installed in only 1 of 10 `describe` blocks; implementation + mutable responses map leak into the other nine suites. `keyedDecrypt.install()` runs only in the "background message flow" `beforeEach`. Other describes run `clearAllMocks` only and never reinstall, causing them to consume either the `vi.hoisted` default or the leaked keyed implementation depending on suite order.
- **Impact:** Test isolation is violated. Assertions in other suites may pass insensitively to leaked content rather than being properly isolated, breaking the plan's universal invariant and causing flaky or misleading test results.
- **Recommended action:** Hoist `keyedDecrypt.install()` into a file-level `beforeEach` before the first `describe`. Drop the in-describe call. Add a fail-loud mechanism (named miss-throw) for unmapped ciphertexts to ensure deterministic behavior.
- **Perspectives flagged:** Functionality

### 2. login-detector.test.ts:695-730
- **Severity:** Major
- **Problem:** `vi.useRealTimers()` placed trailing in-body rather than in a failure-safe block; an assertion throw leaks the fake clock state to later tests. This is the sole outlier in the changed set, as every other fake-timer site uses `try/finally`.
- **Impact:** Frozen `Date.now()` state smears into subsequent tests, causing triage noise on red runs, polluting printed-seed attribution, and potentially causing unrelated tests to fail or pass incorrectly due to mocked time.
- **Recommended action:** Wrap timer restoration in a `try/finally` or move `vi.useRealTimers()` to an `afterEach` hook (unconditional, idempotent, and covers future fake-timer tests).
- **Perspectives flagged:** Functionality, Testing

### 3. background.test.ts:1122
- **Severity:** Minor
- **Problem:** Stale comment references removed identifier `decryptResponses` (extracted to `keyedDecrypt`/`helpers/keyed-decrypt-mock` by the R1 helper).
- **Impact:** Documentation drift that confuses maintainers during code review and future refactoring.
- **Recommended action:** Update the comment to reference the new identifier (`keyedDecrypt` / `helpers/keyed-decrypt-mock`).
- **Perspectives flagged:** Functionality

### 4. form-detector.test.ts:145-158
- **Severity:** Minor
- **Problem:** `getComputedStyle` spy restore is skipped on the failure path (no `try/finally`).
- **Impact:** Behaviorally transparent today but fragile; assertion failures could leave spy state leaked to sibling tests or subsequent run phases, making future debugging difficult.
- **Recommended action:** Wrap spy installation/cleanup in `try/finally` to guarantee `mockRestore` on all execution paths, matching the pattern used in `totp-handlers`.
- **Perspectives flagged:** Functionality, Security

### 5. dpop-key.test.ts:59
- **Severity:** Minor
- **Problem:** `deleteTestDb` resolves on `onblocked` instead of rejecting, converting a failed baseline reset into a silent pass.
- **Impact:** If an IndexedDB connection leaks, the reset appears successful but actually "examined nothing." Subsequent `open()` calls queue behind the pending delete, causing opaque 5-second timeouts without naming the culprit. Violates fail-open/clean-error expectations.
- **Recommended action:** Reject with a named error on `onblocked` so leaking tests fail loudly by name. The normal path still resolves via `onsuccess`.
- **Perspectives flagged:** Functionality, Security, Testing

### 6. login-detector.test.ts:673-674
- **Severity:** Minor
- **Problem:** `mockFindPasswordInputs`/`mockFindUsernameInput` `mockReturnValue` overrides persist in test bodies; only `clearAllMocks` exists in the outer `beforeEach`.
- **Impact:** Latent mock pollution across tests. Currently mitigated because every consuming test sets its own values, but violates strict test isolation principles and could cause failures if test execution order changes.
- **Recommended action:** Add explicit `mockReset()` calls beside other mock resets in the local `beforeEach`, or document as a contained audit row.
- **Perspectives flagged:** Testing

### 7. form-detector-entry.test.ts:84-105
- **Severity:** Minor
- **Problem:** Event listener wrapper tracks only the listener function but not registration options.
- **Impact:** A future `{ capture: true }` registration would defeat `removeEventListener` silently, leading to memory leaks and unexpected side effects.
- **Recommended action:** Push `{listener, options}` pairs to the tracking array and pass options through during teardown.
- **Perspectives flagged:** Testing

### 8. docs/archive/review/extension-test-order-deps-deviation.md
- **Severity:** Minor
- **Problem:** Deviation log contains two documentation issues: (1) Seed 52 in A3 row lacks recorded sweep provenance, and (2) contained-table path typo (`totp-handlers/background.test.ts` instead of `background/totp-handlers.test.ts`).
- **Impact:** Minor documentation inaccuracies affecting audit traceability and file path references for reviewers.
- **Recommended action:** Annotate the producing command for seed 52 or correct the sweep number. Fix the path typo in the contained table.
- **Perspectives flagged:** Testing

## Quality Warnings
No quality warnings triggered. All merged findings contain specific file/line references, concrete root-cause explanations, measurable impacts, and actionable fixes. No findings rely on unverified claims, lack evidence paths, or recommend testing without confirming target testability.

## Expert outputs (verbatim)

# Functionality Code Review R1 — fix/extension-test-order-deps

Checklist cross-check: all nine Implementation Checklist deliverables present in the diff; extra diff files accounted for (context-menu/form-detector C2 rows, helper = R1 remedy). Config single hunk = gate line + comment; no neutralizing key. Forbidden-pattern scan clean (comment-position "shuffled" tokens passed per allow path). C1-I4 holds.
Verified: keyed-mock first-arg shape matches production decryptData call sites; dpop-key comment IDB semantics accurate; TEST_IDB constants mirror private IDB_NAME/IDB_STORE (L22-23, unexported); 200 ms debounce claim matches context-menu.ts:14; all IDB connections closed on both paths; messaging L18/38/51 converted per C2 row.

## Findings

### F1 — Major — background.test.ts:236 — keyed decryptData mock installed in only 1 of 10 describes; implementation + mutable responses map leak into the other nine
keyedDecrypt.install() runs only in the "background message flow" beforeEach. The other describes (session persistence 1521, session hydration 1734, token refresh alarm 1850, hydration edge cases 2112, failsafe responses 2163, CHECK_PENDING_SAVE host validation 2372, LOGIN_DETECTED suppresses on own app 2540, PASSKEY handlers 2655) run clearAllMocks only and never reinstall — which decryptData they get depends on suite order: the vi.hoisted default if before any flow test, or the LEAKED keyed implementation whose "11" entry holds whatever the last-run flow test wrote. CHECK_PENDING_SAVE's helper comment premise ("cached entries have urlHost 'example.com' from decryptData mock") is false under the leaked map; green today only because assertions are insensitive to the leaked content, not isolated from it. Violates the plan's universal invariant in a new spelling introduced by the fix; outside the C2 audit (arises from the fix, not a Set B pattern).
Fix (Remedy Floor): hoist install into a file-level beforeEach before the first describe; drop the in-describe call. Boundary/tie: outer hooks run before inner, so tab-event-badge's inner mockResolvedValue re-establishment still wins deterministically. Allow: recorded seed set stays green (file-level "11" default byte-identical to hoisted default). Deny-proof: scratch copy with sentinel "11" plaintext shows other describes consuming the deterministic install. Fail loudly: unmapped ciphertexts in any describe now hit the named miss-throw.

### F2 — Minor — login-detector.test.ts:696-729 — vi.useFakeTimers restored only by in-body useRealTimers; assertion throw leaks fake clock
Identical cascade shape D4 fixed for cleanup.destroy() in the same describe. popup/App.test.tsx:204-222 (same diff) shows the correct try/finally. Fix: try/finally or afterEach guard; assertions untouched.

### F3 — Minor — background.test.ts:1122 — stale comment "(see decryptResponses above)" — identifier removed by the R1 helper extraction. Fix: reference keyedDecrypt / helpers/keyed-decrypt-mock.

### F4 — Minor — content/form-detector.test.ts:145-156 — getComputedStyle spy restore not failure-safe (behaviorally transparent today; C2 row notes it). Fix: try/finally like totp-handlers:226-247.

### F5 — Minor — dpop-key.test.ts:52-62 — deleteTestDb resolves on onblocked; fail-open baseline reset. Fix: reject with named error; allow side unaffected (all current connections closed).

Cross-cutting: keyed-decrypt adoption elsewhere = documented contained verdicts (D2); no raw indexedDB.open remains outside dpop-key; form-detector-entry is the only entry-point-importing file; fake-timer global state is a class the Set B derivation never enumerated (F2 the only in-file instance; popup/App's is try/finally-safe).

## Seed Finding Disposition
Seed empty (No findings) — no dispositions to record.

## Recurring Issue Check
R1 OK (helper extracted, both consumers import). R2 OK. R3 Finding F1/F2/F4 (fix patterns incompletely propagated within changed files). R17 Finding F1. R19 OK. R21 OK. R29 Finding F3 (stale reference; other citations verified accurate). R33 OK. R34 F2/F4/F5 carry fixes not deferrals. R36 OK. R42 F2 class note (fake-timer state never a Set B bullet) + F1 (fix-introduced state outside derivation). R47 OK. R49 OK. R50 Finding F5. RT1 OK. RT7 OK (verify-not-redo). RT11 Finding F1, F5. Others N/A.

```json
[
  {"id":"F1","severity":"Major","title":"Keyed decryptData mock installed in 1 of 10 describes; implementation+map leak across suites in background.test.ts","file":"extension/src/__tests__/background.test.ts","line":236,"adjacent":false,"escalate":null},
  {"id":"F2","severity":"Minor","title":"vi.useFakeTimers not failure-safe; assertion throw leaks fake clock to later tests","file":"extension/src/__tests__/login-detector.test.ts","line":696,"adjacent":false,"escalate":null},
  {"id":"F3","severity":"Minor","title":"Stale comment references removed identifier decryptResponses","file":"extension/src/__tests__/background.test.ts","line":1122,"adjacent":false,"escalate":null},
  {"id":"F4","severity":"Minor","title":"getComputedStyle spy restore skipped if assertion throws (no try/finally)","file":"extension/src/__tests__/content/form-detector.test.ts","line":145,"adjacent":false,"escalate":null},
  {"id":"F5","severity":"Minor","title":"deleteTestDb resolves on onblocked — fail-open baseline reset","file":"extension/src/__tests__/dpop-key.test.ts","line":60,"adjacent":false,"escalate":null}
]
```
# Security Code Review R1 — fix/extension-test-order-deps

## Seed Finding Disposition
Seed empty (No findings) — no dispositions to record.

Verification: C3 exclusivity SATISFIED (single hunk, gate line + comment; repro text in comment = allow path). Forbidden-pattern sweep over 350 added lines CLEAN (comment-position shuffle tokens flagged-and-passed). C1-I4 SATISFIED (2 deleted expects re-added verbatim in try block; login-detector deletions are teardown relocation that STRENGTHENS isolation; security-control assertions in dpop-key preserved: JKT format, exactly-one-row, non-extractable key, RFC 9449 no-cnf.jkt; webauthn untouched). D5 triage HOLDS (crypto.ts:145-167 decryptData stateless, pure function; fire-and-forget consumer real at background/index.ts:2215 → getCachedEntries:266 → decryptOverviews:1110, but each call decrypts its own ciphertext — mis-association structurally impossible in production). RS4 CLEAN (canonical fake fixtures; miss error names mock-input ciphertext, not plaintext). RT1 spot checks: schema-safe openTestDb does NOT mask production onupgradeneeded regression (beforeEach deletes DB; most tests hit production openDb() first on version-0). R21 residue clean.

## Findings

### F1 — Minor — content/form-detector.test.ts:145-158 — spy restore skipped on failure path (RT11-shaped; bounded: fallthrough-transparent, fires only when file already red). Fix: try/finally like totp-handlers.

### F2 — Minor — dpop-key.test.ts deleteTestDb onblocked → resolve() — silent no-op if a connection leaks; "examined nothing" spelled as "reset done" (fail-open cleanup the M4 fix depends on; latent — all current tests close connections). Fix: reject with named error so the leaking test reds by name.

[Adjacent] test-quality: form-detector-entry addEventListener wrapper tracks only "error"-type listeners; other types would accumulate — shuffle gate is the standing detector for that class.

No Criticals; no escalations.

## Recurring Issue Check
R1 Pass (helper extracted). R17/R19 Pass. R21 Pass. R29 Pass (dpop constants claim verified; D5 verified against source). R33 Pass. R34 Pass. R36 Pass. R42 Pass. R47/R49 Pass. R44/R50 Pass. RS1-RS3, RS5, RS6 N/A. RS4 Pass. RT1 Pass with F1/F2 notes. RT4 Pass. RT5 Pass. RT7/RT10 Pass. RT9 Pass. RT11 F1, F2 (Minor). Others N/A.

```json
[
  {"id":"F1","severity":"Minor","title":"getComputedStyle spy mockRestore after assertion without try/finally; leaks on assertion failure","file":"extension/src/__tests__/content/form-detector.test.ts","line":145,"adjacent":false,"escalate":null},
  {"id":"F2","severity":"Minor","title":"deleteTestDb onblocked resolves instead of rejecting — leaked IDB connection silently skips M4 baseline reset","file":"extension/src/__tests__/dpop-key.test.ts","line":59,"adjacent":false,"escalate":null}
]
```
# Testing Code Review R1 — fix/extension-test-order-deps

Spot-checks: keyed-decrypt install/beforeEach interplay sound (install after clearAllMocks in all three consuming scopes; hazardous mockReset sites removed; background.test.ts:2779 persistent override in-beforeEach, race-immune, matches contained row; keying on ciphertext INCREASES fidelity — a blob/overview swap in production would now red where positional was ambiguous). login-detector destroy idempotent (lib:301-309) so afterEach double-destroy safe. form-detector-entry wrapper cannot leak the wrapper itself. Gate CI integration verified (single-hunk config; consumers inherit; path filter extension/** sound for this class; no forbidden patterns in consumers; helper not matched by *.test.* include — 61-file count holds). Acceptance table consistent with A1-A8/A3m; A5 seeds pairwise distinct; A6 both directions; re-seed/exhaustion correctly unneeded; note A8 cites check-pre-pr.sh wrapper (executes the full script — worth one confirming sentence).

## Findings

### 1 — Major — login-detector.test.ts:695-730 — vi.useRealTimers() trailing in-body; the exact skipped-trailing-cleanup class D4 fixed for cleanup.destroy() in the same describe
Assertion throw at 712/724 leaks fake timers (frozen Date.now) into later tests. Every other fake-timer site in the changed set uses try/finally; this is the sole outlier. Blast radius today: triage noise on a red run (smears frozen-clock state, pollutes printed-seed attribution). Fix (Remedy Floor): try/finally or afterEach vi.useRealTimers() (idempotent); allow side: advanceTimersByTime still under fake timers, test greens as-is; red-proof: scratch copy, force line-724 red + probe expect(vi.isFakeTimers()).toBe(false) in next test — probe reds without fix, greens with; prefer afterEach (unconditional; covers future fake-timer tests); assertions byte-identical; boundary: order vs currentCleanup?.destroy() is a tie with no loser (destroy synchronous, timer-free).

### 2 — Minor — login-detector.test.ts:673-674 (+~8 siblings) — mockFindPasswordInputs/mockFindUsernameInput mockReturnValue in test bodies persist (clearAllMocks-only outer beforeEach); occurrence has no C2 row
Same M1 shape as the mockSendMessage fix two lines away. Latent (every consuming test sets its own values; 50-seed sweep green). Fix: add both mockReset() calls beside mockSendMessage.mockReset() in the local beforeEach, or add a contained row; the first also closes the latent leak.

### 3 — Minor — dpop-key.test.ts:59 — onblocked → resolve() converts failed baseline reset into silent pass; next open queues behind pending delete → opaque 5 s timeout with nothing naming the culprit. Fix: reject with named error; allow side: normal path resolves via onsuccess.

### 4 — Minor — form-detector-entry.test.ts (~84-105) — wrapper records listener but not options; a future { capture: true } registration would defeat removeEventListener silently. Fix: push {listener, options} pairs and pass options through.

### 5 — Minor — deviation log A3 row + dpop-key comment — seed 52 exceeds both recorded sweeps ({1..8,12345} and 1..50); no entry names the widened per-file sweep. Fix: annotate the producing command or correct the number.

### 6 — Minor — deviation log contained-table — "totp-handlers/background.test.ts" reverses the actual path background/totp-handlers.test.ts.

[Adjacent] environmentMatchGlobs deprecation — already SC3.

## Seed Finding Disposition
Seed empty (No findings) — no dispositions to record.

## Recurring Issue Check
R21 clean (name-only diff verified; probe absent). R36/C1-I4 clean (zero suppression spellings; assertions byte-identical or strengthened). RT7 evidence recorded deny/allow; one provenance gap → Finding 5. C3 forbidden patterns clean. R19 twins untouched. R42 counts carry commands; one occurrence-level gap → Finding 2; background.test.ts:2779 verified contained. RT1 keyed mock fidelity increased; fail-loud miss. Gate not vacuous (execution + printed seed; consumers read exit code). Others N/A or owned by siblings.

```json
[
  {"id":"1","severity":"Major","title":"Trailing vi.useRealTimers() not exception-safe; same skipped-trailing-cleanup class D4 fixed in same describe","file":"extension/src/__tests__/login-detector.test.ts","line":729,"adjacent":false,"escalate":null},
  {"id":"2","severity":"Minor","title":"find-mock mockReturnValue overrides persist across tests; no C2 classification row","file":"extension/src/__tests__/login-detector.test.ts","line":673,"adjacent":false,"escalate":null},
  {"id":"3","severity":"Minor","title":"deleteTestDb onblocked resolves silently — opaque downstream timeout","file":"extension/src/__tests__/dpop-key.test.ts","line":59,"adjacent":false,"escalate":null},
  {"id":"4","severity":"Minor","title":"Error-listener teardown drops registration options; capture-phase registration would defeat removal","file":"extension/src/__tests__/content/form-detector-entry.test.ts","line":100,"adjacent":false,"escalate":null},
  {"id":"5","severity":"Minor","title":"Seed 52 in A3 evidence has no recorded sweep provenance","file":"docs/archive/review/extension-test-order-deps-deviation.md","line":9,"adjacent":false,"escalate":null},
  {"id":"6","severity":"Minor","title":"Contained-table path typo: totp-handlers/background.test.ts","file":"docs/archive/review/extension-test-order-deps-deviation.md","line":199,"adjacent":false,"escalate":null}
]
```
## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (all contracts verifiable-local). All acceptance paths verified-local; commands and outcomes in the deviation log's Acceptance evidence table (A1-A8, A3m).

## Resolution Status

### CR1 [Major] keyed decryptData install scoped to one describe
- Action: hoisted `keyedDecrypt.install({ "11": DEFAULT_OVERVIEW_PLAINTEXT })` into a FILE-LEVEL beforeEach (outer hooks run before inner, so describe-local re-establishments still win deterministically); removed the describe-local call; rationale comment added.
- Modified file: extension/src/__tests__/background.test.ts (file-level hook before first describe)

### CR2 [Major] fake-timer restore not exception-safe
- Action: wrapped the debounce test body in try/finally with `vi.useRealTimers()` in finally; assertions byte-identical.
- Modified file: extension/src/__tests__/login-detector.test.ts ("allows LOGIN_DETECTED after debounce period expires")

### CR3 [Major, floored] getComputedStyle spy restore not failure-safe
- Action: assertion wrapped in try/finally with `mockRestore()` in finally (same shape as totp-handlers' Date.now spy).
- Modified file: extension/src/__tests__/content/form-detector.test.ts

### CR4 [Major, floored] deleteTestDb onblocked fail-open
- Action: onblocked now REJECTS with a named error ("a previous test left an IDB connection to psso-ext open") — the leaking test reds by name instead of poisoning a later one; allow path (onsuccess) unchanged.
- Modified file: extension/src/__tests__/dpop-key.test.ts (deleteTestDb)

### CR5 [Minor] find-mock persistence + missing C2 row
- Action: `mockFindPasswordInputs.mockReset()` + `mockFindUsernameInput.mockReset()` added beside mockSendMessage.mockReset() in the local beforeEach (closes the latent leak, not just the audit gap); C2 row added to the deviation log.
- Modified files: extension/src/__tests__/login-detector.test.ts; docs/archive/review/extension-test-order-deps-deviation.md

### CR6 [Minor] stale decryptResponses comment
- Action: comment now references helpers/keyed-decrypt-mock.
- Modified file: extension/src/__tests__/background.test.ts:1129

### CR7 [Minor] listener teardown drops options
- Action: wrapper now records {listener, options} pairs and passes options to removeEventListener; type widened accordingly. (The sec-Adjacent "other event types" note remains future-proofing: production registers only "error", and the standing gate detects any new type's leak.)
- Modified file: extension/src/__tests__/content/form-detector-entry.test.ts

### CR8 [Minor] seed-52 provenance
- Action: A3 evidence row now names the per-file discovery sweeps (command shape) that produced seeds > 50.
- Modified file: docs/archive/review/extension-test-order-deps-deviation.md

### CR9 [Minor] contained-table path typo
- Action: corrected to "background/totp-handlers.test.ts and background.test.ts".
- Modified file: docs/archive/review/extension-test-order-deps-deviation.md

Verification after all fixes: `npx tsc --noEmit` clean; 5 shuffled full-suite runs (5 distinct seeds) 1029/1029; A1's 9 recorded seeds re-run green.


---

# Code Review — Round 2 (commit b426424f6)
Date: 2026-08-23

All 9 Round-1 findings verified RESOLVED by all three experts. Security: No findings (R43 check — every hunk tightens: fail-closed reject, guaranteed restores, narrowed cross-describe channel; C1-I4 on the fix diff satisfied — 3 removed expects re-added verbatim in try blocks). Testing: No findings (independent full shuffled run green, seed 1787418987252; CR1 masking check — all non-flow decrypt consumers use ciphertext '11', byte-identical default, net effect strictly stricter since a miss now throws). Functionality: all resolved + ONE new [Adjacent] Minor:

- F6: same failure-unsafe fake-timer restore class as CR2, in non-diff webauthn-bridge-lib.test.ts (last remaining member per a 7-file useFakeTimers sweep).

Disposition: FIXED rather than deferred (close-the-class rule) — commit 1a733a900 adds vi.useRealTimers() to the file's afterEach.

# Code Review — Round 3 (commit 1a733a900)
Date: 2026-08-23

All three experts: **No findings.**
- Functionality: F6 resolved exactly per remedy option 2; afterEach ordering harmless (three independent state subsystems); idempotent with the in-body restore; class closed tree-wide (7/7 files failure-safe).
- Security: 4 additive teardown lines, zero removed; no assertion/suppression change; C3 exclusivity preserved; RS4 clean; tightening only.
- Testing: ordering/idempotency confirmed by execution; class member set re-derived (7 files) and each member's restore mechanism individually verified. One [Adjacent] non-finding observation recorded below.

## Termination (Step 3-8)
Natural stop: all experts returned No findings in Round 3.
R42 expanding-class check: the fake-timer teardown class expanded once (CR2 → F6), below the ≥2-expansion threshold that would mandate a dedicated CI guard; the class was closed by exhaustive execution-derived member enumeration (all 7 useFakeTimers files verified failure-safe by two experts independently), and the standing shuffle gate — itself red-proven in A6 — remains the dynamic adjudicator for the consequence class (any future order-dependence leak).

## Non-finding observation (recorded, no action)
passkey-save-banner.test.ts / save-banner.test.ts afterEach call hideBanner() BEFORE vi.useRealTimers(); a teardown-throw (not assertion-throw) could skip the restore. Both experts classify this as a narrower, cosmetic class in unchanged files — left for a future hygiene pass.

## Resolution Status — final
Rounds: 3. Findings: 9 (R1) + 1 Adjacent (R2) = 10; all resolved (dispositions above and in Round-1 Resolution Status). No open findings. No Anti-Deferral entries pending beyond the plan's SC1-SC4 and deviation-log D1/D2 (documented cost-justifications with revisit triggers).

