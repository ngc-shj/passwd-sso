# Plan: sequential autofill writes with fixed targets (`#654` + Sony Bank login)

Revision 2 (after plan review round 1, see `autofill-sequential-fill-review.md`).

## Project context

- Type: browser extension (MV3, CRXJS/Vite, TypeScript) inside the web app repo.
- Test infrastructure: unit (vitest + jsdom, `sequence.shuffle` on) + CI. The extension has no ESLint beyond the console gate; `tsc` + vitest are its gates. React, react-dom and @testing-library/react are devDependencies.
- Verification environment constraints:
  - **VE1**: real-site behaviour needs a real browser. `verifiable-local`: `docs/archive/review/autofill-sequential-fill-probe.mjs` (Playwright, network) reproduces the Sony Bank table. Testing with the installed extension and a vault entry is manual and `blocked-deferred` to the user.
  - **VE2**: Chrome does not dispatch focus or blur to a page whose window lacks focus. That is why the toolbar-popup fill never triggers the page's blur handler. `blocked-deferred` (manual).

## Problem

Every fill function writes all of its fields in one synchronous pass.

1. **Sony Bank login (LOGIN).** Picking the entry from the inline dropdown fills 店番号 and 口座番号 (custom fields), but the password ends up empty. The popup fills all three. On the live page with the real write helper:

   | Write order | Password after fill |
   |---|---|
   | password, then the custom fields, all in one task (current) | **empty** |
   | the same order with `setTimeout(0)` between fields | kept |
   | custom fields first, password last | kept |

   The password is a React-controlled input. Writing it and then calling `focus()` on the next field in the same task runs the password's `onBlur` before React commits the update, so the handler resets the field to the stale empty value. The popup avoids this through VE2.

2. **`#654`, credit card on dynamic forms.** jsdom reproduces four cases against the current `performCreditCardAutofill`; each leaves the late fields empty:
   - expiry and CVV created synchronously on the number's `input` event;
   - the same fields created asynchronously;
   - the fields replaced by a re-render (writes go to detached nodes);
   - the year created late.

   Since `#718`, the popup and inline paths share this function, so the issue's "inline only" premise is stale.

## Requirements

- **FR1.** One field is written per task: write, then yield a macrotask before the next write.
- **FR2.** Every target decision is fixed at T0, before the first write. Re-detection after a write may only:
  - re-validate an already-chosen element;
  - find a field created or replaced inside the T0 root.

  `document.activeElement` is never consulted after T0.
- **FR3.** A step whose target is missing at T0 or detached later waits for its field inside the T0 root. The wait ends at an absolute deadline (T0 + `lateFieldWindowMs`, default 1000 ms). A step is "unfilled" until it has performed its own write. The field's current DOM value plays no part, so prefilled fields are overwritten as they are today.
- **FR4.** A frame has at most one active fill. Starting a new fill of any kind (LOGIN, CC, IDENTITY) supersedes the pending one. A trusted `keydown`, `pointerdown` or `paste` during the window also supersedes it. A superseded sequence never writes again.
- **FR5.** Secret reachability is bounded by the sequence.
  - Steps read `payload.<field>` when they write; they do not capture copies.
  - On exit, meaning settle, deadline, supersession or error, every step's reference is dropped (`payload.<field> = ""` for password, TOTP and CVV), and nothing in module state retains a payload.
  - A step that has not written by exit never writes.
  - JS strings are immutable, so this bounds reachability; it is not zeroization.
- **FR6.** While a sequence is active, the inline dropdown stays closed on the frame's focus events. This covers LOGIN, CC and Identity, and is in addition to the existing `autofillSuppressUntil`.
- **NF1.** The frame-scope and origin gates are unchanged: SW frame targeting, and `isFrameAllowedToFill` run once and synchronously at start, since a document's origin cannot change during the window.
- **NF2.** The detectors' fillable-type allowlists, the visibility checks and the select matching are unchanged. LOGIN custom-field and OTP targets, which have no allowlist today, gain one (C2).

## Contracts

### C1: sequential writer (`extension/src/content/fill-sequence-lib.ts`, new)

```ts
type FillTarget = HTMLInputElement | HTMLSelectElement;
type FillStep = {
  key: string;
  initial: FillTarget | null;                                   // chosen at T0
  relocate?: (root: ParentNode) => FillTarget | null;           // structural lookup inside the T0 root; no focus input
  accepts: (el: FillTarget) => boolean;                         // type allowlist + visibility + usable
  write: (el: FillTarget) => void;                              // existing setInputValue / setSelectValue; reads payload lazily
  release: () => void;                                          // drops the payload reference for this step
};
function runFillSequence(root: ParentNode, steps: FillStep[], opts?: { lateFieldWindowMs?: number }): Promise<void>;
function isFillActive(): boolean;
```

- **Order and yield.** Steps run in order, with a `setTimeout(0)` yield between writes.
- **Target resolution.** A step's target is its `initial` element while that element is connected and `accepts` it. Otherwise it is `relocate(root)`, but only when the result lies inside `root`, `accepts` it, and has not been written by an earlier step of this sequence.
- **Waiting for late fields.** A step without a target is retried when the DOM mutates. The MutationObserver is created only when `document.body` exists, observes `childList`, `attributes` (`disabled`, `readonly`, `hidden`, `style`, `class`) and `subtree`, and runs until the absolute deadline.
- **Write check.** Immediately before each write, in the same synchronous task, check: same generation, before the deadline, `isConnected`, and `accepts(el)`.
- **Generation.** The generation is module-scoped per frame. A new run increments it. The trusted user-input listeners are active for a run's lifetime, and an event increments the generation.
- **Exit** (settle, deadline, stale generation, or thrown error):
  - disconnect the observer, clear timers, remove the listeners;
  - call every step's `release` exactly once;
  - on error, log a fixed code through the existing extension logger, never a value.
- `isFillActive()` is true from the start of a run until its exit.
- Control class: behaviour, not a guard.

### C1a: T0 roots and initial targets

- **LOGIN.** The current decision logic (hint, focused field, form scope, custom-field reservation, password, OTP) runs once at T0 and produces each step's `initial`. The root is the `scopeForm`, or the `document` when there is no form. Today's page-wide password search is kept only for T0.
  - `relocate` for the password, when the root is the document: the same "last visible usable `type=password`" predicate, limited to the subtree of the nearest common ancestor of the T0 identifier fields. If there are no such fields, there is no relocation.
  - `relocate` for username, custom fields and OTP: the same attribute match (id, name, autocomplete) inside the root.
- **CC.** `detectCreditCardFields` runs at T0. The root is the card-number field's form, or else the existing co-location container (`isCoLocatedWith`). `relocate` for each step re-runs `detectCreditCardFields(root)` and picks its field.
- **Identity.** As CC, rooted at the first detected identity field's form or co-location container.
- **Re-anchoring.** When the T0 root is detached, the new root is the form that now contains the already-written anchor (the card number, or the first written identifier field), if it is connected. Otherwise every remaining step goes unfilled.

### C2: LOGIN (`autofill-lib.ts` `performAutofill` becomes `async`)

- Steps, in order: custom fields, username, password, TOTP (split or single).
- `isFrameAllowedToFill` runs first, synchronously; a fail returns with no steps.
- Custom-field and OTP `accepts`: type text, email, tel or number; visible; usable. Password `accepts`: `type=password`, visible, usable. Username `accepts`: the current predicate.
- The listener invokes the function without awaiting it, as today.

### C3: credit card (`autofill-cc-lib.ts`)

- Steps, in order: name, number, expiry (combined or month and year), CVV.
- A step whose payload value is empty is not created; this keeps the `#730` combined-expiry guard.

### C4: identity (`autofill-identity-lib.ts`)

The same conversion as C3.

### C5: LOGIN fallback delivery (`background/index.ts`)

- When `sendFillMessage` throws, inject `src/content/form-detector.js` into `executeTarget` and retry the message, as the CC and Identity paths do.
- Delete the inline `func` writer `injectDirectAutofill` and its serialized arguments.
- Frame targeting is unchanged.

### C6: dropdown suppression (`form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`)

- Each focus handler returns early while `isFillActive()` is true.

## Forbidden patterns

- `pattern: \bsetTimeout\(` in `autofill-lib.ts`, `autofill-cc-lib.ts` or `autofill-identity-lib.ts` — reason: delays belong to C1 only.
- `pattern: allFrames:\s*true` in new code — reason: frame scope (NF1).
- `pattern: activeElement` in `fill-sequence-lib.ts` — reason: FR2.
- `pattern: injectDirectAutofill` anywhere — reason: C5 removes the second writer.

## Testing strategy

- **LOGIN React reproduction (P7).**
  - Mount with @testing-library/react: a React-controlled password field whose `onBlur` resets from state, plus two custom-field inputs.
  - Drive the writes by calling the real `performAutofill` (and, for the pre-fix red, the old synchronous order), which dispatches raw native events. Neither path goes through `act()` or `fireEvent`.
  - Red on the current code; green after the fix.
  - Precondition asserted in the test: the pre-fix order loses the password. This proves the harness reproduces the race and is not vacuous.
- **`fill-sequence-lib.test.ts`.**
  - ordering and the yield;
  - late-field retry;
  - the absolute deadline: a mutation after the deadline does not write;
  - an element written at most once;
  - a `relocate` outside the root is rejected;
  - a re-anchored root;
  - supersession by a new run, including across kinds (a pending LOGIN password step, then a CC run starting: the masked CVV never receives the password);
  - supersession by a trusted input event;
  - `release` called exactly once on every exit path, including a thrown error;
  - `isFillActive`.
- **CC (`#654`) rows:**
  - created synchronously; created asynchronously; replaced; the year late;
  - rapid re-selection, where the second card's values win;
  - CVV reference dropped at write and at exit.
- **LOGIN rows:**
  - a focused non-custom username plus custom fields;
  - re-selection supersession;
  - custom field and OTP rejected when hidden or of a non-allowlisted type.
- **Identity:** one late-field row and one supersession row.
- **Deny side:**
  - a page that reveals a CSS-hidden password decoy outside the root after the username write does not receive the password;
  - a CC autocomplete field inserted outside the root does not receive the CVV.
- **Background:** the LOGIN fallback injects `form-detector.js` and retries. No `func` injection remains.
- **Detectors:** the dropdown does not reopen while `isFillActive()` is true.
- **Determinism:**
  - each public fill accepts an optional `lateFieldWindowMs`, so tests use small windows;
  - window-end rows: trigger the mutation, flush microtasks, then `await vi.advanceTimersByTimeAsync(window)`;
  - every test awaits settlement, and `afterEach` disconnects, resets the generation and restores real timers (shuffle is on).
- **Existing tests:** synchronous assertions become `await perform…()`. No assertion is weakened.
- **Red proof:** each new row fails on the current code. C1's yield, deadline, generation, root confinement, write-once rule and `release` are each mutation-proven on a scratch copy.
- **Live probe (VE1):** run before and after, by hand.

## Considerations & constraints

### Scope contract

- **SC1:** the inline detector's MutationObserver watches `childList` only, so dropdown display misses attribute-only changes. This is display-side. Follow-up issue filed when the PR opens.
- **SC2:** the toolbar-popup vs inline focus difference (VE2) is a browser property and is not changed.
- **SC3:** fill delivery is pinned to `frameId` rather than `documentId`, and the top frame skips `allowedHosts`. This plan does not widen either. Pinning to `documentId` needs `sender.documentId` on the content path and `webNavigation` (a permission change) on the popup path. Follow-up issue.
- **SC4:** LOGIN password detection does not exclude a field the CC detector claims as a masked CVV on a page holding both forms. This is pre-existing. FR4 closes the concurrent case; the static overlap is a follow-up issue.

### Risks

- R1: the fill becomes async for every site. Mitigation: one task yield per field, and the window applies only to steps without a target.
- R2: deleting the inline LOGIN fallback loses the fill on a frame where `executeScript` works but runtime messaging does not, even after the bundle is injected. CC and Identity already run without that path. The probe and tests cover the injected retry.

## User operation scenarios

1. **Sony Bank:** pick the entry from the inline dropdown on 店番号. 店番号, 口座番号 and the password are filled and stay filled.
2. **Card form that reveals expiry and CVV after the number:** one pick fills everything.
3. **Pick card A, then card B at once, or start typing:** A stops before its next write, and its references are dropped.
4. **A page that reveals a hidden password field elsewhere after the username is written:** that field is never filled.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Sequential writer: yield, absolute deadline, one generation per frame, user-input supersession, release on exit | pending |
| C1a | T0-fixed targets and roots; confined relocation; write-once | pending |
| C2 | LOGIN via C1, password after identifiers, custom-field/OTP allowlist | pending |
| C3 | Credit card via C1 | pending |
| C4 | Identity via C1 | pending |
| C5 | LOGIN fallback injects the bundle and retries; inline writer deleted | pending |
| C6 | Dropdown suppressed while a fill is active | pending |
