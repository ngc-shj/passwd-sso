# Plan Review: autofill-sequential-fill
Date: 2026-10-08
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening was skipped.

## Merged findings
- **P1 [Critical, convergent: Func N1 + Sec F2]** design. Re-detection re-runs page-steerable or self-steered predicates: focus moved by our own writes, the page-wide password fallback, page-wide CC autocomplete, CSS-revealed decoys, and a second write to one element. Decisions must be fixed at T0 and re-detection confined to the T0 root.
- **P2 [Major] Sec F1** design. Per-kind supersession lets a pending LOGIN or CC sequence write into the other kind's field (masked CVV vs password). Use one generation per frame, and supersede on trusted user input.
- **P3 [Major] Func N2** design (R1/R17). The inline LOGIN `executeScript` fallback is a synchronous second writer that C1 does not cover.
- **P4 [Major] Func N3** design. `autofillSuppressUntil` (1500 ms) can expire mid-fill, so the dropdown re-opens.
- **P5 [Major] Func N4** prose. "Unfilled" is undefined.
- **P6 [Major] Func N5** design. MutationObserver null-body guard; error path cleanup.
- **P7 [Critical] Test T1** design (RT4/RT7). The React reproduction is vacuous under `act()`/`fireEvent`.
- **P8 [Major] Test T2–T6** design. Missing tests and contracts: direct `runFillSequence` tests; an injectable window and the deterministic flush order; focused username plus custom fields; LOGIN supersession; settlement or teardown with shuffle on.
- **P9 [Minor] Sec F3** design (R38). Absolute deadline; the check sits in the same task as the write; queued observer callbacks.
- **P10 [Minor] Sec F4** prose (R29/R49/R41). "Wipe" overstates a reference drop.
- **P11 [Minor, Adjacent] Sec F5** design (R42). Custom-field and OTP targets lack a type allowlist and a visibility check.
- **P12 [Minor, Adjacent] Sec F6** design (R51). Delivery is not pinned to `documentId`, and the top frame bypasses `allowedHosts`.
- **P13 [Major, Adjacent] Func N6** design (R42). LOGIN password detection does not exclude CC-claimed fields.
- **P14 [Minor] Test T7** prose. Probe drift.

Conflict resolved: Test T2 asked for "two kinds concurrently without cross-interference", which contradicts Sec F1. Fail-safe precedence applies, so the security design wins and the test asserts cross-kind supersession instead.

## Raw expert outputs
## Functionality Findings (plan round 1)
- **N1 [Critical] design.** FR2 contradicts itself. Each write calls `focus()`, which moves `document.activeElement`. A `resolve()` that re-runs `findFocusedTextInput()` after our own writes therefore picks the wrong username, and through `scopeForm` the wrong form and password. **Fix:** capture every focus-dependent decision (the focused or hinted element, `scopeForm`) once, before the first write. `resolve()` then only re-validates the chosen element, or runs a structural lookup that does not depend on focus.
- **N2 [Major] design (R1/R17).** The LOGIN `executeScript` fallback `injectDirectAutofill` in `background/index.ts` is an inline second writer. It writes custom fields, username and password synchronously, with the pre-fix behaviour, and it is not a C1 consumer. **Fix:** route the fallback through the bundled content script (inject `form-detector.js`, then retry the message), as the CC and Identity fallbacks do. Alternatively, scope it out with a follow-up.
- **N3 [Major] design.** `autofillSuppressUntil` (1500 ms) in the three detectors stops the fill's own `focus()` from re-opening the dropdown. FR1 yields plus the FR3 window can outlast it, so the dropdown re-opens mid-fill. **Fix:** suppress while a sequence is active.
- **N4 [Major] prose.** FR3's "still unfilled" is undefined. A DOM-empty reading would skip overwriting prefilled fields, which is a regression from today's unconditional writes. **Fix:** define it as "this step has not yet written".
- **N5 [Major] design.** C1's MutationObserver omits the `if (document.body)` guard the sibling detectors use. An unawaited throw silently aborts the remaining steps. **Fix:** add the guard; on an error, run the pending `onDone` callbacks, then log.
- **N6 [Major, Adjacent] design (R42).** LOGIN `findPasswordInput` has no exclusion for fields already claimed by CC (masked CVV). The identity detector excludes CC-claimed fields; LOGIN does not. Pre-existing, and per-kind supersession does not cover it.

## Recurring Issue Check (Functionality)
R1 N2; R17 N2; R42 N6; R34 considered for N2, where R1/R17 fit better; R38, R23 and R51 considered, no exact match; other rows N/A.

## Security Findings (plan round 1)

Baseline: a first-party script can already read every field, and frame origin is fixed for the document. The real widenings are (a) intent — a secret landing in a field or form the user did not pick — and (b) scriptless injectors reacting to our writes through CSS `:focus-within` / `:placeholder-shown` / `:has()`. Not widenings: frame origin, cross-origin iframes, password into a `type=text` field (`findPasswordInput` requires `type=password`).

- F1 [Major] design (R38/R43): supersession is per kind, but kinds share the field pool. A pending LOGIN password step can write into a masked CVV `type=password` field; a pending CC CVV step can match a login or 2FA "security code" field. Fix:
  - one generation per frame across LOGIN/CC/IDENTITY;
  - also supersede, without writing, on the first trusted user input during the window (`keydown`, `pointerdown`, `paste`);
  - test row: LOGIN pending → CC fill → CVV never receives the password.
- F2 [Major] design (R43/R51): re-detection re-runs page-steerable predicates. The page can steer the focus re-read (`findFocusedTextInput` → `scopeForm`), the page-wide `findPasswordInput` fallback (waited for up to 1s), page-wide CC autocomplete matches, decoys revealed by CSS after our write, and a second step resolving to an already-written element. Fix, as contract C1a:
  1. snapshot the anchor, `scopeForm`, and the CC number's form/table at T0, and never re-read `activeElement`;
  2. confine re-detection to that root, re-anchoring only to the form containing an already-written anchor, with no page-wide fallback;
  3. keep the type allowlist and visibility checks, re-checked in the same task as the write;
  4. at most one write per element per sequence;
  5. no late page-wide password.
- F3 [Minor] design (R38): the deadline must be absolute (`start + window`, never extended). Generation, deadline and `isConnected` are checked in the same synchronous task as `resolve()` + `write()`. Timers are cleared and the observer disconnected on exit. Test rows: a mutation after the deadline, and a callback queued before `disconnect()`.
- F4 [Minor] prose (R29/R49/R41): "wipe" overstates it. JS strings are immutable, so `payload.cvv = ""` only drops a reference. FR5 should be reachability-bounded: read `payload.<field>` lazily inside `write`; give password and TOTP the same reference drop; label the CVV line as defence in depth.
- F5 [Minor, Adjacent] design (R34/R42): LOGIN custom-field targets (any non-password input by id/name, hidden included) and the OTP `autocomplete=one-time-code` branch have no type allowlist or visibility check. Fix: a text/email/tel/number allowlist plus visibility; correct NF2.
- F6 [Minor, Adjacent] design (R51): fill delivery is not pinned to a document (`frameId` only, while decrypt runs in between), and the top frame bypasses `allowedHosts`. Not widened by this plan. Fix: send `documentId` and check `allowedHosts` in the top frame, or file a follow-up.

## Recurring Issue Check (Security)
R1 OK; R3: the direct-inject LOGIN twin `injectDirectAutofill` in `background/index.ts` stays synchronous (functionality note); R29 F4; R34 F5/F6; R38 F1/F3; R39 F4; R41 F4; R42 F5; R43 F1/F2; R49 F4; R51 F2/F6; RS3 OK; RS4 OK; others N/A.

## Testing Findings (plan round 1)

Evidence:
- `extension/vitest.config.ts`: the default environment is node, the autofill tests opt into jsdom per file, and `sequence.shuffle` is on.
- react, react-dom and @testing-library/react are devDependencies.
- About 70 synchronous `perform*` assertions must become async.
- The background tests only assert message construction.
- The repo has no precedent for fake timers combined with MutationObserver.

Findings:
- T1 [Critical] design (RT4/RT7): the React reproduction may be vacuous. `act()` and `fireEvent` flush the commit synchronously, so the stale-blur race never happens. Fix: drive the write → focus-move steps with raw native `dispatchEvent` outside `act()`, as `setInputValue` and the probe do; mount only via testing-library; name this trap in the red proof.
- T2 [Major] design (RT6): `runFillSequence` has no direct unit test. Fix: add `fill-sequence-lib.test.ts` for ordering, late-field retry, window elapse, supersession, and cross-kind behaviour.
- T3 [Major] design (RT2): the window is not injectable into the public fill functions. Fix: thread an optional override; the window-end flush order is trigger mutation → microtask flush → `advanceTimersByTimeAsync(window)`.
- T4 [Major] design (RT10): there is no row with a focused non-custom username plus custom fields under the new order, where re-evaluating focus could latch onto a custom field. Fix: add that row.
- T5 [Major] design (RT10): LOGIN has no supersession row. Fix: pick A without awaiting, pick B, assert only B remains.
- T6 [Major] design (RT11): there is no settlement or teardown contract for module-scoped generation, observers and timers, and shuffle is on. Fix: each test awaits settlement, or `afterEach` disconnects and resets.
- T7 [Minor] prose: the probe is correctly a manual VE1 artifact. Optionally run `node --check` on it.

## Recurring Issue Check (Testing)
Triggered: RT2 (T3), RT4 (T1), RT6 (T2), RT7 (T1), RT10 (T4, T5), RT11 (T6). Checked and clean: RT1, RT3, RT5, RT8, RT9, R34. Other rows N/A.

## Resolution (plan revision 2)
- P1: contract C1a (target constraints). Decisions are snapshotted at T0, and `activeElement` is never re-read. `resolve()` re-validates the chosen element or runs a structural lookup inside the T0 root, with no page-wide fallback; re-anchoring happens only to the form containing an already-written anchor. Checks run in the same task as the write, and an element is written at most once per sequence.
- P2: one generation per frame across all kinds. A trusted `keydown`, `pointerdown` or `paste` during the window supersedes without writing.
- P3: the LOGIN fallback injects `form-detector.js` and retries the message, as CC and Identity do. The inline `func` writer is deleted.
- P4: C1 exposes `isFillActive()`, and the three detectors' focus handlers skip while a fill is active, alongside the existing timer.
- P5: "unfilled" means the step has not yet written.
- P6: body guard; an error runs every pending `onDone`, then logs a fixed code (no values).
- P7: the red-proof rows drive writes with raw native `dispatchEvent` outside `act()`; only the mount uses testing-library.
- P8: `fill-sequence-lib.test.ts`; an optional `lateFieldWindowMs` on the public functions; the flush order is specified; new rows; `afterEach` settles or resets.
- P9: absolute deadline; same-task check; on exit, clear timers, disconnect the observer and drop the queued callbacks.
- P10: FR5 reworded as reachability-bounded; payload fields are read lazily.
- P11: custom-field and OTP targets get a text/email/tel/number allowlist plus visibility.
- P12: SC3 follow-up, cost recorded.
- P13: SC4 follow-up. With one generation per frame, the concurrent collision is closed; the static overlap is pre-existing.
- P14: kept as a manual VE1 artifact.

---

# Round 2
Date: 2026-10-08

## Changes from Previous Round
Plan revision 2 added:
- T0-fixed targets (C1a);
- one generation per frame, plus supersession on user input;
- C5, which deletes the inline LOGIN fallback;
- C6, which suppresses the dropdown during a fill;
- the expanded test plan.

## Findings (single reviewer, three expert sections)
### Functionality
- **FN-1 [Critical] design** (R41/R29/R34). C5's "inject `form-detector.js` and retry" points at a file that does not exist in the build.
  - `dist/manifest.json` registers `assets/form-detector.ts-loader-<hash>.js`, and `dist/src/content/` holds only `token-bridge.js` and `webauthn-interceptor.js`. The orchestrator verified this.
  - The CC, Identity and shortcut-command fallbacks (`background/index.ts` lines 1123, 1876, 1916) have therefore always failed since `#717`.
  - `injectDirectAutofill` is the only fallback that works, and it covers orphaned content scripts after an extension reload. R2's rationale was wrong.
- **FN-2 [Major] design.** A step with no T0 target blocks the later steps for the whole window. An unmatched custom field delays the password by 1 s, and user input in that second drops the password.
- **FN-3 [Major] design.** The CC and Identity root is undefined on pages with no form and no table. `isCoLocatedWith` is a boolean predicate, not a container, and Identity has no co-location concept.
- **FN-4 [Major] design.** The password relocation's "nearest common ancestor of the identifiers" is degenerate for a single identifier, can exclude the password, and "identifiers" is undefined.
- **FN-5 [Minor]** `relocate` for null-initial steps; split OTP shares one secret across steps.
- **FN-6 [Minor]** Write-once should hold for the T0 targets too.
- **FN-7 [Minor]** The content side has no logger; use the `select-diag-lib` closed codes and `.catch` the un-awaited call.
- **FN-8 [Minor]** A held Enter repeats `keydown`; ignore `e.repeat`.
- **FN-9 [Minor] prose** Forbidden-pattern scopes.

### Security
- **SEC-1 [Major] design** (R43). Confinement can degenerate to `body` or `html`, which reopens the page-wide decoy. Refuse relocation in that case.
- **SEC-2 [Minor] prose** (R49). User-input supersession is best-effort UX that the page can suppress; register it in the capture phase on `window`.
- **SEC-3 [Minor] design** (R3). Removing the fallback would delete the frame-scope injection tests. Carry them over.

### Testing
- **TE-1 [Critical] design** (RT1/RT5). A mocked `executeScript` hides the nonexistent path; the existing command test already asserts it. Derive the path from the manifest and prove the test fails on the old literal.
- **TE-2 [Major]** Keep and retarget the frame-scope injection tests.
- **TE-3 [Major]** (R29/RT1). React and the root type were unverified. The orchestrator verified them: the live page has `__reactFiber$`/`__reactProps$` on the password input and `__reactContainer$` on `#__next` (a createRoot / concurrent root), with Next 16.2.6.
- **TE-4 [Major]** (RT7). The C6 row is masked by the existing 1500 ms suppression; start the fill without `onSelect`.
- **TE-5 [Major]** (RT2/RT11). Specify the `toFake` list and the deadline clock; keep `queueMicrotask` real; run the React row on real timers; existing tests use `lateFieldWindowMs: 0`.
- **TE-6 [Minor] prose.** Cite the `suggestion-dropdown.test.ts` toFake precedent.

## Resolution (plan revision 3)
- **FN-1 / TE-1:** C5 becomes "resolve the bundle path from `chrome.runtime.getManifest().content_scripts`" for all four `executeScript({files})` callers (LOGIN retry, CC, Identity, shortcut command). The tests take the path from a mocked manifest of the real shape, and red-prove against the old literal.
  - The inline LOGIN fallback is kept (C7) and made sequential, with the password last and a yield between fields. Its duplication is declared, and unification is SC5, after manual verification of the bundle retry on orphaned tabs.
- **FN-2:** a step with no T0 target is deferred and does not block. Ordering is guaranteed among targets present at T0, and late steps run when they appear.
- **FN-3 / FN-4 / SEC-1:** one bounded-root rule (C1a) for every kind: the anchor's `form`, else its `table`, else the nearest common ancestor of the T0 targets of that sequence. The single-target case climbs to the first ancestor holding another fillable control. A root that is `body` or `html` disables relocation.
- **FN-5:** null-initial steps re-run their T0 predicate inside the root. A shared secret (split OTP) is released at exit.
- **FN-6:** the write-once check is part of the same-task check.
- **FN-7:** closed codes in `select-diag-lib`; `.catch` on the listener's call.
- **FN-8:** `e.repeat` is ignored.
- **FN-9:** forbidden patterns are scoped to `extension/src`; `findFocusedTextInput` is named.
- **SEC-2:** registered in the capture phase on `window`; stated as best-effort, page-suppressible UX.
- **SEC-3 / TE-2:** the frame-scope tests are kept.
- **TE-3:** verified (createRoot, React 19 / Next 16.2.6); the harness mounts with `createRoot`.
- **TE-4:** the C6 row starts the fill without `onSelect`.
- **TE-5:** toFake is `["setTimeout","clearTimeout","Date","performance"]`, `queueMicrotask` stays real, the React row runs on real timers, and existing tests pass `lateFieldWindowMs: 0`.
- **TE-6:** precedent cited.
