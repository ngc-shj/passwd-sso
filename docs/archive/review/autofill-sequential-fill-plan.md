# Plan: sequential, re-detecting autofill writes (`#654` + Sony Bank login)

## Project context

- Type: browser extension (MV3, CRXJS/Vite, TypeScript) inside the web app repo.
- Test infrastructure: unit (vitest + jsdom) + CI. The extension has no ESLint beyond the console gate; `tsc` + vitest are its gates.
- Verification environment constraints:
  - **VE1**: real-site behaviour (Sony Bank login, card forms) needs a real browser. `verifiable-local`: a headless Chromium (Playwright) loads the live page and runs the bundled fill function. Repro script: `docs/archive/review/autofill-sequential-fill-probe.mjs`. With the extension installed and a vault entry, the check is manual and `blocked-deferred` to the user.
  - **VE2**: popup-vs-inline focus behaviour differs only in a real browser window. Chrome does not dispatch focus or blur to a page whose window lacks focus. `blocked-deferred` (manual check by the user).

## Problem

Two reports have one cause: every fill function writes all fields in one synchronous pass, against field references detected once up front.

1. **Sony Bank login (LOGIN).** Picking the entry from the inline dropdown fills 店番号 and 口座番号 (custom fields) but leaves the password empty. The toolbar popup fills all three. Reproduced against the live page (`https://sonybank.jp/pages/db/dbca0100/input/`, headless Chromium, the real `performAutofill`):

   | Write order | Password after fill |
   |---|---|
   | password, then the custom fields, all in the same task (current) | **empty** |
   | same order, with `setTimeout(0)` between fields | kept |
   | custom fields first, password last | kept |

   - Mechanism: the page's password input is a React-controlled component. `performAutofill` writes the password, then immediately calls `focus()` on the next custom field in the same task. The password field's React `onBlur` handler then runs with state from before the password update was committed (React batches the update), so it resets the field to the stale empty value.
   - Why the popup works: the popup holds window focus, so Chrome dispatches no focus or blur events to the page and the handler never runs.
   - The page is a Next.js app; the regression follows the site's rebuild, not an extension change.

2. **`#654`, credit card on dynamic forms.** Reproduced in jsdom against the current `performCreditCardAutofill`; each case leaves the late fields empty:
   - expiry and CVV created synchronously on the number's `input` event;
   - the same fields created asynchronously (`setTimeout`);
   - existing expiry and CVV replaced by a re-render (writes go to detached nodes);
   - month present but year created late.

   The issue's premise that "only the inline path detects once" is stale. Since `#718`, popup and inline both send `AUTOFILL_CC_FILL` to the same function, and the defect hits both. The popup succeeding in the report is the VE2 focus difference.

## Requirements

- FR1: a fill writes one field per task: write, then yield a macrotask before the next field. A framework's batched state is then committed before focus moves on.
- FR2: after each write, the remaining targets are re-detected against the live DOM. A field created, replaced, enabled or revealed by an earlier write is filled, and a reference detached by a re-render is never written. LOGIN keeps its current target choice (focused or hinted field, form scope). Only the timing changes.
- FR3: fields that appear late (asynchronously after a write) are waited for, within a bounded window. Only fields whose payload value is non-empty and that are still unfilled count, judged per field: month and year separately, combined expiry, CVV.
- FR4: a newer fill of the same kind in the same frame supersedes a pending one. The older sequence stops before its next write and never writes a value after the newer fill started.
- FR5: secret lifetime does not grow beyond the fill:
  - the CVV is wiped from the payload as soon as it is written, or when the window ends or the fill is superseded, whichever is first;
  - the password and TOTP are written and released the same way;
  - no secret is kept in module-level state after the fill settles.
- NF1: frame-scope and origin gates (`isFrameAllowedToFill`, SW frame targeting) are unchanged.
- NF2: the fillable-type allowlists, visibility checks and select matching are unchanged.

## Contracts

### C1: one sequential writer (`extension/src/content/fill-sequence-lib.ts`, new)

```ts
type FillStep = {
  key: string;                                                 // e.g. "cc.number", "login.password"
  resolve: () => HTMLInputElement | HTMLSelectElement | null;  // re-detects against the live DOM
  write: (el: HTMLInputElement | HTMLSelectElement) => void;   // existing setInputValue / setSelectValue
  onDone?: () => void;                                         // e.g. wipe payload.cvv
};
function runFillSequence(kind: FillKind, steps: FillStep[], opts?: { lateFieldWindowMs?: number }): Promise<void>;
```

- **Order.** Steps run in order, and a macrotask yield (`setTimeout(0)`) separates writes.
- **Late fields.** A step whose `resolve()` returns null is retried after later steps. Retries are driven by DOM mutations (a MutationObserver on `childList`, `attributes` [`disabled`, `readonly`, `hidden`, `style`, `class`] and `subtree`) until `lateFieldWindowMs` (default 1000 ms) ends. The observer is disconnected on completion.
- **Supersession.** A per-`kind` generation counter in module scope: a new run increments it. A run checks it before every write and exits, running every pending `onDone`, when it is stale.
- **Cleanup.** `onDone` runs exactly once per step: after the write, or at exit for steps never written (window end, supersession, error).
- **Control class:** none; this is behaviour, not a guard.
- **Consumers:** C2, C3 and C4 only.

### C2: LOGIN (`autofill-lib.ts` `performAutofill` becomes `async`)

- Target selection keeps its logic: hint, focused field, form scope, custom-field reservation, TOTP split or single. Each target becomes a step whose `resolve()` re-runs the same predicate on the live DOM.
- **Order:** custom fields, username, password, TOTP. Writing the password after the visible identifier fields means no programmatic focus leaves the password before a following yield, which is belt and braces with FR1.
- The `isFrameAllowedToFill` gate still runs first and synchronously.
- The listener calls it and does not await, as today: there is no response channel.

### C3: credit card (`autofill-cc-lib.ts` `performCreditCardAutofill` becomes `async`)

- Order: name, number, expiry (combined or month and year), CVV.
- Each `resolve()` calls `detectCreditCardFields(document)` again and picks its field.
- A step is skipped when its payload value is empty, for example the combined-expiry guard from `#730`.
- The CVV step's `onDone` sets `payload.cvv = ""` (FR5).

### C4: identity (`autofill-identity-lib.ts` `performIdentityAutofill` becomes `async`)

The same conversion as C2 and C3. It is the same class: a synchronous multi-field write. No dynamic-field cases are known, but the writer is shared.

## Forbidden patterns

- `pattern: \bsetTimeout\([^,]+,\s*[1-9]` inside the three fill libs — reason: delays belong to C1 only.
- `pattern: allFrames:\s*true` in new code — reason: frame scope (NF1).

## Testing strategy

- **React reproduction (LOGIN).** A jsdom test renders a React-controlled password component whose `onBlur` resets from state (the Sony Bank shape) plus two custom-field inputs. Its rows:
  - the current synchronous order loses the password (red before the fix);
  - after the fix, all three values hold after `await` and after a later blur.

  React and ReactDOM are already extension dependencies (popup).
- **`#654` rows (CC):** created synchronously; created asynchronously; replaced; month present with the year late; rapid re-selection (the second card's values win, nothing from the first run after it starts); and a CVV wiped at write time and at window end.
- **Identity:** one late-field row and one supersession row.
- **Existing tests:** synchronous assertions are updated to `await perform…()`. No assertion is weakened.
- **Live probe (VE1):** the committed probe script reproduces the Sony Bank result table against the bundled pre-fix and post-fix functions.
- **Red proof:** each new row fails on the current code, and C1's yield, supersession and `onDone` are each red-proven by a mutation on a scratch copy.

## Considerations & constraints

### Scope contract

- **SC1:** the inline detector's MutationObserver for the dropdown (`childList` only), from the "also" note in `#654`. It is display-side, not fill-side. A follow-up issue is filed when the PR opens.
- **SC2:** the toolbar-popup vs inline focus difference (VE2). It is a browser property and is not changed.

### Risks

- R1: making the fill async changes timing for every site. Mitigation: one task yield per field (a few ms in total), and the bounded window applies only to unfilled targets.
- R2: a site that moves focus or validates on blur between our writes. The yield is what lets such a site's state settle, and the order puts the password after the identifiers.

## User operation scenarios

1. Sony Bank: pick the entry from the inline dropdown on 店番号. 店番号, 口座番号 and the password are all filled and stay filled.
2. A card form that reveals expiry and CVV after the number: one dropdown pick fills everything.
3. Pick card A, then immediately card B: only B's values remain, and A's CVV is wiped.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Sequential writer with re-detection, late-field window, supersession, cleanup | pending |
| C2 | LOGIN via C1, password after identifiers | pending |
| C3 | Credit card via C1, CVV wiped on write or exit | pending |
| C4 | Identity via C1 | pending |
