# Plan: sequential autofill writes with fixed targets (`#654` + Sony Bank login)

Revision 3 (after plan review rounds 1-2, see `autofill-sequential-fill-review.md`).

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
- **FR3.** A step whose target is missing at T0 does not block later steps. It is deferred and runs as soon as its field appears inside the T0 root. A step whose target is detached after T0 also waits. The wait ends at an absolute deadline (T0 + `lateFieldWindowMs`, default 1000 ms). A step is "unfilled" until it has performed its own write. The field's current DOM value plays no part, so prefilled fields are overwritten as they are today.
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
- **Target resolution.** A step's target is its `initial` element while that element is connected and `accepts` it. Otherwise it is `relocate(root)`. When `initial` is null, `relocate` re-runs the step's T0 predicate inside the root. A relocated result counts only when it lies inside `root` and `accepts` it. `root` is `null` when C1a refuses a root, and then a step whose initial element is gone stays unfilled.
- **Deferral.** Steps with a target at T0 run first, in order. A step with no T0 target is deferred and does not delay later steps.
- **Waiting for late fields.** A step without a target is retried when the DOM mutates. The MutationObserver is created only when `document.body` exists, observes `childList`, `attributes` (`disabled`, `readonly`, `hidden`, `style`, `class`) and `subtree`, and runs until the absolute deadline.
- **Write check.** Immediately before each write, in the same synchronous task, check:
  - same generation;
  - before the deadline;
  - `isConnected`;
  - `accepts(el)`;
  - not yet written by this sequence. Write-once applies to T0 targets too.
- **Generation.** The generation is module-scoped per frame. A new run increments it.
- **User-input supersession.** A run registers capture-phase listeners on `window` for its lifetime. A trusted `keydown`, `pointerdown` or `paste` increments the generation; a `keydown` with `repeat` is ignored. This is best-effort UX, and the page can suppress it. The cross-kind protection rests on the generation counter, which the page cannot touch.
- **Exit** (settle, deadline, stale generation, or thrown error):
  - disconnect the observer, clear timers, remove the listeners;
  - call every step's `release` exactly once. A secret shared by several steps (split OTP) is released only at exit;
  - on error, log a closed-set code through `select-diag-lib`, the only console sink the extension lint allows on the content side, never a value.
- The un-awaited `perform…()` call in each listener has a `.catch` that routes into the same sink.
- `isFillActive()` is true from the start of a run until its exit.
- Control class: behaviour, not a guard.

### C1a: T0 targets and one bounded-root rule

- **T0 targets.** Every decision is made once, at T0:
  - **LOGIN:** hint, focused field, form scope, custom-field reservation, password, OTP. Today's page-wide password search is kept for T0 only.
  - **CC:** `detectCreditCardFields(document)`.
  - **Identity:** its detector.

  The results are each step's `initial`. A null `initial` means the step is deferred (FR3).
- **Root.** One rule for all kinds: `boundedRoot(anchor, t0Targets)`, exported from `fill-sequence-lib.ts`.
  - Anchor: the LOGIN focused or hinted field, else the first identifier target, else the password; the CC number; the first identity target.
  - Candidates, in order:
    1. `anchor.form`;
    2. `anchor.closest("table")`;
    3. the nearest common ancestor of all non-null T0 targets of the sequence. With a single target, climb from it to the first ancestor that contains another fillable control (`input` or `select`).
  - Refusal: a candidate that is `body` or `documentElement` gives `null`, which means no relocation. That case cannot reopen the page-wide decoy (SEC-1).
  - Covered by this rule:
    - Sony Bank: no form, so the common ancestor of 店番号, 口座番号 and the password.
    - Div-based `#654` checkouts: the card component that contains the number and its siblings.
- **Re-anchoring.** When the root is detached, `boundedRoot` is recomputed from the already-written anchor if it is still connected. Otherwise the root is `null`.
- **Identifier set for LOGIN:** the username target plus the custom-field targets.

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

### C5: bundle path from the manifest (`background/index.ts`)

- Every `executeScript({ files })` that injects the content bundle takes its path from `chrome.runtime.getManifest().content_scripts`. That covers the CC fallback, the Identity fallback, the shortcut command, and the LOGIN retry (C7).
  - Select the entry whose `js` includes the form-detector loader, and fail closed with the existing error codes if none matches.
  - The literal `src/content/form-detector.js` does not exist in the build, so those fallbacks always fail today.
- Frame targeting is unchanged.

### C7: LOGIN fallback (`injectDirectAutofill`)

- **Delivery order:** the `AUTOFILL_FILL` message first; if it fails, inject the bundle (C5) and retry the message; if that also fails, use the existing inline `func`.
- **The inline `func` is kept.** It is the path that works today for tabs whose content script was orphaned by an extension reload.
- **Changes to its writes:**
  - It becomes `async`.
  - It writes custom fields, then username, then password, with an `await new Promise(r => setTimeout(r, 0))` between fields.
  - It gains the C2 custom-field allowlist and the visibility check.
- **The duplication is deliberate and declared** (R1). Unifying it with C2 is SC5.

### C6: dropdown suppression (`form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`)

- Each focus handler returns early while `isFillActive()` is true.

## Forbidden patterns

- `pattern: \bsetTimeout\(` in `extension/src/content/autofill-lib.ts`, `autofill-cc-lib.ts` or `autofill-identity-lib.ts` — reason: delays belong to C1 only.
- `pattern: allFrames:\s*true` in new code — reason: frame scope (NF1).
- `pattern: activeElement|findFocusedTextInput` inside any `relocate` closure or in `extension/src/content/fill-sequence-lib.ts` — reason: FR2.
- `pattern: "src/content/form-detector\.js"` in `extension/src` — reason: C5, the path does not exist in the build.

## Testing strategy

- **LOGIN React reproduction (P7).**
  - Mount with @testing-library/react through `createRoot`: a React-controlled password field whose `onBlur` resets from state, plus two custom-field inputs. The live page is React with a concurrent root (`__reactContainer$` on `#__next`, Next 16.2.6).
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
- **Background:**
  - The injected path comes from the mocked manifest (the real shape: `assets/form-detector.ts-loader-<hash>.js`) for all four callers. Red-proven against the old literal.
  - The frame-scope assertions are retargeted to the new calls, not deleted: frame-only `{tabId, frameIds:[n]}`, and popup `{tabId}` top-only.
  - LOGIN order: message, then bundle retry, then `func`.
  - The `func` writes custom fields before the password, with a yield between fields.
- **Detectors:** the dropdown does not reopen while `isFillActive()` is true. The row starts the fill directly (the popup path) after advancing past 1500 ms, so the existing `autofillSuppressUntil` cannot mask a missing check (RT7).
- **Determinism:**
  - each public fill accepts an optional `lateFieldWindowMs`, and existing tests pass `0`;
  - fake timers use `toFake: ["setTimeout", "clearTimeout", "Date", "performance"]` (the `ui/suggestion-dropdown.test.ts` precedent). `queueMicrotask` stays real, because jsdom MutationObserver callbacks are microtasks. The deadline reads `performance.now()`;
  - the React row runs on real timers, because the React scheduler uses `MessageChannel`;
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
- **SC5:** unify the LOGIN inline `func` (C7) with C2 once a manual check confirms that the bundle retry works on tabs with orphaned content scripts. Follow-up issue.
- **SC4:** LOGIN password detection does not exclude a field the CC detector claims as a masked CVV on a page holding both forms. This is pre-existing. FR4 closes the concurrent case; the static overlap is a follow-up issue.

### Risks

- R1: the fill becomes async for every site. Mitigation: one task yield per field, and the window applies only to steps without a target.
- R2: whether a bundle injected into a tab with an orphaned content script registers fresh listeners has not been verified. The `window` guard keys could block it. C7 keeps the inline `func` as the last resort for that case, and SC5 removes it only after a manual check.

## User operation scenarios

1. **Sony Bank:** pick the entry from the inline dropdown on 店番号. 店番号, 口座番号 and the password are filled and stay filled.
2. **Card form that reveals expiry and CVV after the number:** one pick fills everything.
3. **Pick card A, then card B at once, or start typing:** A stops before its next write, and its references are dropped.
4. **A page that reveals a hidden password field elsewhere after the username is written:** that field is never filled.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Sequential writer: yield, absolute deadline, one generation per frame, user-input supersession, release on exit | pending |
| C1a | T0-fixed targets; one bounded-root rule refusing body/html; deferral | pending |
| C2 | LOGIN via C1, password after identifiers, custom-field/OTP allowlist | pending |
| C3 | Credit card via C1 | pending |
| C4 | Identity via C1 | pending |
| C5 | Bundle path resolved from the manifest for all four `executeScript({files})` callers | pending |
| C7 | LOGIN fallback: message, then bundle retry, then sequential inline `func` | pending |
| C6 | Dropdown suppressed while a fill is active | pending |
