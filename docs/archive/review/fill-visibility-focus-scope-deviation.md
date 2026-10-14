# Coding Deviation Log: fill-visibility-focus-scope

## D1: the CC / identity setters no longer re-check visibility

- **Plan:** C1 lists "all three local write checks" as `isFieldVisible` callers.
- **Change:** the local `isFieldVisible` copies in `autofill-cc-lib.ts` and `autofill-identity-lib.ts` were deleted, and the setters do not re-check visibility.
- **Why:** every write already runs in the task where its step's `accepts` has just passed (`runFillSequence`), and `accepts` is now per role (`isCreditCardExpiryFillable` and `isIdentityRegionFillable` for the geometry-exempt roles). A setter-level check could not know the role, so it would either deny Select2 selects or exempt every select.

## D2: the focus rescan fires only for a field the last scan saw hidden

- **Plan:** C2 says the `focusHandler` runs one `rescan()` when a focused non-member is usable and `isFieldVisible`.
- **Change:** the rescan also requires that the last scan rejected that field as hidden. `fillAdmission(hidden)` records the rejections in `hiddenAtScan`.
- **Why:** the plan's rule scanned on every focus of an ordinary non-card or non-identity field. That breaks the #875 rate bound, which the existing focus-matrix tests pin ("non-member with nothing pending or recent: 0 scans"). A field revealed by a rule that no mutation shows was rejected as hidden at the last scan, so the narrower gate still admits it on first focus.

## D3: no `scrollWidth` / `scrollHeight` stub

- **Plan:** Testing says the stub resolves `scrollWidth` / `scrollHeight` from `data-scroll`.
- **Change:** that stub was not added.
- **Why:** the R4 scroll axis was settled in plan round 3 (sec M1) as "the field scrolled into the container's client box". It reads `clientWidth` / `clientHeight` and `clientLeft` / `clientTop`, never the scroll extent, so the stub supplies client sizes only.

## D4: LOGIN finders do not share a visibility cache

- **Plan:** C1 "Cost" passes a per-scan cache.
- **Change:** detection (`fillAdmission`) creates one cache per scan. The LOGIN T0 finders call `isFieldVisible` without one.
- **Why:** the finders touch a handful of inputs once per fill, not every field on every mutation, so there is no per-mutation cost to amortise.

## D5: the twin's card-number search does not exempt selects

- **Change:** the twin's union of card blocks finds the card number with its inline `isVisible`, with no `geometryExempt` for a `<select>`.
- **Why:** on the content side, the exemption matters only for expiry and region selects. A card number is never a select, so this cannot change which card number the twin anchors on. The twin also writes no selects.

## D6: `environmentMatchGlobs` removed with the test typecheck

- **Plan:** remove the dead `environmentMatchGlobs` block.
- **Change:** removed together with the F12 test typecheck. The new typecheck rejects the key, which vitest 5 no longer accepts.
- **Files it named:** `webauthn-bridge-lib.test.ts` already has a jsdom docblock. `dpop-key.test.ts` was already running in the default node environment, and its comment now says so.

## D7: the cache-lifetime red-proof

- **Plan:** making the visibility cache module-level should turn the C2 `<details>` test red.
- **Result:** it does. The Phase 2 testing R-check shared one module-level cache across every `fillAdmission` call, and 17 tests went red. They include the C2 `<details>` and CSS-only reveal tests, and `field-visibility.test.ts` "a new admission sees a style change".
- **Correction:** an earlier note here said the `<details>` test stayed green. That came from a different mutation, which cached inside the focus rescan only, and it does not describe the module-level cache.

## D8: mutations no test can distinguish

- **The scroll window's `client < 4` early return:** an equivalent mutant. Without it, the carried span is `min(size, client) < 4`, and the per-ancestor size check right after it denies.
- **The twin's shadow-host step (`parentOf`):** unreachable in the twin. Its candidates come from `document.querySelectorAll("input")`, which never returns a shadow-root input. The content copy is pinned by the predicate tests.
- **`focusScopedFields`' `node === cap` stop in the first loop:** every markup built to reach past the cap falls back to the same result as `detect(document)`.

## D9: `focusScopedFields` takes a `FocusScope` object

- **Plan:** C3's signature is `focusScopedFields(detect, roles)`.
- **Change:** it takes `{ detect, roles, anchors, competes }`.
- **Why:** plan round 3 (func M1) made the climb stop on a competing *block*, and the threshold differs per kind (CC: a card number plus one more role; identity: two shared roles). The start condition also differs: CC needs a card number. Both are per-caller, so they are passed in alongside `detect` and `roles`.

## D10: dropdown membership covers each `<form>`, not every block

- **Change (code review round 1, func F3):** each scan also runs detection on every `<form>`, so a second card or identity form's fields get a dropdown.
- **Still not covered:**
  - a second block inside one `<form>`, such as billing and shipping in the same form;
  - form-less multi-block pages.

  These were not covered before this branch either. They still fill correctly from the popup and the context menu (C3).
- **Why stop there:** covering them needs block detection over every candidate at every scan, or a focus-time scan of every non-member. The first costs a full scan per candidate on every page; the second breaks the #875 rate bound.

## D11: an OTP input hidden off-screen or at 1px is no longer filled

- **Change (code review round 1, func F7):** `transparentOk` lifts the opacity rule only, so a single-input OTP widget that hides its real input with `left:-9999px` or a 1px box (a key catcher) is not filled. Widgets that overlay an `opacity:0` input are still filled.
- **Accepted cost:** exempting OTP from geometry would let a page hide an input anywhere and receive the code.
- **Worst case:** the user types the code by hand on such a widget.

## D12: the scroll axis is bounded by the engine's scroll extent, not by a derived direction

- **Plan:** C1 R4, as settled in plan round 3, maps a field into the scroll window. Code review then derived each axis's scroll direction by hand: first from RTL only, then from direction, writing-mode and flex-direction.
- **Change:** `meetsScrollBand` bounds the field by a band computed from the engine's own `scrollLeft` / `scrollTop` and `scrollWidth` / `scrollHeight`. The sign of the offset picks the band, because the engine keeps a forward axis's offset in [0, slack] and a reversed one's in [−slack, 0]:
  - a positive offset takes the forward band;
  - a negative offset takes the reversed band;
  - an offset at rest (0) takes the union of the two.

  There is no CSS-derived direction classification.
- **Why:** each hand-derived direction rule left a member out. Code review rounds 2 and 3 each found one: first reversed flex and writing modes, then `sideways-lr`. Every miss was a widening or a false denial in a security tripwire. The engine's scroll extent excludes content it cannot scroll to, whichever way the axis runs.
- **Cost (code review round 4, sec R4-S1):** at rest the union admits an unreachable strip as wide as the pane's scrollable slack. That strip lies before a forward pane's origin, or past a reversed pane's window end.
  - Slack is cheap to create invisibly (one `opacity:0` spacer) and is free on long feeds.
  - A hostile page gains no capability beyond bypass class (iv): it could place the same field in the reachable slack instead.
  - The accepted false admit is an honest page's off-screen honeypot whose containing block is a scroll pane at rest.
  - Once the pane has been scrolled, the strip is gone.
  - Resolving the at-rest ambiguity would mean moving the page's scroll position. That is not done, because smooth `scroll-behavior` makes the read-back stale and the move fires scroll events.

## D13: the fail-safe containing-block test also counts some non-trigger values (code review round 3, func R3-1)

- **Behaviour:** `containsFixed` counts any `will-change`, `contain` or `container-type` off its initial value as a containing block. Chrome does not do this for values such as `will-change: opacity`, `contain: size|style` and `container-type: inline-size`.
- **Effect:** a non-portal fixed modal or an escaping absolute popover drawn outside a clipping ancestor that has one of those values reads as hidden, and is not filled. This is a false denial.
- **Accepted, not fixed:** splitting these values into triggers and non-triggers is a hand-maintained member list of the kind that widened the tripwire in rounds 2 and 3. A missing trigger there fails open. As it stands, the error falls only on the deny side.
- **Worst case:** on such a page the user fills the field from the popup after closing and reopening the overlay, or types the value by hand. No secret is exposed.
- **Likelihood:** low. The reviewer's own assessment is that a container-query card with `overflow:hidden` around a non-portal fixed or absolute field is the likeliest case, and it is uncommon. The common cases (`will-change: transform`, `contain: strict|content`) are real containing blocks.
- **Cost to fix later:** small, if a real page shows the false denial. Add the value to a non-trigger allowlist, with a test.
