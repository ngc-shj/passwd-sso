# Plan: extension-detector-dedup

## Project context

- **Type**: web app (browser extension content-script layer)
- **Test infrastructure**: unit tests (vitest, jsdom) + CI. No E2E for the content scripts; the `?raw` text-pin tests are the twin-drift guard.
- **Verification environment constraints**:
  - VE1 — `verifiable-local`: all detector/autofill logic is exercised by vitest+jsdom (`npx vitest run`). No blocked path.
  - VE2 — `verifiable-CI`: production `next build` at repo root is not affected (extension has its own build); extension build via `cd extension && npm run build`. Both runnable locally.
  - No `blocked-deferred` paths — everything is unit-testable in jsdom.

## Objective

Eliminate two classes of duplicated / dead extension content-script code that #717 explicitly deferred:

1. **Detector helper duplication** — 6 helpers are copy-pasted byte-for-byte (5 identical, 1 comment-only diff) across `identity-form-detector-lib.ts` and `cc-form-detector-lib.ts`. Collapse to a single source in `form-detector-lib.ts`.
2. **LOGIN `autofill.js` dead twin** — `src/content/autofill.js` (web-accessible plain-JS, 418 LOC) is a hand-maintained twin of `autofill-lib.ts` that **no production path executes anymore**. Remove it and migrate its two `?raw`-pin tests.

## Requirements

### Functional
- Detector behavior (identity + CC field detection) is **byte-for-byte unchanged** — this is a pure refactor. Every existing detector test passes without modification.
- After removing `autofill.js`, LOGIN autofill (happy path via `AUTOFILL_FILL` message → `autofill-lib.ts`; fallback via `executeScript({ func })`) is unaffected — `autofill.js` is not in any execution path.

### Non-functional
- No new duplication introduced. The extracted helpers live in exactly one module.
- The predicate-dependency problem (helpers that call detector-local `isUsableField`) is solved by parameterizing the predicate — the "proper" form the user requested, not partial extraction.

## Technical approach

### Established facts (from investigation)

- **Test import surface**: NO test imports any of the 6 helpers directly. Tests import only `detectCreditCardFields` / `detectIdentityFields` / `CC_DETECT_RE` etc. → extracting the helpers has near-zero blast radius. (This corrects the #717 hand-off note which assumed `isElementVisible` was test-referenced.)
- **`isElementVisible` (detector-local) ≠ `isElementVisuallySafe` (form-detector-lib)**: the detector version deliberately OMITS the clipPath/transform checks that `isElementVisuallySafe` adds. Detection visibility is intentionally looser than the inline-display safety gate. **These MUST NOT be merged** — doing so would either over-suppress detection (clipPath false positives) or under-gate display. Extract `isElementVisible` as its own shared export, distinct from `isElementVisuallySafe`.
- **`autofill.js` is dead**: manifest `content_scripts` load only `form-detector.ts` (which bundles `autofill-lib.ts`). LOGIN happy path sends `AUTOFILL_FILL` to the bundled `autofill-lib.ts` listener (background/index.ts:1691). LOGIN fallback is an inline `executeScript({ func })` (index.ts:1711-1843), NOT `files:["autofill.js"]`. `autofill.js` survives only as a `web_accessible_resources` entry + two `?raw`-pin tests.

### C1 — Extract shared detector helpers into `form-detector-lib.ts`

Move these from BOTH `identity-form-detector-lib.ts` and `cc-form-detector-lib.ts` to `form-detector-lib.ts`, exported:

Signatures:
```ts
// form-detector-lib.ts (new exports)
export function isElementVisible(element: HTMLElement): boolean;
export function getHintString(el: HTMLElement): string;
export function getAutocomplete(el: HTMLElement): string;

export function findFieldByAutocomplete(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  acValue: string,
  isUsable: (el: HTMLInputElement | HTMLSelectElement) => boolean,
): HTMLInputElement | HTMLSelectElement | null;

export function findFieldByRegex(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
  isUsable: (el: HTMLInputElement | HTMLSelectElement) => boolean,
): HTMLInputElement | HTMLSelectElement | null;
```

- `resolveOpacity` is already a private helper in `form-detector-lib.ts` (line 53). The detectors' private `resolveOpacity` copies are deleted; `isElementVisible` (moved into form-detector-lib) reuses the existing module-local one. No new export needed for `resolveOpacity`.
- `getHintString` / `getAutocomplete`: identical logic; export once. Keep the `getHintString` associated-label comment from the cc version (the only textual diff) so no information is lost.
- `findFieldByAutocomplete` / `findFieldByRegex`: **parameterize the `isUsable` predicate** (3rd/4th arg). Each detector passes its own `isUsableField` (bound to its `FILLABLE_INPUT_TYPES`). This is the user-approved "proper" form.
- Each detector updates its imports to pull the 5 helpers from `./form-detector-lib`, deletes its local copies, and updates **all** `findFieldByAutocomplete`/`findFieldByRegex` **call** sites to pass `isUsableField` as the final arg. **Exact call-site counts (verified — calls only, function-definition lines excluded):** identity = 12 `findFieldByAutocomplete` + 10 `findFieldByRegex` = 22; cc = 6 + 6 = 12; **total 34 call sites**. (The 4 `function findFieldBy…(` definition lines — 2 per detector — are not migrated in place; they move to form-detector-lib. Raw `grep -c` returns 13/11/7/7 = 38 because it counts each definition line too; the real migration target is 34 calls.)
- **Primary validation gate is `tsc`, not grep.** `build` = `tsc && vite build`; the arity change means any un-migrated call is a compile error regardless of arity (INV-C1-c). The positive-assertion grep (§Forbidden patterns C1) is a secondary/defense-in-depth check, not the primary gate.
- `findKanaField` / `findPlainNameField` (identity-only) and `findConfNumCvvInForm` (cc-only) stay in their detectors — they are not duplicated.

**Invariants (C1)**:
- INV-C1-a (app-enforced): detector output for any DOM is identical pre/post. Enforced by the existing detector test suites passing unchanged.
- INV-C1-b (app-enforced): the shared `findFieldBy*` helpers gate every candidate through the caller-supplied `isUsable` — never a hardcoded predicate. Enforced primarily by tsc (INV-C1-c) and secondarily by the positive-assertion check below.
- INV-C1-c (type-enforced — the real fail-closed gate): `isUsable` MUST be a **required, un-defaulted positional parameter** (no `?`, no `= () => true`, no shared default). This is what makes a forgotten predicate a **`tsc` compile error** (`Expected 3 arguments, but got 2`), which the `build = tsc && vite build` gate fails closed on. A reviewer MUST reject any optional/defaulted `isUsable` — weakening the signature silently converts the #717 fail-closed fillable-type allowlist back into a fail-OPEN that admits radio/checkbox/hidden as CC/identity fill targets. The positive-assertion grep (below) is defense-in-depth; the required-parameter type is the primary control.
- INV-C1-d (R1 — no re-duplication on relocation): `form-detector-lib.ts` defines `resolveOpacity` **exactly once** (the existing private one at line 53). When `isElementVisible` is relocated there, it MUST reuse that `resolveOpacity` — do NOT paste `isElementVisible` together with an adjacent copy of `resolveOpacity` (the natural copy-paste hazard, since the detector's `isElementVisible` currently sits next to its own `resolveOpacity` copy). Both detector-local `resolveOpacity` copies are deleted.

**Forbidden patterns (C1)**:
- `pattern: function (resolveOpacity|isElementVisible|getHintString|getAutocomplete|findFieldByAutocomplete|findFieldByRegex)` in `cc-form-detector-lib.ts` or `identity-form-detector-lib.ts` — reason: these must be gone from the detectors (moved to form-detector-lib). (Note: `isUsableField`, `findKanaField`, `findPlainNameField`, `findConfNumCvvInForm` remain — they are NOT in this list.)
- **Positive-assertion check (replaces the earlier negative 2-arg grep, which was ineffective):** the negative pattern `findFieldBy…\([^,]+,[^,)]+\)` only matches 2-arg calls — but `findFieldByRegex` goes 3-arg→4-arg, so an un-migrated 3-arg `findFieldByRegex(a,b,c)` does NOT match it and slips through. Use a **positive** count instead: `grep -oE 'findFieldByAutocomplete\(' → each such call line must also match 'isUsableField\)'`, i.e. **count of `findFieldByRegex(`/`findFieldByAutocomplete(` calls == count of those calls ending in `, isUsableField)`**. Any shortfall is an un-migrated site. This is defense-in-depth only — `tsc` (INV-C1-c) is the primary fail-closed gate and catches every un-migrated site as a compile error regardless of arity.

**Acceptance criteria (C1)**:
- `identity-form-detector-lib.ts` and `cc-form-detector-lib.ts` no longer define the 6 helpers; they import the 5 shared ones (`resolveOpacity` stays internal to form-detector-lib).
- Every `findFieldByAutocomplete(...)` / `findFieldByRegex(...)` call in both detectors passes `isUsableField` as the final arg. Verified call counts (defs excluded): identity 12 + 10; cc 6 + 6; total 34. `findKanaField` / `findPlainNameField` (which call `isUsableField` internally) stay unchanged in the identity detector.
- `npx vitest run` green with ZERO test-file edits for `identity-form-detector.test.ts`, `cc-form-detector.test.ts`, `form-detector.test.ts`.
- `cd extension && npm run build` succeeds.
- **Predicate correctness is covered transitively (verified)**: the parameterized `isUsable` arg is exercised end-to-end by existing detector tests — `identity-form-detector.test.ts:110` (radio `id="Email"` rejected) and `cc-form-detector.test.ts:109` (radio `id="card_number_pay"` rejected), plus `cc-form-detector.test.ts:124` (`cc-csc type=password` admitted) and `:231/:497` (`conf_number type=password` maxlength-capped admitted). So a wrong/absent predicate would break these suites. No standalone predicate unit test is needed. NOTE the grep-for-2-arg-calls guards *arity*, not *which* predicate — but tsc + these transitive assertions cover a wrong-detector-predicate mistake because each detector's `FILLABLE_INPUT_TYPES` differs (identity excludes `password`; cc includes it), so swapping them flips a real assertion.

### C2 — Remove dead `autofill.js`, migrate its pin tests

- Delete `src/content/autofill.js`.
- Remove the `src/content/autofill.js` entry from `web_accessible_resources` in `manifest.config.ts` (keep `token-bridge.js`, `webauthn-interceptor.js`).
- Fix the two stale comment residuals (`autofill-lib.ts:345`, `constants.ts:117`) — see Consumer 1b below. These are the only non-manifest src references and MUST be handled or the C2 acceptance grep returns non-empty.
- Migrate the two `?raw`-pin tests, which currently pin `autofill.js` text:
  - `autofill-js-sync.test.ts` — pins the frame-origin gate (`isFrameAllowedToFill`) in `autofill.js`. **Established fact (verified):** the equivalent gate in `autofill-lib.ts` — the module the bundled production path actually runs — is ALREADY covered by a stronger **behavioral** test suite in `autofill.test.ts:659-745` ("does NOT fill a cross-origin subframe…", "fills a same-origin-family subframe…", "does NOT fill when allowedHosts absent", "always fills the top frame"), which mocks `window.top`/`window.location` via `Object.defineProperty` and asserts the actual credential-write mutation. Therefore the text-pin in `autofill-js-sync.test.ts` is **redundant once `autofill.js` is gone** → **delete `autofill-js-sync.test.ts` entirely**. The invariant it guarded (frame-gate present + fail-closed) survives in `autofill.test.ts`, strictly stronger (RT8/RT9: mutation asserted, not source text). No new test needs writing.
  - `c11-constants-sync.test.ts` (the `autofill.js` AUTOFILL_FILL-literal case, lines 55-58) — this case pins that `autofill.js` contains the `AUTOFILL_FILL` literal. With `autofill.js` gone, **remove this single `it(...)` case** (the TS twin `autofill-lib.ts` imports `AUTOFILL_FILL` from constants directly — no literal-drift risk). Verify no other case in that file depends on `autofill.js`.
  - **jsdom mockability is proven, not assumed**: `autofill.test.ts:662-664` already does `Object.defineProperty(window, "top", {value: {}})` + `window.location` override in this exact test env — the frame-gate behavioral path runs in jsdom today. (Closes the pre-review [Major] "untestable design" concern.)
  - **Close the one branch the deleted pin uniquely covered (`!frameHost` fail-closed)**: the deleted `autofill-js-sync.test.ts` explicitly pinned `if (!frameHost) return false;`. The four existing behavioral cases all use resolvable hosts, so none drives the unresolvable-origin fail-closed branch (`isFrameAllowedToFill` → `extractHost` returns null → `return false`). A regression flipping that line to `return true` would keep all four green yet fail open. **Add ONE behavioral case** to the `autofill.test.ts` frame-gate suite: a subframe whose `window.location.href` yields a null host (e.g. `about:blank` / opaque origin, or a `URL` `extractHost` rejects) → assert no credential is written. RED-prove it by flipping `autofill-lib.ts:17` to `return true` on a scratchpad copy. This makes the "strictly stronger than the deleted pin" claim literally true on all four branches, not three of four.

**Consumer-flow walkthrough (C2 — the removed artifact's "consumers")**:
- Consumer 1 (manifest `web_accessible_resources`): referenced `autofill.js` as a resource. After removal, no content script or executeScript `files:[...]` references it → the resource entry is safe to drop.
- Consumer 1b (stale comment residuals — MUST also be fixed or the C2 grep fails): two non-test source comments still name `autofill.js` and become factually wrong once it is deleted:
  - `src/content/autofill-lib.ts:345` — `// Guard against double-registration when autofill.js is also injected.` → rewrite the COMMENT ONLY to drop the "when autofill.js is also injected" clause. **Do NOT delete the `AUTOFILL_GUARD` double-registration logic (lines 346-352)** while fixing the grep hit — it still guards repeated content-script / `executeScript` re-injection of the *bundled* script. Only the comment's rationale is stale.
  - `src/lib/constants.ts:117` — `// Note: autofill.js (plain JS…) declares a matching local literal — keep both in sync.` → delete the note entirely; `AUTOFILL_FILL` is now imported directly everywhere (no plain-JS twin, no literal to keep in sync).
- Consumer 2 (`autofill-js-sync.test.ts`): reads `autofill.js?raw` text. Deleted — the frame-gate invariant it pinned is already behaviorally covered by `autofill.test.ts:659-745`.
- Consumer 3 (`c11-constants-sync.test.ts` case at L55): reads `autofill.js?raw`. Removed (twin gone; constant imported directly in TS).
- No production execution consumer exists (established fact above).

**Invariants (C2)**:
- INV-C2-a (app-enforced): LOGIN autofill still fail-closes in a cross-origin subframe. Enforced by the existing behavioral suite `autofill.test.ts:659-745` (unchanged by this PR) — verify it still passes after `autofill.js` removal.
- INV-C2-b: no dangling reference to `autofill.js` remains anywhere (src, manifest, tests). Enforced by forbidden-pattern grep.

**Forbidden patterns (C2)**:
- `pattern: autofill\.js` in `extension/src/**` and `extension/manifest.config.ts` — reason: the file and all references are removed. (Allowed only in git history / this plan / deviation log.)

**Acceptance criteria (C2)**:
- `src/content/autofill.js` deleted.
- `grep -rn "autofill.js" extension/src extension/manifest.config.ts` returns nothing.
- `autofill-js-sync.test.ts` deleted; `c11-constants-sync.test.ts` autofill.js case removed. `autofill.test.ts:659-745` frame-gate suite still passes (invariant preserved).
- `npx vitest run` green; `cd extension && npm run build` green.

## Contracts

| ID | Subject |
|----|---------|
| C1 | Extract 6→shared detector helpers to form-detector-lib.ts with parameterized `isUsable` |
| C2 | Delete dead `autofill.js`, migrate/retarget its two `?raw`-pin tests to behavioral |

## Considerations & constraints

### Scope contract
- **SC1** — The LOGIN detection regex triad drift (`autofill.js` vs `autofill-lib.ts` vs `form-detector-lib.USERNAME_HINT_RE`: `.js` and `autofill-lib.ts`'s fill-path `findUsernameInput` both include `userid`/`id`; `form-detector-lib.USERNAME_HINT_RE` lacks them) is a PRE-EXISTING difference discovered during investigation. **Security-verified non-regression**: the production LOGIN *fill* path runs `autofill-lib.ts:performAutofill` → its own local `findUsernameInput` (line 109), which ALREADY includes `userid`/`id` byte-identically to `autofill.js`. So deleting `autofill.js` changes NO fill behavior — the dead file and the live module agreed on these tokens. The only remaining difference is between the fill-path finder (`autofill-lib.ts`, has `userid`/`id` — decides where to *write* on explicit user selection) and `form-detector-lib.USERNAME_HINT_RE` (lacks them — decides whether to *offer* an inline dropdown on focus). These are two intentionally separate code paths; the narrower dropdown-offer matching is the *safer* direction (fewer spurious dropdowns), and a fill only happens after the user picks an entry. Reconciling them is **out of scope** — owned by a future issue, requires a product decision on whether `id`/`userid` should be dropdown-offer hints. Not silently bundled here.
- **SC2** — The LOGIN `executeScript({ func })` inline implementation (background/index.ts:1711-1843) is a 4th copy of the autofill write logic, kept inline by #717 for frame-scoping. Extracting it to share with `autofill-lib.ts` is **out of scope** — it runs in an isolated executeScript world with no module imports and is a distinct concern (RT9 twin between inline-func and `autofill-lib.ts`). Owned by a future refactor. **Verified non-regression**: this inline func has NO in-body `isFrameAllowedToFill` gate; its frame-scoping is structural (the `executeTarget` = originating frame). So deleting `autofill.js` does not orphan the frame-gate invariant for this path, and SC2 does not create a fail-open. For the record, the inline func remains an entirely untested fill-selection twin (no `?raw` pin, no behavioral test) — a pre-existing gap this PR neither widens nor narrows.
- **SC3** — `isElementVisuallySafe` vs the extracted `isElementVisible` are deliberately kept as two separate functions (see Technical approach). NOT unified. Owned by nothing — this is a permanent design distinction, documented here so a future reviewer does not "dedupe" them.

### Risks
- Retargeting `autofill-js-sync.test.ts` from text-pin to behavioral changes what is asserted. Mitigation: RED-prove the new test on a scratchpad copy (break `isFrameAllowedToFill` → must fail), per the mutation-proof-on-throwaway-only rule.
- Parameterizing `findFieldBy*` changes their arity. Mitigation: `tsc` (`build = tsc && vite build`) fails closed on any un-migrated call regardless of arity — the required, un-defaulted `isUsable` param makes a missed site a compile error (INV-C1-c). The positive-assertion count (§Forbidden patterns C1) is defense-in-depth; the earlier negative 2-arg grep is NOT used (it misses un-migrated 3-arg `findFieldByRegex`).

## User operation scenarios

1. **Identity form, `autocomplete` present**: `findFieldByAutocomplete(fields, "given-name", isUsableField)` — a `type=radio id="given-name"` must be rejected by the passed `isUsableField` (FILLABLE_INPUT_TYPES excludes radio). Post-refactor identical to pre (#717 fix preserved).
2. **CC form, regex fallback**: `findFieldByRegex(fields, CC_DETECT_RE.cvv, CC_CVV_JA_RE, isUsableField)` where `isUsableField` includes `password` (masked CVV). Verify the cc predicate still admits `type=password` after extraction.
3. **Cross-origin subframe LOGIN fill (C2 behavioral test)**: `window.top !== window.self`, frame host not in `allowedHosts` → `performAutofill` writes nothing. RED-proven.
4. **Popup LOGIN fill, top frame**: `window.top === window.self` → fills normally (gate returns true). Regression check that the retargeted test does not over-block.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Extract shared detector helpers with parameterized `isUsable` | locked |
| C2 | Delete dead `autofill.js`, retarget `?raw`-pin tests to behavioral | locked |
