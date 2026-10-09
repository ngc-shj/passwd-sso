# Coding Deviation Log: autofill-sequential-fill

## D1: the C7 inline `func` moved to its own module

- **Plan:** C7 changes the inline `func` inside `performAutofillForEntry`.
- **Change:** the function now lives in `extension/src/background/direct-autofill.ts` as `directAutofill`, and `executeScript` receives it by reference (`func: directAutofill`).
- **Reason:** C7's write order, yield, allowlist and the same-task re-check had no test. The background tests run in a node environment and only see the `executeScript` call. As a module, the function runs directly under jsdom (`__tests__/background/direct-autofill.test.ts`). The function has no imports and no module-scope references, and the built bundle was checked to contain a self-contained `async function`.

## D2: `resolveFillRoot` alongside `boundedRoot`

- **Plan:** C1a exports `boundedRoot(anchor, t0Targets)`, and re-anchoring recomputes it against the T0 foreign set.
- **Change:**
  - `boundedRoot` also takes the kind's foreign-control predicate (`isForeignCandidate`). C1a defines "foreign" per kind: LOGIN's allowlist, `isCreditCardFillable` and `isIdentityFillable`.
  - A second export, `resolveFillRoot`, returns the root plus a `reanchor` closure that holds the T0 foreign set.
  - `runFillSequence` takes that closure as `opts.reanchor`.
- **Reason:** the T0 foreign set has to be captured once, at T0. The closure keeps it out of module state. The root type is `ParentNode & Node`, because the write check calls `contains`.

## D3: `isCreditCardFillable` and `isIdentityFillable` exported from the detectors

- **Change:** both are `isElementVisible && isUsableField`, the predicate each detector already applies to every candidate.
- **Reason:** the steps' `accepts`, the late-field relocation and the bounded-root foreign check reuse the detectors' own admission rule instead of copying it (NF2: the allowlists are unchanged).

## D4: CC expiry steps when the T0 form has no expiry field

- **Plan:** C3 lists "expiry (combined or month and year)".
- **Change:**
  - When the detector finds no expiry field at T0, both the combined step and the month/year steps are created, each deferred.
  - Each step relocates through `detectCreditCardFields(root)`, which returns either a combined field or split fields, never both. So only the shape the page renders is written.
  - The `#730` payload guard stays on the combined step.

## D5: the forbidden-pattern scan has two expected hits

- `allFrames: true` in `background/index.ts`: this is the shortcut command's `PSSO_TRIGGER_INLINE_SUGGESTIONS` trigger target, which already existed. It now goes through `injectContentBundleAndResend`, with the target unchanged. It carries no credential, and the plan's NF1 keeps frame targeting as it is.
- `"src/content/form-detector.js"` in `__tests__/background/inline-matches.test.ts`: a negative fixture. A manifest that lists the old literal must fail closed. The pattern targets production code that injects the literal; no production file under `extension/src` contains it.

## D6: React reproduction modelled on the live component tree

- **Plan:** P7 mounts "a React-controlled password field whose `onBlur` resets from state".
- **Finding:** a plain `useState` controlled input does not reproduce the race. React flushes the `onChange` update synchronously while it restores the controlled value, so the next `onBlur` sees fresh state.
- **Live tree:** reading the fiber props on the live page showed the actual shape:
  - each field shows local state that is set synchronously;
  - it hands the value to a form store whose update lands asynchronously (`c.setValue(t)`);
  - `onBlur` writes the store's value back (`r !== u.value && await c.setValue(r)`).
- **Change:** the harness reproduces that shape, with the store updated in a microtask. The precondition row asserts that the pre-fix synchronous order loses the password.
- **Red proofs:**
  - HEAD's `autofill-lib.ts` fails the fill row and the deferral row.
  - The observer-writes-directly mutant fails the deferral row, with `expected '' to be 'dummy-pw'`.

## D7: existing subframe rows now await the fill

- `inSubframe` in `__tests__/content/autofill.test.ts` became async and awaits its callback. Without that, the deny rows would read the field values before an async fill could write, so they would pass vacuously.

## D8: Step 2-2 batches finished in the main session

- **Change:** the Batch A (C1/C1a) and Batch C (C5/C7) sub-agents stopped before they finished, when the previous session ended, and they were not resumed. Batch B (C2–C4, C6) was not delegated.
- **What the main session did:** finished their partial work and wrote Batch B. Every red proof and mutation run used a scratch copy.
- **Test fixes on the way:**
  - The supersession rows in `fill-sequence-lib.test.ts` advanced past the run's end before dispatching the event. They now advance only through the first task.
  - A deadline row was added because the "deadline check removed" mutant survived: a sequencer task that runs past the deadline before the deadline handler.

## Step 2-5 self-R-check dispositions

Every finding below was fixed in Phase 2, and every new row was red-proven on a scratch copy.

- **SR-S1, R38 (security):** CC and Identity returned early, when T0 detection found nothing, without superseding the pending run.
  - Fix: the new `supersedeActiveFill()` is called on both returns.
  - Rows: a cross-kind row in each direction, red with the call removed.
- **SR-T6, R3 (testing):** the same gap on the LOGIN frame-gate return. The newer request is refused by this frame but still supersedes it, failing safe: no earlier entry keeps writing.
  - Row: red with the call removed.
- **SR-S2, R2:** `["text", "email", "tel"]` is now `USERNAME_TYPES` in `autofill-lib.ts` (all four uses) and in `direct-autofill.ts`, where the constant stays function-local because the function is serialized.
- **SR-F1 and SR-T4, RT3:** the tests now use `BUNDLE_RESEND_ATTEMPTS`, `BUNDLE_RESEND_INTERVAL_MS` and `DEFAULT_LATE_FIELD_WINDOW_MS` instead of copying their values.
- **SR-T1, missing plan rows:** three background rows were added:
  - the Identity fallback, with the dev-shape loader and the originating frame;
  - LOGIN ordering: message, then bundle, then resend;
  - LOGIN when every resend gets "no receiver": the bundle comes first, then the `func` exactly once.

  Red against four mutants: Identity on the old literal, the LOGIN retry removed, the `func` run twice, and the `func` run before the bundle.
- **SR-T2, RT9:** a row rebuilds `directAutofill` from `toString()`, as `executeScript` does. It is red when a module-scope reference is added.
- **SR-T3, RT6 and RT7:**
  - The three `perform…()` functions are now `async`, so a throw during T0 detection reaches the listener's `.catch` and the closed-code sink. One row per kind checks this; each is red when its function is not `async`.
  - The release-throw row asserts `fill-release-error`.
- **SR-T5, RT11:** the no-body row removes its stray input in a `finally` block.

## D9: C5's bundle module, pinned to one document and gated by scope (Phase 3 round 1: F4, S1, S2)

- **Location:** C5 lives in `extension/src/background/content-bundle.ts`, not inline in `index.ts`. That makes it a unit the tests can drive, and lets it export `BUNDLE_RESEND_*` for them.
- **Pinning by document (S1):**
  - A probe, `executeScript({ func: () => location.href })` against the caller's frame target, returns that document's `documentId` and URL together.
  - The bundle is then injected into `{ tabId, documentIds }`, and every resend uses `chrome.tabs.sendMessage(..., { documentId })`.
  - The LOGIN `func` fallback targets the same `documentIds` once a bundle injection resolved a document.
  - A frame target that does not resolve to exactly one document with an id fails closed under the caller's existing error code.
  - This corrects the rationale in SC3: pinning the post-injection interval needs no new permission, because `executeScript` returns `documentId` and `sendMessage` accepts it. The first send and the content path (the original SC3 scope) remain a follow-up.
- **Scope gate (S2):**
  - A probed document is injected only when its URL matches the bundle entry's own manifest `content_scripts[].matches`. `matchesPattern` covers the forms the manifest uses; any other form matches nothing.
  - `activeTab` would otherwise let the now-working injection reach `http://` pages the manifest skips. The LOGIN `func` behaviour on such pages already existed and is unchanged.

## D10: precedence for one element claimed by two steps (Phase 3 round 1: F1, F5)

- **OTP fields (F1):**
  - OTP targets are reserved before the username is chosen; the focused field, the hinted field and the username candidate list all exclude them. The OTP code therefore lands in a focused or hinted OTP field, as it did on `main`, where TOTP was written after the username and overwrote it.
- **Other shared elements (F5):** when two steps choose the same element at T0, the first one in step order owns it, and the later step is abandoned at once instead of waiting out the window. The cases are:
  - two custom fields with one label;
  - Identity keys that resolve to one element, such as `address`/`addressLine2` or `country`/`region`;
  - a custom field whose label names the OTP field.

  This replaces `main`'s last-writer-wins. That outcome was never a contract, and first-wins keeps the run from staying open for no write.

## D11: wake-ups for waiting steps (Phase 3 round 1: F2, F3)

- **Deadline (F2):** once the deadline handler has run, the deadline counts as reached, even if `performance.now()` is a fraction of a millisecond short, because `setTimeout` truncates the delay. The delay is now rounded up.
- **Polling (F3):** waiting steps are also re-checked every `WAITING_POLL_MS` (100 ms) until the deadline. A field can become acceptable without a mutation under `<body>`, for example through a CSS transition or a stylesheet or `<html>` class change.
  - Like the observer, the poll only schedules the sequencer's own task and never writes.
