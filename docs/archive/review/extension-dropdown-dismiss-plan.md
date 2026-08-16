# Plan: extension-dropdown-dismiss

Fix the browser extension's inline suggestion dropdown so its three message-only
states (no matches / vault locked / disconnected) can be dismissed: ESC must work,
and the message must auto-dismiss after 5 s.

## Project context

- **Type**: web app (browser extension sub-package, `extension/`)
- **Test infrastructure**: unit + integration (vitest, jsdom environment) + CI/CD
  (`npx vitest run` and `npx next build` are the repo's mandatory gates; the
  extension has its own vitest suite under `extension/src/__tests__/`)
- **Verification environment constraints**:
  - **VC1 — Real-browser inline-autofill behavior is not exercisable in CI.**
    The suggestion dropdown lives in a content script inside a closed Shadow DOM,
    injected into third-party pages. There is no Playwright/Puppeteer harness in
    this repo for the extension, and no headless-Chrome extension-loading job in
    CI. Classification of each contract's manual-test path is recorded per
    contract below; paths that need a real browser are `blocked-deferred` for
    automation and covered by the **manual test plan** (§Manual test plan), which
    is executable by the developer locally.
  - **VC2 — Closed Shadow DOM is unreachable from test code.** `shadow-host.ts:20`
    attaches with `mode: "closed"`, so a test cannot query rendered text or class
    names from outside the module. Assertions must therefore be made on the
    module's exported observable surface (`isDropdownVisible()`, the `onDismiss`
    callback, the return value of `handleDropdownKeydown`) rather than on DOM
    content. This is a real limit on the shape of the tests, not on their power:
    every contract below is stated in terms of that observable surface precisely
    so it stays `verifiable-CI`. **Not deferred.**
  - **VC3 — `chrome.action.openPopup()` gesture constraints are unmeasured.**
    Whether a content-script-originated click can open the extension popup via a
    background relay has not been probed in this environment. This is the sole
    reason the click-to-unlock affordance is scoped out (see `SC1`), not deferred
    silently. **Cost-justification recorded at `SC1`.**

## Objective

The three message-only dropdown states currently persist on screen until the user
clicks elsewhere, blurs the field, or navigates. They obscure page content directly
beneath the focused input, and the ESC key — the reflex every user reaches for — does
nothing. Make them dismissible by ESC and self-dismissing after 5 s.

## Citation baseline

**Every `file:line` reference in this plan is against `main` (pre-implementation).**
The plan was written before the fix existed, and the fix moves the very lines it
cites — `suggestion-dropdown.ts:174`, the guard this document is about, is now a
different statement. Resolve citations with
`git show main:extension/src/content/ui/suggestion-dropdown.ts`, not against HEAD.
The deviation log cites post-implementation lines and says so at its own head.

## Problem statement (root cause, verified in source)

`extension/src/content/ui/suggestion-dropdown.ts:174`:

```ts
export function handleDropdownKeydown(e: KeyboardEvent): boolean {
  if (!currentDropdown || itemElements.length === 0) return false;
```

`itemElements` is populated **only** in the `else` branch that renders real entries
(lines 88, 124). In all three message states — `disconnected` (67-71), `vaultLocked`
(72-76), `entries.length === 0` (77-81) — `itemElements` is `[]`, so the guard
returns `false` before control ever reaches `case "Escape"` at line 209.

**ESC is therefore a no-op in exactly the three states the user reported, and only
in those states.** The guard was written to protect the *navigation* cases
(ArrowDown/ArrowUp/Enter index into `itemElements`), and Escape was swallowed as
collateral. This is the whole bug for the ESC half.

For the auto-dismiss half: `showDropdown()` registers no timer. Sibling overlays in
the same codebase do — `save-banner.ts:11` (`AUTO_DISMISS_MS = 15 * MS_PER_SECOND`,
armed at `:84-87`) and `form-detector-lib.ts:460-464` (inline notice, 2200 ms) — so
an auto-dismiss timer is the established idiom here, not a new invention.

### Why the existing test suite did not catch it

`extension/src/__tests__/content/ui/suggestion-dropdown.test.ts:125-132` has a test
named `dismisses with Escape` that passes. It uses the default `makeOptions()`
fixture, which supplies **two entries** — so it exercises the item-rendering path,
where `itemElements.length === 2` and the guard does not fire. The message-only
states have no ESC test at all, and the `disconnected` branch has no test of any
kind. See `RT10` in §Recurring-rule notes.

## Requirements

### Functional

- **FR1** — ESC dismisses the dropdown in all four render states (the three message
  states plus the entries state), not only the entries state.
- **FR2** — The three message-only states auto-dismiss after 5000 ms.
- **FR3** — The entries state does **not** auto-dismiss (a timer that fires while
  the user is choosing a credential would be a regression). Confirmed as the
  user's explicit choice.
- **FR4** — Auto-dismiss runs the same teardown as every other dismissal path:
  the outside-click listener is removed, shadow-root children are removed, and the
  `onDismiss` callback fires so each detector clears its per-detector state
  (`currentContext` for LOGIN; `activeInput` for CC and IDENTITY — see C3
  Consumers 4a/4b). All four clauses are pinned: the first by T13, the rest by
  T8/T11/T12.
- **FR5** — Re-showing the dropdown (a new `showDropdown()` call) cancels any timer
  from the previous invocation. No orphaned timer may fire against a later dropdown.
- **FR6** — The fix applies to all three detectors (LOGIN, CREDIT_CARD, IDENTITY)
  without per-detector changes, since all three call the same singleton.

#### FR6 member-set derivation (R42)

FR6 is universally quantified ("**all** detectors are covered by the singleton fix"),
so the member set is code-derived rather than asserted. Commands and output, run from
`extension/`:

```console
$ grep -rn 'showDropdown(' src --include='*.ts' --include='*.tsx' | grep -v '__tests__'
src/content/identity-form-detector-lib.ts:421
src/content/cc-form-detector-lib.ts:375
src/content/form-detector-lib.ts:377
src/content/ui/suggestion-dropdown.ts:53          ← the definition itself

$ grep -rn 'handleDropdownKeydown' src --include='*.ts' | grep -v '__tests__'
src/content/form-detector-lib.ts:15 (import), :526 (call)
src/content/cc-form-detector-lib.ts:25 (import), :440 (call)
src/content/identity-form-detector-lib.ts:26 (import), :484 (call)
src/content/ui/suggestion-dropdown.ts:173         ← the definition itself
```

Member set = exactly the three detectors named in FR6. **No fourth consumer exists**,
so the set the fix reaches equals the set the requirement quantifies over. Recomputed
at plan time; Phase 3 must re-run both greps rather than carry these results forward.

**Indirect members**: `hideDropdown` has 18 call sites outside its own module (6 in
each detector). C2's timer-clearing therefore also runs on every one of those paths —
blur, SPA navigation, successful fill, unsafe-page detection, teardown. That is the
intended behavior (any dismissal cancels the timer, per I2.2) and requires no
per-call-site change, but it is recorded here because it is the widest blast radius in
the change and a reviewer should confirm it rather than infer it.

### Non-functional

- **NFR1** — No change to the plain-JS / `-lib.ts` mirroring contract.
  `suggestion-dropdown.ts` is a plain TS module under the CRXJS-bundled entry
  (`src/content/form-detector.ts`, declared in `manifest.config.ts:63-70`), **not**
  a `web_accessible_resources` file. The plain-JS restriction that governs
  `token-bridge.js` / `webauthn-interceptor.js` does not apply, so no `.js` mirror
  and no sync test are involved. Verified against `manifest.config.ts:71-76`.
- **NFR2** — No new i18n keys. The strings already exist
  (`contentScript.vaultLocked`, `.disconnected`, `.noMatches`, `.noCreditCards`,
  `.noIdentities` in `src/messages/{en,ja}.json`).
- **NFR3** — The `Enter`-key trusted-event guard (`suggestion-dropdown.ts:192`)
  must remain in force and must not be weakened by the guard restructuring. This is
  a credential-disclosure control; see `C2` and §Recurring-rule notes `R43`/`R52`.

## Technical approach

Two changes, both confined to
`extension/src/content/ui/suggestion-dropdown.ts`. No detector file changes, no
style changes, no message-file changes.

### 1. Narrow the keydown guard so Escape is always reachable

Split the single early-return into a dropdown-presence check (which Escape needs)
and a per-case item-list check (which only the navigation cases need). Escape moves
above the item-list requirement; `ArrowDown`/`ArrowUp`/`Enter` keep theirs.

**Why not simply drop `itemElements.length === 0` from the guard?** Because
`ArrowDown` on an empty list would then call `setActiveItem(0)` and `Enter` would
index `itemElements[activeIndex]` on an empty array. The correct shape is per-case,
not a relaxed global guard.

**Return-value semantics.** `handleDropdownKeydown` returns a boolean meaning
"handled — the caller may stop". Escape in a message state returns `true` (it *did*
handle it). The navigation keys in a message state return `false`, unchanged from
today. The three detector call sites
(`form-detector-lib.ts:523-528`, `cc-form-detector-lib.ts:437-442`,
`identity-form-detector-lib.ts:481-486`) ignore the return value entirely —
they call it for effect — so no caller behavior changes. Verified by reading all
three call sites.

### 2. Add a 5 s auto-dismiss timer for message-only states

A module-level timer handle alongside the existing module state
(`currentDropdown`, `itemElements`, `outsideClickHandler`, …), armed in
`showDropdown()` only on the message-only branches, and cleared unconditionally in
`hideDropdown()`.

Arming it in the three message branches rather than gating on
`itemElements.length === 0` after the fact keeps the condition co-located with the
branch that decides it, so a future fourth message state cannot silently miss the
timer by forgetting to update a separate predicate.

**Timer handle idiom.** The repo has two: `form-detector-lib.ts:460` uses
`window.setTimeout` with a `number | null` handle, while `save-banner.ts:24/84/92`
uses bare `setTimeout` with `ReturnType<typeof setTimeout>` — the type-agnostic form
that sidesteps the DOM-vs-Node overload question entirely rather than resolving it.
**Follow `save-banner.ts`**, since this change is an auto-dismiss timer and
`save-banner.ts` is the auto-dismiss sibling; matching the surrounding idiom of the
thing being imitated beats matching a different file's. Both behave identically
under fake timers. (The first revision argued for `window.setTimeout` on the grounds
of "matching the sibling", while citing the sibling that does the opposite — the
conclusion was defensible but the reason was false, so it is corrected rather than
carried.)

**Timer clearing is unconditional in `hideDropdown()`, and must happen before
control can leave the function.** Two separate requirements, often conflated:

1. *Unconditional* — not nested inside `if (currentDropdown)`, mirroring how
   `outsideClickHandler` is already cleared at lines 147-150. `showDropdown()` opens
   with `hideDropdown()` (line 54); that is the mechanism satisfying FR5, and it only
   works if clearing does not depend on `currentDropdown` being non-null.
2. *Before any exit from the function* — and the exit that matters is **not** the end
   of the `if (currentDropdown)` block. `hideDropdown()` ends by invoking the
   detector-supplied dismiss callback **synchronously**, at lines 161-165:

   ```ts
   if (currentOnDismiss) {
     const fn = currentOnDismiss;
     currentOnDismiss = null;
     fn();          // ← re-entrant call site: arbitrary detector code runs here
   }
   ```

   `fn()` is a re-entrancy point. All three current callbacks are inert (LOGIN sets
   `currentContext = null`; CC and IDENTITY set `activeInput = null`), so placing the
   clear anywhere above line 161 is correct **today**. But "above the
   `currentDropdown` block" is the wrong landmark to write into an invariant: it is
   correct by accident, and the reason is what licenses the next edit. If any future
   `onDismiss` synchronously calls `showDropdown` — a re-show-on-dismiss, which is the
   synchronous analogue of what scenario 5 already does asynchronously via
   `PSSO_VAULT_STATE_CHANGED` → `requestMatches` — then a clear that ran before
   `fn()` would not cancel the timer `fn()` just armed. The orphan would then dismiss
   a *later* dropdown, and because the singleton serves the entries state too, that
   could be a candidate list the user is mid-selection on: FR3's prohibited outcome
   reached by a different route.

   **Therefore the invariant binds to `fn()`, not to the `currentDropdown` block**,
   and `showDropdown` must arm the new timer only after its opening `hideDropdown()`
   has fully returned (line 54's position already gives this).

### Interaction analysis (why 5 s does not thrash)

The dropdown is re-opened by `focusin` (`form-detector-lib.ts:637`, and the
identical wiring at `cc:471` / `identity:514`), **not** by `input`. I verified there
is no `input`-event listener in any of the three detectors. Consequences:

- A user who dismisses the message and keeps typing in the same field does **not**
  see it return — no refocus occurs. This is the dominant scenario in the user's
  complaint and it behaves correctly.
- A user who clicks away and clicks back into the field **does** see it again. That
  is correct: a fresh focus is a fresh request for suggestions.
- The 150 ms blur debounce (`form-detector-lib.ts:510-518`) and the auto-dismiss
  timer cannot conflict — both funnel through `hideDropdown()`, which is idempotent
  (`isDropdownVisible()` → `false`, second call is a documented no-op tested at
  `suggestion-dropdown.test.ts:100`).
- `autofillSuppressUntil` (1500 ms) is unrelated: it suppresses re-open after a
  *successful fill*, a path that cannot coexist with a message-only state.

### Timer value

5000 ms, per the user's decision. Position among the repo's existing dismissal
timings: inline notice 2200 ms (`form-detector-lib.ts:460-464`) < **5000 ms** < save
banner 15000 ms (`AUTO_DISMISS_MS`, `save-banner.ts:11`).

**The constant is `export`ed**, and the tests import it and compute the boundary as
`CONSTANT` and `CONSTANT - 1` rather than hardcoding `5000` / `4999` (`RT3` — a
hardcoded literal decouples the assertion from the shipped value the moment anyone
changes it, leaving the test pinning a number nobody ships). Exporting it is a new
production export, so under `RT6` it must arrive with the test that consumes it —
which T8/T9 are.

## Contracts

### C1 — `handleDropdownKeydown` dismisses on Escape in every render state

- **Signature** (unchanged): `handleDropdownKeydown(e: KeyboardEvent): boolean`
- **Control class**: **fail-closed verification gate**, for the part of this
  function that gates credential disclosure (the `Enter` case). The Escape case
  carries no security predicate — it is pure UI dismissal. The declaration matters
  because C1 *restructures the guard that the `Enter` control sits behind*, and a
  reader must not infer that loosening the outer guard loosened the `Enter` gate.
  **Adjudication authority** for the `Enter` predicate: the browser's own
  `Event.isTrusted` flag — an interpreter-supplied fact, not a surface-form
  heuristic. Unchanged by this contract.
- **Invariants**:
  - **I1.1** (app-enforced): `ArrowDown`, `ArrowUp`, and `Enter` never index
    `itemElements` when it is empty. *Schema-enforced equivalent: none available —
    this is control flow inside one function, which no type system in this stack
    expresses. Stated per the plan's obligation to justify app-enforced choices.*
  - **I1.2** (app-enforced): the `!e.isTrusted → return false` check on the `Enter`
    path is preserved verbatim in position and effect. This is `NFR3`.
  - **I1.3** (app-enforced): when `currentDropdown` is `null`, every key including
    Escape returns `false`. Escape becoming reachable must not make it reachable
    with no dropdown on screen.
  - **I1.4** (app-enforced): the `Escape` case denies untrusted events — an event
    with `e.isTrusted === false` returns `false` **without** calling
    `e.preventDefault()` and **without** calling `hideDropdown()`. See the rationale
    immediately below; this invariant is added by review, not present in the first
    revision.
- **Forbidden patterns**:
  - `pattern: if (!currentDropdown || itemElements.length === 0) return false;` —
    reason: this exact line is the bug; its survival in the diff means the fix was
    not applied.
  - `pattern: case "Enter"` appearing without an `isTrusted` check within the same
    case block — reason: `NFR3`; a restructure that drops the disclosure guard is a
    security regression, not a UI fix.
- **Acceptance criteria**:
  - Escape returns `true` and `isDropdownVisible()` becomes `false` for each of:
    `{disconnected: true}`, `{vaultLocked: true}`, `{entries: []}`, and the
    two-entry default fixture.
  - `ArrowDown` returns `false` in all three message states (nothing to navigate).
  - Untrusted `Enter` still returns `false` and still does not invoke `onSelect`,
    in the entries state.
  - With no dropdown shown, Escape returns `false`.
  - **Untrusted Escape returns `false`, leaves the dropdown visible, and leaves
    `e.defaultPrevented === false`** — in every one of the four render states (I1.4).
  - `ArrowDown` in a message state leaves `e.defaultPrevented === false`. Asserting
    only the `false` return cannot distinguish "fell through untouched" from "handled,
    then returned false" — and the latter would violate I1.1 while passing.
- **Why Escape must deny untrusted events (I1.4).** Today the `:174` guard makes the
  `Escape` case unreachable in message states, so this exposure is *created by C1*,
  not pre-existing there. Once reachable, `case "Escape"` calls `e.preventDefault()`
  unconditionally and has no `isTrusted` check — unlike the `Enter` case (`:192`) and
  the mouse path (`isSafeSelectClick`, `:45-51`), both of which already deny
  untrusted input. Two consequences, both measured:
  - A page script can `document.dispatchEvent(new KeyboardEvent("keydown", {key:
    "Escape", cancelable: true}))`. The detector keydown handlers are registered on
    `document` in capture phase, so it reaches them. That hands a hostile page a
    reliable **suppression primitive** for the locked / no-match indicators — the
    user's only in-page signal distinguishing a real dropdown from a page overlay
    impersonating the password manager.
  - The page dispatches its own event object, so it can read `e.defaultPrevented`
    after `dispatchEvent` returns. **Probed and confirmed**: a `preventDefault()` in
    a capture-phase listener is visible to the dispatcher, and synthetic
    `KeyboardEvent`s carry `isTrusted === false`. Since C2 arms the timer only on
    message branches and never on the entries branch, the page gets a state oracle:
    dispatch, read `defaultPrevented`, learn *extension installed and vault
    locked / no matches* versus *entries present*. For a password manager that is a
    fingerprinting and vault-state channel.

  The fix is one line and makes Escape consistent with the module's two existing
  trust boundaries. It is deliberately **partial**: a page can still blur the input
  to suppress the dropdown, and other presence inferences remain. The value is
  consistency — leaving Escape as the single untrusted-reachable branch is the
  anomaly, and the alternative to fixing it is an explicit written decision, not
  silence.

  *Boundary and tie*: `e.isTrusted` is a browser-supplied boolean with no equality
  edge — `true` dismisses, `false` returns `false` unhandled.

- **Test-construction consequence**: T1-T4 must use the `trustedKeydown()` Proxy
  helper already at `suggestion-dropdown.test.ts:136-145`, **not** a bare
  `new KeyboardEvent` (which is untrusted and would now be denied). The helper must
  additionally assert `e.isTrusted === true` before returning, so that if a future
  jsdom breaks the Proxy workaround the tests go red rather than silently exercising
  the untrusted path — "examined nothing" must not read the same as "found nothing".

- **Manual-test classification**: `verifiable-CI`. Every criterion is expressible
  against the module's exported surface under jsdom; VC2 does not block it.

### C2 — Message-only states auto-dismiss after 5000 ms; the entries state does not

- **Signature** (module-internal): a module-level timer handle
  `number | null`, and a named constant for the interval.
- **Control class**: **detection or audit only** — no denial. This is a UI
  convenience timer; nothing security-relevant is gated on it firing or not firing.
  Declared explicitly so no later contract leans on it as a boundary (`R49`).
- **Invariants**:
  - **I2.1** (app-enforced): the timer is armed **iff** the rendered state is one
    of the three message-only branches. The entries branch never arms it (`FR3`).
  - **I2.2** (app-enforced): `hideDropdown()` clears the timer **unconditionally**
    (not nested in `if (currentDropdown)`) and **before invoking `currentOnDismiss`**
    at `suggestion-dropdown.ts:161-165`. The binding landmark is the `fn()`
    re-entrancy point, *not* the `currentDropdown` block: `fn()` runs
    detector-supplied code synchronously, and a callback that re-shows the dropdown
    would arm a timer that a clear placed earlier in the function has already passed.
    Correspondingly, `showDropdown` arms its timer only after its opening
    `hideDropdown()` (line 54) has returned. Together these satisfy `FR5`.
  - **I2.3** (app-enforced): the timer's callback dismisses via `hideDropdown()`
    and by no other path, so teardown, listener removal, and `onDismiss` are
    identical to every other dismissal (`FR4`). No duplicated teardown logic.
- **Forbidden patterns**:
  - `pattern: setTimeout(` inside `showDropdown` that is not the auto-dismiss arm —
    reason: only one timer belongs in this function; a second is a lifecycle leak.
  - `pattern: currentDropdown = null` inside the timer callback — reason: the
    callback must delegate to `hideDropdown()`, not hand-roll teardown (I2.3).
- **Acceptance criteria**:
  - Under fake timers, advancing 5000 ms from a `{vaultLocked: true}` /
    `{disconnected: true}` / `{entries: []}` show ⇒ `isDropdownVisible() === false`
    **and** `onDismiss` called exactly once.
  - Advancing 4999 ms ⇒ still visible. (Pins the boundary; without it the test
    passes for any timer ≤ 5000 ms, including 0.)
  - Advancing 5000 ms from the two-entry default fixture ⇒ still visible,
    `onDismiss` not called (`FR3`).
  - `showDropdown(message)` → `showDropdown(message)` → advance 5000 ms ⇒ exactly
    one further `onDismiss` beyond the one the second `showDropdown`'s internal
    `hideDropdown()` already fired for the first dropdown. Pins `FR5`: an orphaned
    first timer would produce an extra dismissal.
  - `showDropdown(message)` → `hideDropdown()` → advance 5000 ms ⇒ no additional
    `onDismiss` (timer cleared, not merely outrun).
  - **Message → entries re-show**: `showDropdown({vaultLocked: true})` → advance
    2000 ms → `showDropdown(<two-entry fixture>)` → advance 5000 ms ⇒ still visible,
    no `onDismiss` beyond the one the second `showDropdown`'s internal
    `hideDropdown()` fired. Pins the transition where an orphaned timer would tear
    down a list the user is mid-selection on — the `FR3` regression by a different
    route. Distinct from the message→message case above.
  - **Re-entrant `onDismiss`**: an `onDismiss` that synchronously calls
    `showDropdown({vaultLocked: true})` once must leave exactly one armed timer, not
    two. Advance 5000 ms ⇒ exactly one further dismissal. Pins I2.2's binding to the
    `fn()` landmark rather than to the `currentDropdown` block.
  - **Boundary and tie**: the timer fires **at** exactly 5000 ms, not after — measured,
    see §Fake-timer hygiene. 4999 ms falls on the still-visible side. Two dropdowns
    can never share the boundary, because arming is always preceded by a clear (I2.2).
- **Manual-test classification**: `verifiable-CI` via `vi.useFakeTimers()`.
  Real-browser confirmation is `blocked-deferred` per VC1 and is covered by
  §Manual test plan M1-M3.

### C3 — Consumer-flow walkthrough

`showDropdown` / `hideDropdown` / `handleDropdownKeydown` are consumed by code
outside this module, so per the plan obligation each consumer is walked through
before the contracts lock.

- **Consumer 1 (path: `src/content/form-detector-lib.ts:523-528`, `keydownHandler`)**
  reads `{ return value of handleDropdownKeydown }` and uses it for **nothing** —
  the call is `if (isDropdownVisible()) { handleDropdownKeydown(e); }`, result
  discarded. Therefore C1's change to the return value in message states
  (`false` → `true` for Escape) is invisible to this consumer. Verified by reading
  the source.
- **Consumer 2 (path: `src/content/cc-form-detector-lib.ts:437-442`)** — identical
  shape to Consumer 1, result discarded. Same conclusion.
- **Consumer 3 (path: `src/content/identity-form-detector-lib.ts:481-486`)** —
  identical shape, result discarded. Same conclusion.
- **Consumer 4a (path: `form-detector-lib.ts:415-417`, LOGIN `onDismiss`)** reads
  `{}` — it takes no arguments — and uses the *invocation itself* to set
  `currentContext = null` (the module-level `DropdownContext | null` at `:342`). Its
  blur handler (`:510-518`) guards on `currentContext` and dereferences
  `currentContext.input`.
- **Consumer 4b (paths: `cc-form-detector-lib.ts:406-408` and
  `identity-form-detector-lib.ts:450-452`)** likewise read `{}` and use the
  invocation to set **`activeInput = null`** — a bare `HTMLInputElement | null`
  (`cc:308`, `identity:354`), *not* a `currentContext` object; neither detector has
  one. Their blur handlers guard on `activeInput` (`cc:426-435`,
  `identity:470-479`).

  **This pair is the walkthrough that constrains the design.** The shared conclusion
  holds for all three detectors despite the differing state variable: each clears its
  per-detector state *only* via `onDismiss`, so any dismissal path that bypasses
  `hideDropdown()` strands that state — pointing at an input whose dropdown no longer
  exists — and the next blur handler then acts on it. C2's timer must therefore route
  through `hideDropdown()`, which I2.3 requires. Caught here, before implementation.

  Recorded as two entries rather than one because an earlier revision asserted
  `currentContext` for all three; that rationale is false for two of the three, and a
  reader who went looking for `currentContext` in the CC detector would not find it.
- **Consumer 5 (path: `src/__tests__/content/ui/suggestion-dropdown.test.ts`,
  `suggestion-dropdown-entrytype.test.ts`)** reads `isDropdownVisible()`,
  `onDismiss`, `onSelect`, and `handleDropdownKeydown`'s return value. The existing
  `afterEach` calls `hideDropdown()` (`:61`), which under C2 also clears the timer —
  so no timer leaks across test cases. Tests that do **not** use fake timers are
  unaffected, because a real 5 s timer never elapses within a test.
- **Consumer 6 (path: `src/__tests__/content/form-detector-inline.test.ts:6-13`)**
  mocks the whole module wholesale (`showDropdown`, `hideDropdown`,
  `isDropdownVisible: () => false`, `handleDropdownKeydown: () => false`). Under that
  mock the real timer-clearing never runs. This test uses no fake timers and never
  calls the real `showDropdown`, so no timer is ever armed — no impact. Recorded so a
  reviewer does not have to rediscover it.
- **Consumer 7 (path: `src/__tests__/content/cc-identity-detector.test.ts:11-16`)**
  mocks the module the same way, and additionally reads the captured options object
  to drive `onSelect` (`:129`, `:158`) and to assert `entryType` (`:93`, `:265`) — so
  it is a genuine behavioural consumer of the option shape C2 touches, not a
  bystander. Same conclusion: real `showDropdown` never runs, no timer armed, no
  impact. **This consumer was absent from the first revision**, which enumerated six
  and asserted completeness; the code-derived set has seven.

**Member-set derivation for C3** (`R42` — the enumeration is code-derived, not
asserted):

```console
$ grep -rn -E "showDropdown|handleDropdownKeydown|hideDropdown|isDropdownVisible" src \
    --include='*.ts' --include='*.tsx' | grep -v '^src/content/ui/suggestion-dropdown.ts:'
```

yields exactly seven files: the three detectors (Consumers 1-4b) and four test files
(`suggestion-dropdown.test.ts`, `suggestion-dropdown-entrytype.test.ts`,
`form-detector-inline.test.ts`, `cc-identity-detector.test.ts` = Consumers 5-7).
Phase 3 must re-run this grep rather than carry the result forward.

**No consumer requires a field absent from the locked shape.** C1 and C2 are
complete.

## Go/No-Go Gate

| ID | Subject | Status |
| --- | --- | --- |
| C1 | Escape dismisses in every render state (trusted events only); navigation guards preserved | locked |
| C2 | 5 s auto-dismiss for message-only states; entries state exempt | locked |
| C3 | Consumer-flow walkthrough for all seven consumers | locked |

All three were revised during Round 1 and re-locked: C1 gained I1.4 (untrusted-Escape
denial), C2 gained the `fn()`-landmark restatement of I2.2 plus three new acceptance
criteria, C3 gained Consumer 7 and the 4a/4b split. Round 1 found no defect in the
change's *destination* — only in the plan's reasoning, enumeration, and test design.

## Testing strategy

All tests go in the existing
`extension/src/__tests__/content/ui/suggestion-dropdown.test.ts`. No new test file
— the module already has one and splitting would fragment the fixture.

### Fixture change required

`makeOptions()` (`:39-54`) currently has no `disconnectedMessage`. The
`disconnected` branch reads `opts.disconnectedMessage || opts.lockedMessage`
(`:70`), so it renders today via the fallback, but a test asserting the disconnected
state should supply the field explicitly to exercise the real path.

### Prove-red obligation (`RT7`) — two distinct kinds, never conflated

A test that cannot fail is worse than no test, because it reads as coverage. **This
plan's first revision fell into exactly that trap**, and it was caught by execution
rather than by reasoning: T5, T7, T9 and T10 were run against unfixed `main` and
**all four passed**, green-on-green. That is the same defect class as the shipped bug
(`:125` passing vacuously on the entries fixture). Recorded rather than quietly
corrected, because the failure mode is the plan's own subject matter.

Every new test therefore names which of two kinds of red-proof applies, and each
mutation is **run and observed separately** — one mutation per clause, never one
mutation that reddens everything.

**Kind A — red against unfixed `main`.** Genuine regression tests: the test fails
today and passes after the fix.

| Test | Why it reddens on `main` |
| --- | --- |
| T1, T2, T3 | Escape in message states — guard at `:174` returns `false`, dropdown stays visible |
| T8 | no timer exists on `main`, so nothing dismisses at 5000 ms |
| T11 | second dropdown is never auto-dismissed on `main` |
| T12 | vacuously green on `main`; **promoted to Kind B** — see below |

**Kind B — red against a named mutation of the fix.** Guard-preservation tests: they
pass on `main` *and* after the fix, so their value is that a specific wrong
implementation reddens them. Each row's mutation is mandatory, not illustrative.

| Test | Mutation that must redden it | Observed |
| --- | --- | --- |
| T4 | change the trusted-Escape path to `return false` | must fail |
| T5 | drop the per-case `itemElements.length` check from the `ArrowDown` case | must fail |
| T6 | delete the `!e.isTrusted` line from the `Enter` case | must fail |
| T7 | drop the `!currentDropdown` check from the guard | must fail |
| T9 | set the interval constant to `4999` | must fail (tie: `5000` ⇒ green) |
| T10 | arm the timer in the entries branch too | must fail |
| T12 | move the timer clear to *after* the `fn()` call at `:161-165` | must fail |
| T13 | replace the timer callback with a hand-rolled teardown (see T13) | must fail |
| T14 | move the timer clear inside the `if (currentDropdown)` block | must fail |

**Allow side (mandatory after every mutation-revert):** the full `extension/` suite
must be green — run and observed, not assumed. A remedy that only tightens is
unmeasured in the direction that gets controls switched off.

**Failing loudly:** if a red-proof cannot be executed (toolchain change, `toFake`
rejected by a future vitest), the obligation is to stop and say so — "examined
nothing" must not be recorded the same way as "found nothing".

### What T9 does and does not pin

T9 (`4999 ms ⇒ still visible`) constrains the interval **only from below**. On its
own it is satisfied by a 60-second timer, or by no timer at all — which is why it
passed on unfixed `main`. It is meaningful *only in conjunction with* T8
(`5000 ms ⇒ dismissed`), which supplies the upper bound. The pair is the boundary;
neither half is a boundary test alone. An earlier revision of this plan claimed T9
by itself "pins the boundary; without it the test passes for any timer ≤ 5000 ms,
including 0" — that is backwards, and the correction is recorded here because the
wrong belief is what licensed listing T9 without a Kind-B mutation.

### Test list

| ID | Test | Pins | Red-proof |
| --- | --- | --- | --- |
| T1 | Escape (**trusted**) dismisses when `vaultLocked: true` | C1 | A |
| T2 | Escape (**trusted**) dismisses when `disconnected: true` | C1 | A |
| T3 | Escape (**trusted**) dismisses when `entries: []` | C1 | A |
| T4 | Escape still dismisses with entries present | C1 | B |
| T5 | `ArrowDown` returns `false` **and leaves `defaultPrevented` false** in each message state | C1 / I1.1 | B |
| T6 | Untrusted `Enter` still returns `false`, `onSelect` not called | C1 / I1.2, NFR3 | B |
| T7 | Escape returns `false` when no dropdown is shown | C1 / I1.3 | B |
| T8 | 5000 ms auto-dismisses each of the three message states, `onDismiss` once | C2 | A |
| T9 | 4999 ms — still visible (**lower bound only; pairs with T8**) | C2 boundary | B |
| T10 | 5000 ms with entries present — still visible, no `onDismiss` | C2 / I2.1, FR3 | B |
| T11 | re-show cancels the prior timer — **per-mock counts**, see below | C2 / I2.2, FR5 | A |
| T12 | explicit `hideDropdown()` then 5000 ms — no extra `onDismiss` | C2 / I2.2 | B |
| T13 | auto-dismiss removes the `mousedown` listener, identically to manual dismiss | C2 / I2.3, FR4 | B |
| T14 | message → entries re-show does not tear down the entries dropdown | C2 / I2.2, FR3 | B |
| T15 | untrusted Escape is a no-op in every state (`defaultPrevented` stays false) | C1 / I1.4 | B |

T5, T6, T7, T15 are the **paired allow/deny axis coverage** for `RT10` — the rule the
existing suite violated, and the reason this bug shipped. T6 and T15 are the guards
against C1's restructure silently widening the page-reachable surface.

**T4 is not a new test.** `suggestion-dropdown.test.ts:125-132` already covers the
entries axis and already passes; the entries axis was never the untested one. T4 means
*keep `:125` unchanged and confirm it stays green post-fix* — it is the entries-axis
half of the `RT10` pair, not a second copy. Do not write a duplicate.

**T11 must assert per-mock counts, not an aggregate.** An aggregate "one further
`onDismiss`" is satisfied by the buggy implementation too: with an orphaned first
timer, the second show fires `o1.onDismiss`, then the orphan fires `hideDropdown()`
which fires `o2.onDismiss` and nulls it, then the second dropdown's own timer fires
`hideDropdown()` with `currentOnDismiss === null` and fires nothing — **aggregate
total is two either way**. The discriminator is *when*, not *how many*. Specify T11 as:
`showDropdown(o1)` → advance 3000 ms → `showDropdown(o2)` → assert `o1.onDismiss`
once and `o2.onDismiss` zero → advance 4999 ms (t=7999) → assert **still visible** and
`o2.onDismiss` zero → advance 1 ms (t=8000) → assert dismissed and `o2.onDismiss`
once. The 3000 ms gap is what separates the orphan's deadline (t=5000) from the
legitimate one (t=8000); without the gap the two coincide and the test cannot tell
them apart.

**T13 is what actually pins I2.3.** T8/T10/T11/T12 assert visibility and `onDismiss`,
both of which a hand-rolled teardown would also satisfy — so the forbidden-pattern
grep is the only thing standing between the plan and an equivalent hand-roll spelled
differently. T13 spies on `document.addEventListener`/`removeEventListener` and
asserts the auto-dismiss path removes the `mousedown` capture listener **exactly
once**, and that a direct `hideDropdown()` produces the identical call — proving the
two paths agree rather than merely that the timer path does something. This is
observable from outside the closed shadow root (it is a `document`-level listener),
so VC2 does not block it.

### Fake-timer hygiene

`vi.useFakeTimers()` in the auto-dismiss describe block only, with
`vi.useRealTimers()` in its `afterEach`, so other blocks are unaffected.

**Measured fake-timer semantics (probe, not assumption).** `showDropdown` registers
the outside-click listener inside a `requestAnimationFrame` callback (`:135-143`), so
the tests depend on how vitest treats rAF. I probed the actual toolchain rather than
reasoning about it — a throwaway spec run under this repo's vitest 4.1.10 + jsdom 29,
`@vitest-environment jsdom`, three assertions, all passing:

| Probe assertion | Result |
| --- | --- |
| rAF callback runs after `vi.advanceTimersByTime(5000)` under default `useFakeTimers()` | **true — rAF IS faked and DOES run** |
| `setTimeout(…, 5000)` fired after `advanceTimersByTime(4999)` | **false — not yet fired** |
| `setTimeout(…, 5000)` fired after `advanceTimersByTime(5000)` | **true — fires at exactly the delay** |

Vitest 4's default `toFake` set covers every timer key except `nextTick` /
`queueMicrotask`, and `requestAnimationFrame` is in it. So a bare
`vi.useFakeTimers()` puts rAF on the same fake clock as `setTimeout`, and
`advanceTimersByTime(5000)` runs the pending rAF — installing the real
`outsideClickHandler` on `document` mid-test.

**Required configuration**, therefore, for the auto-dismiss block:

```ts
vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
```

This leaves rAF real, so the outside-click registration never fires during a clock
advance and the auto-dismiss tests exercise the timer path and nothing else. Pin it:
one auto-dismiss test asserts `document.addEventListener` was **not** called with
`"mousedown"` after `advanceTimersByTime(5000)`. (T13 deliberately does the opposite
— it needs the listener installed — so T13 arranges that explicitly rather than
relying on the clock.)

Two further consequences:

1. **Boundary is exact.** T9 (`4999 ⇒ visible`) and T8 (`5000 ⇒ dismissed`) form a
   genuine pair. The tie falls on the **fire** side at equality: the timer fires *at*
   5000 ms. Two dropdowns can never share the boundary, because arming is always
   preceded by a clear (I2.2).
2. **`useRealTimers()` goes in the FILE-level `afterEach`** at
   `suggestion-dropdown.test.ts:60-63`, unconditionally and ordered *before*
   `hideDropdown()` — **not** in a describe-scoped hook. A describe-scoped
   `useRealTimers()` was measured to leak fake timers into subsequent tests when an
   auto-dismiss test *fails*, converting one real failure into a cascade across the
   other describe blocks — `RT11`, fixture outliving its own run on the failure path.
   `useRealTimers()` is a documented no-op when no fake timers are installed, so it is
   safe for the whole file. `vitest.config.ts` sets neither `restoreMocks` nor
   `unstubGlobals`, so there is no config-level safety net to fall back on.

An earlier revision asserted rAF "may not run" under fake timers and put
`useRealTimers()` in a describe-scoped hook. Both were refuted by execution. Recorded
rather than silently corrected: the first belief would have licensed tests that
unknowingly installed a live click handler, and the second would have made the first
auto-dismiss failure look like five failures.

## Manual test plan

Covers what VC1 blocks from automation. Run with `npm run dev` in `extension/` and
the unpacked build loaded in Chrome.

- **M1** — On a real login page with the vault locked: focus the password field,
  confirm the amber "保管庫がロックされています" appears, press ESC, confirm it
  closes immediately and the text beneath is readable.
- **M2** — Same, but do not press ESC; confirm it disappears on its own after
  ~5 s. Confirm typing in the field afterwards does **not** bring it back.
- **M3** — With the vault unlocked and matching entries present: confirm the
  candidate list does **not** vanish after 5 s, and that ArrowDown/Enter still fill.
- **M4** — Repeat M1/M2 on a credit-card form and an address/identity form, to
  confirm the singleton fix reaches all three detectors (`FR6`).
- **M5** — Sign out to produce the disconnected state; confirm ESC and the 5 s
  timer both work there.

## Considerations & constraints

### Scope contract

- **SC1 — Click-to-unlock affordance on the locked / disconnected messages.**
  Deferred. **Anti-Deferral cost-justification**: making these messages clickable
  requires opening the extension popup from a content-script-originated click,
  which needs `chrome.action.openPopup()` behind a background relay. Chrome gates
  that API on a user gesture whose propagation across the content-script →
  background → popup boundary is **unmeasured in this environment (VC3)**. Cost of
  including it now: an unbounded probe of an unverified platform constraint inside
  a PR whose actual defect is a one-line guard, plus a new failure mode ("looks
  clickable, does not open") that is worse than the current honest static text.
  Cost of deferring: the user must open the popup themselves, which is exactly
  today's behavior — deferring adds no regression. Owner: a future issue, to be
  filed after a standalone `chrome.action.openPopup()` gesture probe. Decided with
  the user during Phase 1.
- **SC2 — `showInlineNotice()` (the 2.2 s black toast).** Out of scope. It already
  auto-dismisses at `form-detector-lib.ts:460-464` and is `pointer-events:none` by
  design, so it exhibits neither reported symptom. **Anti-Deferral**: cost of
  including = touching a second surface with no defect, widening the diff and the
  review surface for zero user-visible gain. Cost of excluding = none; no symptom
  is attributable to it. Owner: n/a — no work is owed.
- **SC3 — `save-banner.ts` / `passkey-save-banner.ts` ESC support.** Out of scope.
  Both already auto-dismiss (15 s) and both have explicit close buttons, so neither
  produces the reported "cannot dismiss" symptom. Adding ESC to them is a
  consistency improvement, not a fix. **Anti-Deferral**: cost of including = two
  more files and two more test suites in a PR the user framed around three specific
  messages, against the repo's scope-discipline norm. Cost of excluding = a minor
  residual inconsistency (banners lack ESC), user-visible only to someone who tries
  ESC on a banner, and non-blocking because the close button is present. Owner:
  optional future consistency pass.
- **SC4 — The orphaned `commands.noMatch` i18n key.** The key exists in both
  message files with no consumer anywhere in `src/`. **Anti-Deferral**: cost of
  including = a dead-key deletion is unrelated to this defect and would make the
  diff span the message files for no behavioral reason. Cost of excluding = one
  unused translation string, no runtime effect. Owner: a future i18n cleanup.
- **SC5 — `role="listbox"` set on message-only states.** `suggestion-dropdown.ts:65`
  sets `role="listbox"` unconditionally, but the message states render no
  `role="option"` children — an a11y inconsistency. **Anti-Deferral**: cost of
  including = an a11y semantics change (likely `role="status"` for message states)
  that alters screen-reader announcement behavior and needs its own manual
  verification with a screen reader, which VC1's constraint class also blocks. Cost
  of excluding = a pre-existing, unchanged a11y wart; this PR neither introduces nor
  worsens it. Owner: a future a11y pass. Noted here rather than silently, per `R34`.

- **SC6 — `try`/`catch` around the `onDismiss` invocation.** Out of scope.
  `hideDropdown()` calls `fn()` at `:161-165` unwrapped, while the module's other two
  cross-boundary calls *are* wrapped (`:112-116`, `:199-203`). C2 newly routes a timer
  callback through that path, where a throw has no originating frame.
  **Anti-Deferral**: cost of including = changing error-handling semantics on every
  existing dismissal path (blur, outside-click, keydown, navigation — 18 call sites),
  which is a wider behavioral change than the defect being fixed and would need its
  own test matrix for the swallow-vs-propagate decision. Cost of excluding = a throw
  from a detector `onDismiss` becomes an unhandled error in the timer path rather than
  in a page event handler; all three current callbacks are single assignments that
  cannot throw, so the exposure is latent, not live. Owner: a future error-handling
  pass over the module. Verified: all three `onDismiss` bodies are bare assignments.

### Risks

- **Risk 1 — the guard restructure weakens the `Enter` disclosure control.** This is
  the only security-relevant risk in the change. Mitigated by I1.2, the C1 forbidden
  pattern, and T6. Reviewers should read the `Enter` case first.
- **Risk 2 — a timer outlives its dropdown.** Mitigated by I2.2 (unconditional
  clear placed before the `currentDropdown` block) and T11/T12.
- **Risk 3 — 5 s is subjectively wrong for some users.** Accepted; the constant is
  named and single-sourced, so changing it is a one-line edit. No settings UI is in
  scope (adding one would need a popup control, an options-storage read in the
  content script, and a message round-trip — disproportionate to a timing tweak).

## User operation scenarios

1. **The reported scenario.** User focuses a login field on a site with no saved
   entry. "一致するエントリがありません" appears over the text below. User presses
   ESC → closes instantly. *Today: nothing happens.*
2. **Passive user.** Same as 1, but the user does not press ESC and just reads. The
   message clears itself after 5 s. *Today: it stays until they click elsewhere.*
3. **Typing through.** User dismisses the message and continues typing in the same
   field. Because re-show is bound to `focusin` and not `input`, it does not return.
4. **Deliberate re-check.** User clicks away, then clicks back into the field. The
   message reappears — correct, a new focus is a new request.
5. **Locked vault, acting on it.** Message appears, user opens the extension popup
   from the toolbar and unlocks. `PSSO_VAULT_STATE_CHANGED` triggers
   `requestMatches` on the active input (`form-detector-lib.ts:611-616`), so
   candidates appear. Unaffected by this change, but confirms the locked message is
   informational rather than a dead end — which is what makes `SC1` deferrable.
6. **Choosing a credential.** Vault unlocked, three candidates listed. User reads
   them for more than 5 s before choosing. The list does **not** vanish (`FR3`).
   This is the scenario that makes the entries-state exemption non-negotiable.
7. **Credit-card and address forms.** Same as 1-2 on a checkout page — covered by
   the singleton, verified by M4.

## Implementation Checklist

Authored in Phase 2 Step 2-1 from impact analysis. Phase 3 reads this as the list of
files that must appear in the diff.

### Files to modify

| File | Change |
| --- | --- |
| `extension/src/content/ui/suggestion-dropdown.ts` | Both production changes: per-case guard split with I1.4 untrusted-Escape denial; exported interval constant + timer arm/clear |
| `extension/src/__tests__/content/ui/suggestion-dropdown.test.ts` | T1-T15; `disconnectedMessage` added to `makeOptions()` (`:39-54`); `isTrusted` assert inside `trustedKeydown()` (`:136-145`); `vi.useRealTimers()` into the file-level `afterEach` (`:60-63`) |

**No detector file changes** — FR6's member-set derivation confirms the three
detectors reach the fix through the singleton. **No message-file changes** (NFR2).
**No `.js` mirror** (NFR1).

### Shared utilities to reuse (R1 / R2)

- `MS_PER_SECOND` from `extension/src/lib/time.ts:2` — the interval is
  `5 * MS_PER_SECOND`, **not** a bare `5000`. This is the same idiom
  `save-banner.ts:7,11` uses (`15 * MS_PER_SECOND`). Verified present.
- `getShadowHost()` from `./shadow-host` — already imported; timer teardown routes
  through the existing `hideDropdown()`, which already uses it. No new helper.
- The existing `trustedKeydown()` Proxy helper in the test file — extend it with the
  `isTrusted` self-assert rather than writing a second one.

### Patterns to follow consistently

- Timer handle typed `ReturnType<typeof setTimeout>`, bare `setTimeout`/`clearTimeout`
  — matching `save-banner.ts:24,84,92`, the auto-dismiss sibling.
- Clear-then-arm ordering, and clear before the `fn()` re-entrancy point (I2.2).
- Every dismissal routes through `hideDropdown()`; no hand-rolled teardown (I2.3).

### Test-tree enumeration (R19)

`grep -rl` across all test roots for the four exported symbols returns four files:
`suggestion-dropdown.test.ts`, `suggestion-dropdown-entrytype.test.ts`,
`form-detector-inline.test.ts`, `cc-identity-detector.test.ts`. Only the first is
modified; the other three mock the module wholesale and must be re-run unchanged to
confirm no break. There is no co-located `*.test.ts` beside `src/content/ui/` and no
e2e tree for the extension.

### CI gate parity (Step 2-1 item 7)

15 gates extracted from CI. Relevant to this diff: `npm run lint`, `npm run typecheck`,
and the extension's own vitest suite. The remaining 12 gate server-side concerns
(RLS, crypto domains, env docs, migration drift, TLS fixtures, licenses) that this
extension-only diff cannot affect — no parity gap, no deferred-parity entry needed.
`scripts/pre-pr.sh` exists and is the aggregate gate; run it before completion.

## Recurring-rule notes (pre-flagged for review)

Raised proactively so reviewers can confirm rather than rediscover:

- **`RT10` (guard tested only on one side)** — this is the *cause* of the shipped
  bug. `dismisses with Escape` (`:125`) tested Escape only on the entries axis; the
  message axis was never combined with it. T1-T5 add the missing axis combinations.
- **`RT7` (new guard must be proven able to fail)** — the prove-red obligation above
  is mandatory, not advisory, and its observed output goes in the deviation log.
- **`R52` (control reach extended without re-auditing the control)** — C1 widens the
  reach of `handleDropdownKeydown` (it now acts in states where it previously
  returned early). The `Enter` control inside it must be re-audited, not assumed
  intact: I1.2, T6.
- **`R2` (constants hardcoded)** — the 5000 ms interval is a named constant.
- **`R34` (pre-existing issue in adjacent file)** — `SC5` (`role="listbox"`) and
  `SC4` (orphaned key) are recorded with cost-justifications rather than silently
  skipped.
- **`R49` (undeclared control class)** — C1 and C2 both declare theirs; C2 is
  explicitly *detection/audit only* so nothing downstream treats the timer as a
  boundary.
