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

## D6: `environmentMatchGlobs` left in `vitest.config.ts`

- **Plan:** the testing round-1 review called it dead config and asked for its removal.
- **Change:** it is still there.
- **Why:** removing it is a cleanup unrelated to this change and alters nothing observable. It is left to a separate chore.

## D7: the cache-lifetime red-proof

- **Plan:** making the visibility cache module-level should turn the C2 `<details>` test red.
- **Result:** it does. The Phase 2 testing R-check shared one module-level cache across every `fillAdmission` call, and 17 tests went red. They include the C2 `<details>` and CSS-only reveal tests, and `field-visibility.test.ts` "a new admission sees a style change".
- **Correction:** an earlier note here said the `<details>` test stayed green. That came from a different mutation, which cached inside the focus rescan only, and it does not describe the module-level cache.

## D8: mutations no test can distinguish

- **The scroll window's `client < 4` early return:** an equivalent mutant. Without it, the carried span is `min(size, client) < 4`, and the per-ancestor size check right after it denies.
- **The twin's shadow-host step (`parentOf`):** unreachable in the twin. Its candidates come from `document.querySelectorAll("input")`, which never returns a shadow-root input. The content copy is pinned by the predicate tests.
- **`focusScopedFields`' `node === cap` stop in the first loop:** every markup built to reach past the cap falls back to the same result as `detect(document)`.
