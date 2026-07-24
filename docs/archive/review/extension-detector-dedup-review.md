# Plan Review: extension-detector-dedup
Date: 2026-07-24
Review round: 1

## Changes from Previous Round
Initial review (three expert agents: functionality, security, testing).

## Functionality Findings

- **F1 [Major] — RESOLVED**: Call-site count wrong — plan said 38, actual **34** call sites (identity 12+10, cc 6+6). The "38" counted the 4 `function findFieldBy…(` definition lines. Fixed all three occurrences in the plan; defs now explicitly excluded.
- **F2 [Minor] — RESOLVED**: The negative 2-arg forbidden grep misses un-migrated `findFieldByRegex` (3→4 arity). Replaced with a positive-assertion check (call count == `, isUsableField)` count); tsc (INV-C1-c) reaffirmed as the primary fail-closed gate. Empirically verified the 2-arg pattern does NOT match a 3-arg `findFieldByRegex(a,b,c)`.
- **F3 [Minor] — RESOLVED (converged with Testing FINDING-1)**: Stale `autofill.js` ref in `constants.ts:117` not enumerated. Added as C2 Consumer 1b with a comment-only fix.
- **F4 [Minor] — RESOLVED**: Added INV-C1-d — `resolveOpacity` stays single-defined; `isElementVisible` relocation must reuse it, not paste a 3rd copy.
- **F5 [Adjacent] — noted**: getHintString comment-merge / autofill-js-sync deletion are test-scope; invariant preserved.

## Security Findings

- **S-1 [Minor] — RESOLVED**: `isUsable` must be a required, un-defaulted positional parameter so a forgotten predicate is a tsc compile error (fail-closed). A weakened signature (optional/defaulted) would silently reintroduce the #717 fail-open (radio/checkbox admitted as fill targets). Added as INV-C1-c, the stated primary control.
- **S-2 [Minor] — verified, no change needed**: Deleting `autofill-js-sync.test.ts` is safe — `autofill.test.ts:659-745` behaviorally covers the identical fail-closed frame-gate invariant on the live module (`autofill-lib.ts`), strictly stronger (mutation-asserted). RT9 satisfied.
- **S-3 [Minor] — RESOLVED**: Removing `autofill.js` from `web_accessible_resources` tightens attack surface (removes a page-fetchable source-disclosure vector). Reinforced that the stale-comment fix touches the COMMENT ONLY — the `AUTOFILL_GUARD` double-registration LOGIC stays.
- **S-4 [Minor] — RESOLVED (doc sharpening)**: SC1 deferral is safe — the live fill path (`autofill-lib.ts` findUsernameInput) already retains `userid`/`id` byte-identically to `autofill.js`, so deleting `autofill.js` changes NO fill behavior. Only the separate dropdown-offer path (`form-detector-lib.USERNAME_HINT_RE`, narrower = safer) differs. SC1 body sharpened accordingly.

## Testing Findings

- **FINDING-1 [Major] — RESOLVED**: C2 acceptance grep would fail on two un-enumerated stale comments (`autofill-lib.ts:345`, `constants.ts:117`). Added both to the C2 work list (Consumer 1b) with comment-only fixes.
- **FINDING-2 [Minor] — RESOLVED**: Deleting the text-pin loses the only guard on the `!frameHost` fail-closed branch (the 4 behavioral tests use resolvable hosts). Added a requirement to write ONE behavioral case driving an unresolvable-origin subframe → no fill, RED-proven by flipping `autofill-lib.ts:17`.
- **FINDING-3 [Minor] — RESOLVED (confirmed transitive coverage)**: C1 predicate covered by existing detector tests — radio-reject (`identity:110`, `cc:109`) + password-admit (`cc:124/:231/:497`). Plan now states this; no standalone predicate test needed.
- **FINDING-4 [OK]**: c11 AUTOFILL_FILL literal-sync still guarded post-removal (value-pin case remains; TS imports constant directly).
- **FINDING-5 [Adjacent] — noted in SC2**: inline `executeScript func` is an untested fill-selection twin, frame-scoped structurally (no fail-open), pre-existing gap not widened.

## Adjacent Findings
- getHintString comment merge (func → test scope): safe, no `?raw` test asserts detector source text.
- SC2 inline func remains untested (pre-existing; SC2 documents non-regression).

## Recurring Issue Check
### Functionality expert
- R1: FINDING-F4 (resolveOpacity re-dup hazard) → INV-C1-d added
- R2: N-A
- R3: FINDING-F2 (grep propagation gap) → positive-assertion replacement
- R17: FINDING-F1 (adoption count 38→34)
- R22: OK (isElementVisible/isElementVisuallySafe non-merge resisted)
- R34: OK (SC1 pre-existing drift correctly scoped out)
- R41: FINDING-F2 (grep as declared capability without backing path for findFieldByRegex half)
- R42: FINDING-F1 partial (file member-set correct {identity,cc}; call-site over-counted by 4)

### Security expert
- R3: OK (38→34 sites all reached; tsc arity-error fail-closed)
- R42: OK (allowlist consumers = {cc, identity}; findFieldBy* sites enumerated)
- R43: OK (no allowlist widened; isElementVisible ≠ isElementVisuallySafe preserved)
- RS3: OK (frame gate + fillable-type allowlist untouched)
- RS5: OK (isUsable required, no permissive floor)
- RT9: OK (dead twin deleted; stronger behavioral guard remains)

### Testing expert
- RT1: OK (jsdom window.top mock matches production reads; restored in finally)
- RT5: OK (test imports real performAutofill → real extractHost/isHostMatch)
- RT6: FINDING-3 (5 new exports, covered transitively — confirmed)
- RT7: FINDING-2 (!frameHost branch RED-provability) → new behavioral case
- RT8: OK (behavioral suite asserts DOM mutation, not status)
- RT9: FINDING-1 (residual stale comments) + FINDING-5 (inline-func twin deferred)

## Anti-Deferral Records
- No findings deferred. All Major (F1, FINDING-1) and all Minor findings reflected in the plan or verified requiring no change (S-2, FINDING-4). SC1/SC2/SC3 scope-outs pre-existed the review and were independently confirmed legitimate by all three experts (not invented to dodge work).

---

# Round 2 (incremental fix-verification)
Date: 2026-07-24

## Changes from Previous Round
Applied all Round-1 findings; ran a single incremental verification pass to confirm each fix is correct and complete against source.

## Findings
- **All six Round-1 fixes VERIFIED-CORRECT** against source: F1 (34 call sites confirmed by grep: identity 12+10, cc 6+6), F2 (positive-assertion + tsc-primary), F3/FINDING-1 (both stale comments enumerated; grep confirmed to return empty after all edits; AUTOFILL_GUARD logic preserved), FINDING-2 (`!frameHost` at autofill-lib.ts:17, new behavioral case required), S-1 (INV-C1-c coherent with signatures), INV ordering a/b/c/d coherent.
- **NEW-1 [Minor] — RESOLVED**: Risks line 135 still cited the F2-discredited negative 2-arg grep as the arity mitigation, contradicting lines 66/77. Rewrote to tsc-primary + positive-assertion. Also reconciled the sibling claim at line 66 (was "secondary 2-arg grep") to reference the positive-assertion check.

## Recurring Issue Check (Round 2)
- All experts: no new recurring-rule findings. NEW-1 was an intra-document consistency defect (a leftover from the F2 edit), not a rule violation. Resolved.

## Verdict
Round-1 fixes all correct; NEW-1 resolved. No remaining blockers. Plan ready for Phase 2.

## Anti-Deferral Records (Round 2)
- No findings deferred. NEW-1 applied in full.
