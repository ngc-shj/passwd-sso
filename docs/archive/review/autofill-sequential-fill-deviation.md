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
