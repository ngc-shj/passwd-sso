# Coding Deviation Log: pin-first-autofill-send

## D1: `AutofillRequestOrigin` lives in its own module (C1)

- C1 places `AUTOFILL_REQUEST_KIND` / `AutofillRequestOrigin` next to `performAutofillForEntry` in `background/index.ts`. They live instead in `extension/src/background/autofill-request-origin.ts`.
- Reason: `context-menu.ts` builds the context-menu origin, and `index.ts` imports `context-menu.ts`. Importing the type back from `index.ts` would form a cycle (R10).

## D2: `ContextMenuDeps.performAutofill` takes `(entryId, tabId, origin, teamId?)` (C1)

- The plan's Testing strategy quotes `(entryId, tabId, origin, targetHint, teamId)` for the context-menu assertions. The dependency takes no `targetHint`, because a context-menu click has none.
- The `initContextMenu` wiring passes `undefined` for `targetHint` to `performAutofillForEntry`.

## D3: `injectContentBundle`'s `acceptDocument` parameter is removed

- CC/Identity no longer go through `injectContentBundleAndResend`. They probe, pin and inject through `deliverToRequester` (C2/C3). That left `acceptDocument` and `CONTENT_BUNDLE_ERROR.DOCUMENT_REFUSED` with no caller.
- The remaining caller, `PSSO_TRIGGER_INLINE_SUGGESTIONS` with `allFrames`, never passed `acceptDocument`, so both are removed rather than kept as dead code.

## D4: `INTERNAL_ERROR` gets a display string; the popup-code scan is bounded

- Moving the `onMessage` failsafe into `respondWithFailure` (C5) exposed two pre-existing defects in `__tests__/error-messages.test.ts`'s "maps every code the popup-invoked handlers can return".
- **The scan never stopped at the next arm.** Its terminator, `"\n      case EXT_MSG."`, has six spaces, and `handleMessage`'s arms are indented four. Before this change it matched nothing, so every arm was read through a 4000-character window that ran into its neighbours. With `respondWithFailure` placed after `handleMessage`, its six-space arms matched instead, and the window grew to most of the file.
  - The terminator now matches the next arm at any indentation, and fails when there is none.
  - `respondWithFailure` sits after `handleMessage`, where the failsafe was, so `indexOf("case EXT_MSG.X:")` still finds the real handler first.
- **`INTERNAL_ERROR` had no display string.** The failsafe answers a throwing popup handler (`COPY_PASSWORD`, `FETCH_PASSWORDS`, ...) with `INTERNAL_ERROR`, and `humanizeError` returned the raw identifier, which the popup rendered as is.
  - It now maps to `errors.internalError` in `en.json` and `ja.json`.
  - A new test, "maps the code the background failsafe returns to the popup", pins this.
- Found mid-task, so fixed here (memory `feedback_solve_dont_scope_out_discovered_defects`).

## D5: `parseHttpOrigin` added to `lib/url-matching.ts` (C5)

- C5 requires the background to refuse an `expectedOrigin` that does not parse as an http(s) origin. No existing helper decides this.
- `parseHttpOrigin` returns the value only when it equals its own `URL.origin` serialisation. A full URL is refused, so the result compares with `===` to `self.origin` and to probed origins.
