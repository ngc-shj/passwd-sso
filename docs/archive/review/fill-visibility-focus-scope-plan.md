# Plan: fill-visibility-focus-scope (#884, #886)

Two extension fill defects, fixed together because both change how the fill paths choose their targets.

- **#884 — hidden fields are filled.** Every fill path decides visibility on its own, and none looks at ancestors, size or position. A page can show one field and put the CVV, the password or identity PII in a hidden container, and the fill writes them all.
- **#886 — card and identity fill ignore focus.** Card and identity fill detect over the whole `document`, so the first form on the page wins even when the user focused a field in a later one.

## Project context

- **Type:** `mixed`. Only `extension/src/content/` and `extension/src/background/direct-autofill.ts` change, plus tests and the test setup.
- **Test infrastructure:** `unit tests only` (vitest 5 + jsdom 29), plus CI.
- **Verification environment constraints:**
  - **VE1:** jsdom has no layout, no `checkVisibility` and no `elementFromPoint`, and it shows closed `<details>` content as visible. Geometry rules are therefore tested against a stubbed layout (see Testing).
  - Real rendering is checked by hand in Chrome on macOS, by the user before merge, using the scenarios at the end. Status: `blocked-deferred`, because only a real renderer decides layout.

## Visibility deciders today (member set, R42)

**Derivation:** `grep -rnE "isElementVisible|isElementVisuallySafe|isFieldVisible|function isVisible|const isVisible|isInputHitTestSafe|accepts:|getComputedStyle" extension/src/content extension/src/background/direct-autofill.ts`, then walking every T0 finder, every write, every detection admission and every exclusion or boundary use.

| Member | Today | Direction |
|---|---|---|
| `field-query-lib.isElementVisible` in `detectCreditCardFields`, `detectIdentityFields`, `isCreditCardFillable`, `isIdentityFillable` | own display / visibility / opacity | admission + write |
| `autofill-cc-lib` local `isFieldVisible` (`setInputValue`, `setSelectValue`) | own display / visibility | write |
| `autofill-identity-lib` local `isFieldVisible` (`setInputValue`, `setSelectValue`) | own display / visibility | write |
| `autofill-lib` local `isVisible`: `findPasswordInput`, `isTextLikeTarget`, `isPasswordTarget` | own display / visibility | T0 + write |
| `autofill-lib` `isUsernameTarget`, `findUsernameInput`, `findFocusedTextInput`, hinted input, `findOtpInput`, `findSplitOtpInputs` | **none** | T0 + write |
| `direct-autofill` inline `isVisible`: password finder, custom fields, per-write re-check; `fallbackUsername` / active / hinted pick has **none** | own display / visibility / opacity | T0 + write |
| `form-detector-lib.isElementVisuallySafe`: LOGIN / CC / identity inline dropdown gates | own + clip-path / transform strings | dropdown admission |
| `ccFormFields` / `ccCardBlockFields` (via `detectCreditCardFields`, `isCardNeighbour`) feeding `isLoginEligible`, save capture (`findPasswordInputs`), and the twin's `isCardFillable` mirror | own style | **exclusion** (deny widens) |
| foreign-control predicates passed to `resolveFillRoot` / `boundedRoot`: `isLoginForeignCandidate`, `isCreditCardFillable`, `isIdentityFillable` | own style | **boundary** (deny widens) |

## Contracts

### C1: one visibility predicate for admission, selection and writes

- **Signature:** `isFieldVisible(el: HTMLElement, opts?: { transparentOk?: boolean; geometryExempt?: boolean; cache?: VisibilityCache }): boolean`. A `cache` lives for one detection call or one finder pass, and is never reused across fill-sequence ticks, because styles change between ticks (N4). It holds raw per-ancestor style and rect data only, never per-element verdicts, because the options change the verdict (M3)., in `content/field-query-lib.ts` (a leaf module).
- **Evaluation:** a pure AND. It returns false when **any** rule below holds, and **no branch returns true early**. A zero or absent rect denies.
  - **R1:** the element or an ancestor (walking `parentElement`, then the shadow host) has computed `display:none` or `content-visibility:hidden`.
  - **R2:** the element's own computed `visibility` is not `visible`. Visibility inherits, so the element's own value decides.
  - **R3:** the product of the element's and its ancestors' opacity is ≤ 0.05. This rule is skipped when `transparentOk` is set.
  - **R4:** the element's rect, clipped per axis by its ancestors, is smaller than 4×4 px. This one engine-derived rule covers zero size, transforms, zoom, the `overflow` clip and closed `<details>`.
    - A `hidden` or `clip` axis (`overflow-x` / `overflow-y` longhands), or paint containment (`contain` including `paint` / `strict` / `content`, or `content-visibility: auto`), intersects strictly with the ancestor's rect.
    - A `scroll` or `auto` axis is handled by the scroll window (func round 2 N1, sec round 3 M1):
      - When the container's client size on that axis is under 4px, the axis is a strict clip and denies.
      - Otherwise the field counts as scrolled into the window. On that axis, the carried rect becomes a span of `min(field size, client size)` inside the container's client box, and outer ancestors clip that span.
      - A field below the fold of a scroll container (including `body{overflow-x:hidden}`, which computes `overflow-y:auto`) therefore stays visible, even under an outer `overflow:hidden` wrapper of normal size.
    - `display:contents` ancestors are skipped.
    - The walk stops at a `position:fixed` element.
  - **R5:** the clipped rect lies wholly before the document origin. For a fixed element the bound is the viewport; otherwise it is `right + scrollX ≤ 0` or `bottom + scrollY ≤ 0`.
  - **R6:** the element or an ancestor (on the same walk as R1) has a non-`auto` `clip` while `position` is absolute or fixed, or a `clip-path` beginning `inset(100%`, `inset(50%` or `circle(0` (N3).
  - **R7:** `el.checkVisibility?.({ opacityProperty: !transparentOk, visibilityProperty: true })` returns `false`. This rule can only deny.
- **`geometryExempt` (F4, N1):** with it, R4–R6 are skipped; R1–R3 and R7 still apply.
  - The exemption is given by role, by the caller, and only to a `<select>`. The roles are the CC expiry month/year steps and the identity country / state (region) steps.
  - Admission runs before roles are known, so detection admits every `<select>` with `geometryExempt` (M2).
    - The role restriction is enforced by each step's `accepts`, at write time and on relocate.
    - The expiry and country / region steps accept with `geometryExempt`; every other step, `dateOfBirth` included, accepts with the full predicate.
    - Known cost: a hidden DOB select can win the role and is then denied at write. This fails safe.
  - Select2 / selectWoo, which WooCommerce country/state and many expiry selects use, hide the native select with `clip` and a 1px size, and the fill writes it on purpose.
  - Every other role, including a `<select>` used as date of birth, postal code, city or a name, gets the full predicate. Option enumeration on a hidden select would leak the written value.
- **`transparentOk` (F4, N2):**
  - It is used only by a dedicated `isOtpTarget` (`isTextLikeTarget` + `isFieldVisible(el, { transparentOk: true })`), for `findOtpInput`, `findSplitOtpInputs` and the TOTP steps' `accepts`.
  - Custom-field steps keep `isTextLikeTarget` with the full predicate.
  - Single-input OTP widgets overlay an `opacity:0` input on drawn boxes, and a TOTP code is short-lived.
- **Callers by direction (S3):**
  - **Admission, T0 selection and write** (deny = safe) use `isFieldVisible`. This covers:
    - CC / identity detection admission and `isCreditCardFillable` / `isIdentityFillable` as `accepts`;
    - all three local write checks;
    - the LOGIN finders and `accepts` predicates, now including `isUsernameTarget`, `findUsernameInput`, `findFocusedTextInput`, the hinted input and both OTP finders;
    - the inline dropdown gates (in place of `isElementVisuallySafe`).
  - **Exclusion and boundary** (deny = widen) keep today's own-style rule, renamed `isNotSelfHidden` in `field-query-lib`:
    - `ccFormFields` / `ccCardBlockFields`, which get a `detectCreditCardFields(root, admit)` parameter;
    - `isCardNeighbour`;
    - the foreign-control predicates handed to `resolveFillRoot` / `boundedRoot`;
    - the twin's `isCardFillable`.
  - **Union for exclusion (func round 2, N3):** `ccCardBlockFields` unions the card block anchored on the `isNotSelfHidden`-admitted card number with the one anchored on the `isFieldVisible`-admitted card number. A hidden card form before a visible one therefore excludes both. The twin's mirror does the same.
  - **Consequences:**
    - A card block hidden by an ancestor is still a card form, so its CVV stays LOGIN-ineligible for fill and for save capture (F10).
    - With a hidden card form before a visible one, the visible CVV is also LOGIN-ineligible.
    - A control under a hidden ancestor still bounds the fill root.
- **Deleted:** `isElementVisible`, `isElementVisuallySafe`, both local `isFieldVisible` copies and the LOGIN `isVisible`.
  - `isInputHitTestSafe` stays as the dropdown's overlay check, after `isFieldVisible`.
  - `isPageVisuallySafe` is unchanged.
- **Twin:** `direct-autofill.ts` carries an inline copy of `isFieldVisible` (same rules; it writes no selects and has no OTP path, so it needs neither option). Its `fallbackUsername` loop and its active / hinted pick filter on it (F3). Its `isCardFillable` uses the inline own-style rule.
- **Cost (F6):** detection creates one `WeakMap` cache per scan and passes it to `isFieldVisible`, so each ancestor's style and rect verdict is computed once per scan.
- **Control class:** `best-effort tripwire`.
  - **Against a hostile page it is friction, not a control.** Its real value is not filling fields that an honest page hides.
  - **Known bypass classes:**
    - (i) an overlay covering a field (the hit test runs only for the dropdown's own field);
    - (ii) paint-level hiding (`filter`, `mix-blend-mode`, transparent colour, `font-size:0`, opacity just above 0.05);
    - (iii) a style flip around the check: the page reveals a field after the previous write and hides it again in that field's own event handler;
    - (iv) a ≥ 4×4 field placed far right or below the fold — of the page, or of a scroll container with a window of 4px or more — that the user never scrolls to;
    - (v) the embedding `<iframe>`'s visibility, which is per-document. This is mitigated because the popup fills frame 0 only;
    - (vi) `clip-path` shapes other than those listed in R6.
  - **Cut-line:** stop at what the renderer decides deterministically: computed style, rects and `checkVisibility` (R47). Overlay and below-the-fold bypasses dominate everything beyond that, so chasing paint variants buys nothing.
- **Adjudication authority:** the browser's computed style and layout rects, plus `checkVisibility` where it exists.
- **Invariant (app-enforced):** every admission, T0 selection and write reads `isFieldVisible`, and every exclusion and boundary predicate reads `isNotSelfHidden`.
- **Forbidden patterns:**
  - `pattern: isElementVisible\b|isElementVisuallySafe\b` — **reason:** replaced.
  - `pattern: function isVisible\(|function isFieldVisible\(|const isFieldVisible =`, outside `field-query-lib.ts` and the twin — **reason:** a second local rule is the #884 defect.
  - `pattern: (width|height) < \d+\)? *(\|\||&&).*return true`, inside `isFieldVisible` or the twin copy — **reason:** a layout-less escape reopens #884 in Chrome (S1).
- **Acceptance:**
  - On every path (CC, identity, LOGIN content including username / password / custom / OTP, and the twin), a field hidden by each rule is not written, and a visible sibling in the same markup is.
  - A hidden duplicate placed *before* a visible username / OTP still fills the visible one (F3).
  - A Select2-style hidden native select is still written for the expiry and country / state roles.
  - A 1px clipped `<select>` used as `dateOfBirth` is not written.
  - An `opacity:0` overlay OTP input is still written.
  - An `opacity:0` input matching a custom-field label is not written.
  - A card form whose number alone is hidden still excludes its CVV from LOGIN.
  - A hidden card form before a visible one leaves the visible CVV LOGIN-ineligible, in content and in the twin.
  - A field below the fold of an `overflow-y:auto` container is written, and so is one in an inner `auto` pane inside an outer `overflow:hidden` wrapper.
  - The same field under `overflow-y:hidden; height:0`, `overflow-y:auto; height:0` or `overflow-y:auto; height:2px` is not written.
  - A control under a hidden ancestor still bounds the fill root.

### C2: detectors re-scan when a container is revealed

- `OBSERVED_ATTRIBUTES` (`fill-sequence-lib.ts`) gains `open`, so `<dialog>` / `<details>` toggles re-scan.
- The CC and identity `focusHandler` run one `rescan()` when a focused non-member is usable and `isFieldVisible` (F5). This covers reveals that no observed attribute shows: CSS-only `:checked` / `:target`, transitions, `<html>` class changes and media queries. Focus is user-driven, so the cost is bounded.
- **Acceptance:**
  - Opening a `<details>` that holds a card form admits its fields.
  - A card panel revealed by a CSS `:checked` sibling rule is admitted on first focus.

### C3: card and identity fill scope to the focused field

- **Signature:** `focusScopedFields<T>(detect: (root: ParentNode) => T | null, roles: (fields: T) => readonly (Element | null)[]): T | null`, in `content/fill-sequence-lib.ts`.
  - **Anchor:** `document.activeElement` when it is an `<input>` / `<select>`.
  - **Start:** from the anchor's parent, find the lowest ancestor `S` whose `detect` result is non-null (and, for CC, has a card number).
  - **Climb (F1, func round 2 N2):** from `S`, step to the parent `P` (capped at the anchor's `form` and below `<body>`) while:
    - every non-null role element found so far is still the same element at `P`; and
    - no child of `P` off the anchor's path detects a competing **block** (M1):
      - **CC:** a card number plus at least one other card role;
      - **identity:** at least 2 roles the anchor's branch already holds.

      A confirm-email row, or a split phone / postal-code / card-number input, is one duplicate field and does not stop the climb.

    This catches a competing block whatever its document order.
  - **Return:** the detection at the chosen root. With no anchor or no `S`, it returns `detect(document)`, which is today's behaviour.
- `performCreditCardAutofill` and `performIdentityAutofill` take their T0 fields from it. `resolveFillRoot` is unchanged and still anchors on the T0 card number or first target.
- **Focus survives each trigger:**
  - the dropdown keeps focus (mousedown `preventDefault`);
  - the popup leaves the page's `activeElement` in place and fills frame 0;
  - a right-click focuses the input.

  So the payload shape is unchanged.
- **Control class:** not a guard. This is target selection and only narrows; R43 checked by the security review.
- **Acceptance:**
  - In the #886 two-form markup, focusing form 2 fills all of form 2 and none of form 1, both with form-level markup and with a wrapper `<div>` around each field. The same holds for identity.
  - A single form with a confirm-email row and a 3-input phone, focused on email, fills every role.
  - Focusing block 1 leaves block 2 untouched, for two blocks in one `<form>` and for div-only markup (the mirror case).
  - With no focus, form 1 is filled.
  - Focusing a field in a third form that has no card number fills form 1, and form 2 stays empty.

## Testing strategy

- **Global layout stub (T1, T2, T5):**
  - A `setupFiles` entry, guarded by `typeof Element !== "undefined"`, patches `Element.prototype.getBoundingClientRect` and `HTMLElement.prototype.checkVisibility`. The default box is 100×20 at (10, 10).
  - Each element's rect is resolved at call time from a `data-rect="w,h,x,y"` attribute, so it survives `innerHTML` rebuilds and reaches the twin.
  - Content of a closed `<details>` gets a zero rect, and `checkVisibility` returns false for it. A `checkVisibility` override hook pins the "undefined" case.
  - Without this stub, 335 of 1723 tests fail under the size rule (testing review measurement); with it, all pass.
  - Remove the dead `environmentMatchGlobs` block.
- **jsdom fixture rules (testing round 2):**
  - Clipping ancestors use the `overflow-x` / `overflow-y` longhands; jsdom does not expand the shorthand. Include x-only and y-only deny cases. The implementation reads the longhands only.
  - The stub also resolves `scrollWidth` / `scrollHeight` from a `data-scroll="w,h"` attribute (default: the rect size) and `clientWidth` / `clientHeight` from the rect, so the R4 scroll-axis cases are testable.
  - Shadow-host R1 fixtures hide through inline style, because jsdom ignores shadow-root stylesheets.
  - The stub's `checkVisibility` returns false for closed-`<details>` content, and for computed opacity `0` on the element or an ancestor when `opacityProperty` is set. Overrides are restored after each test (the run is shuffled).
  - One closed-`<details>` case runs with `checkVisibility` undefined, so R4 alone must deny.
  - The C2 CSS-only reveal is modelled by an `<html>` class flip. jsdom caches computed style after a radio click, and `<html>` is outside the observed `body`, so only the focus rescan can admit the field. The real `:checked` case stays manual (scenario 5).
  - `geometryExempt` pairs:
    - the Select2 `.select2-hidden-accessible` style on an expiry / country select is written;
    - the same select as `dateOfBirth` is not written;
    - a select under a `display:none` ancestor is not written;
    - a select in a closed `<details>` is not written.
  - The `isNotSelfHidden` and boundary red-proofs hide the card number or control through an ancestor or a zero `data-rect`, never its own `display:none`, so that the two predicates differ.
- **Predicate:** one test per rule, each paired with an allow case that differs only on that axis (T4). The pairs:
  - **R1:** `display:none` on an ancestor, not the element; through a shadow host; ancestor `content-visibility`.
  - **R2:** allow case is a visible child under a hidden parent.
  - **R3:** 0.2 × 0.2 denied vs 0.5 × 0.5 allowed, plus `transparentOk`.
  - **R4:** 3×20 denied vs 4×4 allowed; an `overflow:hidden` zero ancestor vs `overflow:visible`; a `display:contents` ancestor; a fixed element escaping the clip.
  - **R5:** boundary `right = 0` vs `right = 1`.
  - **R6:** the comma `rect(0px, …)` form, absolute vs static.
  - **R7:** `false` / `true` / undefined.
  - **`geometryExempt`:** pass vs deny on the same 1px clipped select.
  - **Twin:** includes a 0×0 deny case.
- **Paths:** one hidden-field test per path and target (CC, identity, LOGIN username / password / custom / OTP, twin), each asserting hidden = `""` and visible = value. Plus the C1 acceptance cases.
- **Parity (T3):** each twin case asserts the absolute outcome as well as twin = content.
- **Mocks (T6):** remove the dead `isElementVisuallySafe` mocks in `fill-dropdown-suppression.test.ts` and `cc-identity-detector.test.ts`, and move `form-detector.test.ts`'s `isElementVisuallySafe` tests to the predicate tests. Keep one test showing that a zero-rect input gets no dropdown (T9).
- **C2 / C3:** as their acceptance criteria. Focus only visible fields (T8).
- **Red-proof (T11)** on a scratch copy, one at a time:
  - each rule, in `isFieldVisible` and in the twin copy;
  - the `isUsernameTarget` addition, each finder filter, `geometryExempt` per role and `isOtpTarget`;
  - `open` in `OBSERVED_ATTRIBUTES`, and the focus rescan;
  - each `focusScopedFields` call site and the climb (lowest-match only must go red on the wrapper case);
  - the `isNotSelfHidden` exclusion (switching it to `isFieldVisible` must go red on the hidden-number case).
  - hard-coding `opacityProperty: true` in both copies (the OTP overlay test must go red);
  - a module-level instead of per-scan cache (the C2 details test must go red).
- **Full run:** `npx vitest run`, `npx tsc --noEmit -p .`, `npm run build`, `scripts/pre-pr.sh`.

## User operation scenarios (manual, Chrome)

1. A card form inside `<div style="display:none">` next to a visible one: only the visible one is filled.
2. An identity form with phone and address in an `opacity:0` wrapper: those are not filled.
3. A login form with a `left:-9999px` password, and one with the password in a 2px `overflow:hidden` box: neither is filled.
4. The #886 two-card-form page (with per-field wrapper divs): focus form 2, then fill from the dropdown, the popup and the context menu. Form 2 is filled completely each time.
5. A checkout behind a `<details>` toggle, and one revealed by a payment-method radio: after the reveal, the inline dropdown appears.
6. A WooCommerce / Select2 checkout: country and state are filled.
7. A TOTP page with an overlay-style single OTP input: the code is filled.
8. Regression: ordinary login, card and identity pages fill as before, including an app-shell page (`body{overflow-x:hidden}`, scroller div) with fields below the fold.

## Scope contract

- **SC1:** #874 (retention-gc) is PR③.
- **SC2:** #878 (removing the direct-autofill twin) is separate. This PR keeps the twin in parity.
- **SC3:** popup and context-menu fills get no hit-test overlay check. This is C1 bypass (i).
- **SC4:** the per-`childList` synchronous rescan cadence is unchanged; only the per-scan cache is added (F6). Debouncing it is a separate performance change.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | one ancestor-aware visibility predicate, by direction, on every path + twin | locked |
| C2 | re-scan on `open` and on focus of a revealed field | locked |
| C3 | card / identity fill scoped to the focused field | locked |
