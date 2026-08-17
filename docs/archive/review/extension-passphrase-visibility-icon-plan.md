# Plan: extension-passphrase-visibility-icon

Replace the extension popup's textual "Show" / "Hide" passphrase toggle with an
eye / eye-with-slash icon, without losing the accessible name the button
currently gets from that text.

## Citation baseline

**Every `file:line` reference in this plan is against `main` at `d22f252c`**
(pre-implementation). Resolve citations with `git show main:<path>`, not against
HEAD once the fix lands.

## Project context

- **Type**: web app (browser extension sub-package, `extension/`)
- **Test infrastructure**: unit + integration (vitest + jsdom + @testing-library/react)
  + CI/CD. `npx vitest run` and `npx next build` are the repo's mandatory gates.
- **Verification environment constraints**:
  - **VC1 — Visual appearance is not verifiable in CI.** Whether the icon *reads
    as* "show/hide" to a sighted user is a judgment no assertion captures. jsdom
    renders no pixels. Every acceptance criterion below is therefore written
    against the accessible name, the `type` attribute, and the rendered markup —
    all `verifiable-CI` — and the visual check is a **manual-test** item (M1-M3),
    `blocked-deferred` for automation.
  - **VC2 — Screen-reader announcement is not exercisable here.** jsdom computes
    no accessibility tree; `getByRole(..., { name })` uses testing-library's own
    approximation of accessible-name computation, not the browser's.

    **What that approximation does and does not catch — measured, because an
    earlier revision of this plan stated it backwards.** It catches a *fully*
    missing name: a bare `<svg>` button does not resolve. It does **not**
    distinguish which attribute supplied the name — `title` alone resolves just as
    `aria-label` alone does. So the defect this design actually guards against
    (`title` present, `aria-label` absent) is invisible to any name-based query,
    and only a direct attribute assertion sees it. That is T6's entire reason for
    existing. Recorded rather than corrected silently, because the wrong version
    licensed a test list in which nothing enforced the design's central choice.

## Objective

The toggle at `VaultUnlock.tsx:65-71` renders the literal word "Show" / "Hide".
An eye icon is the near-universal convention for this control and is what the
surrounding UI already uses for every other action (`App.tsx:136-158`,
`MatchList.tsx:242-271` are all icon buttons). Make it consistent.

## Problem statement

`extension/src/popup/components/VaultUnlock.tsx:65-71`:

```tsx
<button
  type="button"
  onClick={() => setShowPassphrase((v) => !v)}
  className="text-xs text-gray-600 dark:text-gray-400 px-2 py-1 rounded ..."
>
  {showPassphrase ? t("popup.hide") : t("popup.show")}
</button>
```

This is the **only** textual icon-less action button in the popup. Every sibling
is already an icon button with a `title`:

| Control | Location | Form |
| --- | --- | --- |
| Lock vault | `App.tsx:136` | inline `<svg>` + `title` |
| Disconnect | `App.tsx:146` | inline `<svg>` + `title` |
| Settings | `App.tsx:154-155` | inline `<svg>` + `title` + `aria-label` |
| Fill / Copy username / Copy TOTP / Copy | `MatchList.tsx:242-271` | inline `<svg>` + `title` |

So this change removes an inconsistency rather than introducing a new pattern.

### The constraint that actually shapes the design

`extension/src/__tests__/popup/VaultUnlock.test.tsx:90-97`:

```tsx
it("toggles show/hide passphrase", async () => {
  const toggle = screen.getByRole("button", { name: /show/i });
```

The button's accessible name comes from its text content today. Replacing that
text with a **bare, unlabelled** `<svg>` leaves the button with no accessible name:
the test breaks, and a screen-reader user hears only "button".

**But `aria-label` is not the only thing that prevents this, and an earlier
revision of this plan was wrong to call it "mandatory".** Measured under this
repo's vitest 4.1.10 + jsdom 29 + @testing-library/react 16.3:

| Probe | Accessible name resolves? |
| --- | --- |
| `<button title="Show"><svg/></button>` | **yes** |
| `<button aria-label="Show"><svg/></button>` | **yes** |
| `<button><svg/></button>` | **no — nameless** |
| both set, differing values | `aria-label` wins; `title` is not announced |

`title` is the last fallback in accessible-name computation, and the repo already
relies on it: `App.tsx:146` sets `title` only, and `App.test.tsx:112` finds that
button by `getByRole("button", { name: /disconnect/i })`. So `title` alone would
satisfy FR2, I1.1, and every test below.

**`aria-label` is therefore a deliberate choice, not a necessity**, and the plan
must say which — because the difference decides the test design. It is kept
because `title` is not exposed to touch users, is announced inconsistently across
screen readers, and is the weakest name source in the computation.
`App.tsx:154-155` sets both on the settings button; this follows that precedent.

**Consequence for testing (this is the part an earlier revision got wrong):**
since `title` also carries the state-dependent value, a mutation that hardcodes
only `aria-label` will **not** redden a `getByRole(..., {name})` assertion. If
`aria-label` is to be load-bearing, one test must assert the attribute directly.
See T6 and the Kind-B table.

## Requirements

### Functional

- **FR1** — The toggle renders an eye icon when the passphrase is hidden and an
  eye-with-slash icon when it is visible.
- **FR2** — The button retains an accessible name that changes with state:
  "Show" when hidden, "Hide" when visible. The existing `popup.show` /
  `popup.hide` message keys supply it — **no new i18n keys** (NFR1).
- **FR3** — Clicking still toggles the input's `type` between `password` and
  `text`. Unchanged behaviour; it is listed because it is what the change must
  not break.
- **FR4** — A pointer user gets a native tooltip (`title`), matching every other
  icon button in the popup.

### Non-functional

- **NFR1** — No new i18n keys. `popup.show` / `popup.hide` already exist in both
  `src/messages/en.json:15-16` and `ja.json:15-16` and have exactly one consumer
  (this button), so their meaning is unchanged by the reuse.
- **NFR2** — The icon follows the popup's established inline-SVG idiom:
  `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
  `strokeLinecap="round"`, `strokeLinejoin="round"`, sized by a Tailwind class.
  **Not** the `src/content/ui/icons.ts` module — that exports HTML *strings* for
  `innerHTML` injection into a content-script shadow DOM, a different consumer
  with a different mechanism. Reusing it here would mean `dangerouslySetInnerHTML`
  in React to render markup we already control as JSX (see R1 note below).
- **NFR3** — The button matches the popup's icon-button idiom, verified against
  `App.tsx:130-160` rather than paraphrased:

  ```text
  button className="p-1.5 rounded-md text-gray-500 dark:text-gray-400
                    hover:text-gray-700 dark:hover:text-gray-200
                    hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
  svg    className="w-4 h-4"  strokeWidth="2"
  ```

  `App.tsx` header icons use `strokeWidth="2"`; `MatchList.tsx` row icons use
  `2.5`. This button sits in the unlock form, in neither group — `2` is chosen
  because the header buttons are the closer analogue in size (`w-4 h-4`) and
  because the heavier weight in `MatchList` compensates for its smaller
  `w-3.5 h-3.5` glyphs, a compensation that does not apply here.

- **NFR4 — the button's own box is respecified, not left to the implementer.**
  An earlier revision named the layout shift as a risk (M1, Risk 3) and then
  specified no className change, in a plan otherwise specified down to
  `strokeLinejoin`. Concretely:

  | | Before | After |
  | --- | --- | --- |
  | padding | `px-2 py-1` (8px / 4px) | `p-1.5` (6px, uniform) |
  | text size | `text-xs` | **removed** — dead once no text renders |
  | icon | — | `w-4 h-4` |
  | colour / hover / active / transition | unchanged | unchanged |

  `p-1.5` is what **all seven** sibling icon buttons use — `App.tsx:137,147,156`
  and `MatchList.tsx:243,254,262,269` — so this is conformance, not invention.
  `px-2 py-1` matches none of them and would leave an asymmetric box around a
  square glyph.

  Hit target: `p-1.5` + `w-4 h-4` gives 28×28 CSS px, clearing WCAG 2.2 SC 2.5.8's
  24×24 minimum on both axes. The current `px-2 py-1` around a 16px glyph would
  give 32×24 — clearing it on one axis only, and by luck of the glyph size rather
  than by design. Computed rather than asserted, because the earlier revision
  classified this as "not a correctness issue" without doing the arithmetic.

  This remains the one part of the change CI cannot verify (VC1) — hence M1, now
  strengthened to check squareness and centring rather than just "alignment".

## Technical approach

One file changed: `VaultUnlock.tsx`. Plus its test.

### Icon choice

Two inline SVGs, switched on `showPassphrase`:

- **hidden state → eye** (`popup.show`): the action offered is "reveal".
- **visible state → eye-with-slash** (`popup.hide`): the action offered is "conceal".

**This is settled by in-repo precedent, not by argument.** An earlier revision of
this plan defended the direction at length as "a real decision, not an obvious
one" — while the repo had already made it, uniformly, 37 times. Code-derived:

```console
$ grep -rn 'EyeOff' src/ --include='*.tsx' | wc -l
37
```

The direct analogue is the **web app's own vault unlock screen** —
`src/components/vault/vault-lock-screen.tsx:245-257` — same `showPassphrase`
state name, same `type={showPassphrase ? "text" : "password"}` input:

```tsx
{showPassphrase ? (
  <EyeOff className="h-4 w-4" />
) : (
  <Eye className="h-4 w-4" />
)}
```

That is the **action** convention, and it is what this plan follows. The choice is
now conformance to an established repo-wide convention rather than a judgment
call, which is a materially stronger footing and removes the re-litigation risk
the earlier revision was worried about.

The web app reaches it via `lucide-react`. **The extension cannot**:
`extension/package.json` lists only `otpauth`, `react`, `react-dom`, `tldts` — no
icon library. So the extension must inline equivalent SVG paths. The two surfaces
converge in *semantics* and diverge in *implementation*, and the divergence is
forced by the dependency set rather than chosen.

Note also `vault-lock-screen.tsx` sizes its glyph `h-4 w-4`, matching the
`w-4 h-4` this plan selects in NFR3 from `App.tsx` — the two independent lines of
evidence agree.

### Accessible name

`aria-label={showPassphrase ? t("popup.hide") : t("popup.show")}` — the exact
expression that is the button's text today, moved to the label. `title` gets the
same value for the pointer tooltip.

**Measured, not assumed** — a throwaway probe under this repo's vitest 4.1.10 +
jsdom 29 + @testing-library/react, three assertions, all passing:

| Probe | Result |
| --- | --- |
| `<button title="Show"><svg/></button>` matched by `getByRole("button", {name:/show/i})` | **yes** |
| `<button aria-label="Show"><svg/></button>` matched by the same query | **yes** |
| `<button><svg/></button>` (bare icon, no label) matched | **no — nameless** |

Two conclusions the design rests on:

1. **The nameless-button risk is real.** A bare icon button is not found by the
   existing test's query, confirming that dropping the text without adding a label
   breaks `VaultUnlock.test.tsx:93` — and, more importantly, leaves the control
   unidentifiable to assistive technology.
2. **`title` alone would satisfy both the test and the ARIA name fallback.** So
   `aria-label` is a *deliberate* choice, not a necessity. It is kept because
   `title` is a weak accessible-name source — it is the last fallback in the
   accessible-name computation, is not announced consistently across screen
   readers, and is invisible to touch users. `App.tsx:154-155` already sets both
   on the settings button; this follows that precedent rather than inventing one.

Recorded because "the test passes" would otherwise be mistaken for evidence that
the accessibility half is handled, when the test would also pass with `title`
alone.

`aria-label` is used rather than a visually-hidden `<span>` because the popup has
no `sr-only` utility in use anywhere, and introducing one for a single control
would be a wider change than the defect warrants.

### `aria-hidden` on the `<svg>`

**Not** set, following the popup's majority convention: `App.tsx:139,149,158` and
`MatchList.tsx:245,256,264,271` all render bare `<svg>` inside labelled buttons.
(`FillMismatchDialog.tsx` uses `aria-hidden` once, so the convention is not
unanimous — hence stating the choice rather than leaving the implementer to guess.)
With `aria-label` on the button, the name is computed from the label and the child
graphic is not traversed, so the attribute would change nothing here.

### Why not `aria-pressed`

A toggle button can carry `aria-pressed`. Deliberately **not** added: with a
state-changing `aria-label` ("Show" ↔ "Hide"), adding `aria-pressed` produces a
double announcement ("Hide, pressed") whose two halves can be read as
contradicting each other. Choose one mechanism. The changing label is the one
that already exists and that the test already queries. Recorded so a reviewer
does not read the omission as an oversight.

What conveys the *current* state under this mechanism: the user infers it from the
action name (hearing "Show" implies currently hidden), and independently from the
field itself — the input's `type` flips between `password` and `text`, which
assistive technology reports for the input (I1.3). Stated because it is the first
thing a reviewer probes about an action-labelled toggle.

## Contracts

### C1 — The toggle is an icon button with a state-dependent accessible name

- **Signature** (unchanged): the component's props and the `showPassphrase` state
  hook are untouched. This contract is about rendered output only.
- **Control class**: **detection or audit only** — no denial. This is presentation;
  nothing security-relevant gates on it. Declared explicitly (R49) so no later
  contract treats the icon as a boundary. Note the *adjacent* security property
  (the input's `type` attribute, which is what actually masks the passphrase) is
  **not** part of this contract and must not change — see I1.3.
- **Invariants**:
  - **I1.1** (app-enforced): the button has a non-empty accessible name in both
    states. *No schema-enforced equivalent exists* — React cannot express "this
    element must have an accessible name" in the type system; the closest
    mechanism is a lint rule (`jsx-a11y`), which this repo does not run. Stated
    per the plan's obligation to justify app-enforced choices.
  - **I1.2** (app-enforced): the accessible name is `popup.show` when the
    passphrase is hidden and `popup.hide` when visible — i.e. it names the
    **action**, matching the icon direction.
  - **I1.3** (app-enforced): the input's `type` remains `password` when hidden and
    `text` when visible. The change is presentational and must not touch the
    masking mechanism.
- **Forbidden patterns**:
  - `pattern: dangerouslySetInnerHTML` — reason: the icon is JSX we control; there
    is no reason to route it through raw HTML injection in a component that
    handles a passphrase.
  - `pattern: <button[^>]*>\s*<svg` with no `aria-label` on the button — reason:
    that is precisely the nameless-button defect this contract exists to prevent.
    (Checked by reading, not grep alone — the regex is a hint; I1.1's test is the
    real gate.)
- **Acceptance criteria**:
  - `getByRole("button", { name: /show/i })` resolves while the input is
    `type="password"`.
  - After one click, `getByRole("button", { name: /hide/i })` resolves and the
    input is `type="text"`.
  - After a second click, the name returns to `/show/i` and the type to
    `password`. **The round-trip matters**: a label wired to a constant rather
    than to state would pass the first two criteria and fail this one.
  - The button contains an `<svg>` element in both states.
  - The two states render *different* icon markup. Without this, an
    implementation that shows the same icon regardless of state satisfies
    everything above.
- **Manual-test classification**: `verifiable-CI` for all five criteria. The
  question "does the icon read as show/hide to a sighted user" is VC1's
  `blocked-deferred` half, covered by M1-M3.

### C2 — Consumer-flow walkthrough

The changed surface is rendered output consumed outside the component, so each
consumer is walked through before C1 locks.

- **Consumer 1 (path: `src/__tests__/popup/VaultUnlock.test.tsx:90-97`)** reads
  `{ accessible name, input type }` and uses the name to *locate* the button
  (`getByRole("button", { name: /show/i })`), then asserts the type flips. It
  needs the name to survive the change — which is exactly what `aria-label`
  supplies. **This walkthrough is why `aria-label` is in the design at all**: the
  producer-side change (swap text for an icon) is internally coherent and would
  still leave this consumer unable to find the button.
- **Consumer 2 (path: the end user via assistive technology)** reads the
  accessible name and uses it to decide whether activating the control will
  reveal or conceal. Not a code consumer, but it is the one I1.1 exists for, and
  the one whose failure no test would have reported before this plan.
- **Consumer 3 (path: `src/messages/{en,ja}.json:15-16`)** — the `popup.show` /
  `popup.hide` keys. Their sole consumer is this button (verified below), so
  moving the values from text content to `aria-label` changes no other rendering.

**No consumer needs a field absent from the design.** C1 and C2 are complete.

### Member-set derivation (R42)

NFR1 claims the message keys have exactly one consumer. Code-derived, from
`extension/`:

```console
$ grep -rn 'popup\.show\|popup\.hide' src/
src/popup/components/VaultUnlock.tsx:70

$ grep -rn 'name: /show\|name: /hide' src/__tests__/
src/__tests__/popup/VaultUnlock.test.tsx:93
```

One producer, one test consumer. `grep -rn '"show"\|"hide"' ios/` returns nothing,
so the iOS target does not share these keys. Phase 3 must re-run these greps
rather than carry the result forward.

## Go/No-Go Gate

| ID | Subject | Status |
| --- | --- | --- |
| C1 | Icon button with a state-dependent accessible name; masking untouched | locked |
| C2 | Consumer-flow walkthrough for all three consumers | locked |

Both were revised in Round 1 and re-locked. Round 1 found **no defect in the
change's destination** — the icon swap itself was never in question. Every finding
was in the plan's *reasoning*: two claims asserted instead of measured
(accessible-name computation, the icon-direction precedent), one risk named but
left unspecified (the button's box), and two test-design defects that would have
shipped tests unable to fail. That distribution is worth noting, because it is the
same one the previous change on this package produced.

## Testing strategy

Extend the existing `src/__tests__/popup/VaultUnlock.test.tsx`. No new file — the
component already has one, and splitting would fragment the fixture.

### Prove-red obligation (RT7), by kind

**Two Criticals in the first revision's test design were found by execution, and
both are the vacuity class this repo has been bitten by before.** They are
recorded rather than quietly fixed, because the errors were in *reasoning about
what a test proves*, which is the thing that recurs:

1. **T4 as originally listed reddened for the wrong reason.** With "different icon
   markup" unspecified, the natural implementation compares
   `querySelector("svg")?.innerHTML` across states. Against `main` both sides are
   `undefined` (no `<svg>` exists), so the assertion fails on
   `Object.is(undefined, undefined)` — a red that says nothing about icon
   differentiation, and one that disappears the moment *any* `<svg>` lands,
   differentiated or not.
2. **The Kind-B mutation "swap the icon/label pairing" does not redden T2.** T2
   asserts the accessible *name* round-trips; swapping which glyph pairs with
   which label leaves every name untouched. Verified: the swapped implementation
   passes T2 *and* T4 (the icons still differ, just backwards). So I1.2 was
   declared as an invariant and pinned by nothing.

Also measured: **T3 as written passes against a same-icon implementation**
(`expect(button.querySelector("svg")).not.toBeNull()` is satisfied by any icon),
so it is subsumed by a corrected T4 rather than independent coverage.

**Kind A — red against unfixed `main`** (genuine regression tests):

| Test | Why it reddens on `main` |
| --- | --- |
| T3 | `main` renders text; `querySelector("svg")` is `null` |
| T4 | same — but see the corrected assertion below, which makes the red meaningful |

**Kind B — red against a named mutation of the fix.** Every row's mutation is run
and observed separately; a row whose mutation does not reproduce is a defect in
this table, not a passing test.

| Test | Mutation | Expected |
| --- | --- | --- |
| T1, T2 | hardcode **both** `aria-label` and `title` to a constant | must fail |
| T6 | **delete** `aria-label`, leaving `title` to supply the name | **T6 must fail; T1/T2/T5 must stay green** |
| T4 | render the same icon in both states | must fail |
| T5 | remove the `type={...}` ternary from the input | must fail |
| T7 | swap the icon/label pairing (eye shown while visible) | must fail |

**Corrected during Phase 2.** This row originally said "hardcode `aria-label` only".
Run as written it reddened six tests, not one — because `aria-label` *overrides*
`title`, so freezing it freezes the accessible name in both states and every
name-based query collapses. Deleting the attribute is the mutation that isolates
the clause. See deviation log D1.

The T6 row is the one that matters most and is the one the first revision lacked:
it is the *only* clause that proves `aria-label` is load-bearing rather than
decorative. Its paired expectation — that T1/T2/T5 stay **green** under the same
mutation — is the evidence, not incidental.

**Allow side, per the Remedy Floor**: after every mutation-revert the full
extension suite must be green, including the seven existing `VaultUnlock` tests
and the `MatchList`/`App` tests that query sibling icon buttons by accessible
name. Those prove the change did not disturb the popup's naming convention.

**Fail loudly**: if a mutation cannot be applied (the attribute is already absent,
the anchor moved), stop and report — do not record the clause as proven.

### Test list

| ID | Test | Pins | Red-proof |
| --- | --- | --- | --- |
| T1 | name is `/show/i` initially, `/hide/i` after one click | I1.2 | B |
| T2 | name returns to `/show/i` after a second click | I1.2 | B |
| T3 | the toggle contains an `<svg>` in both states | FR1 | A |
| T4 | the two states render **different** icon markup | FR1 | A + B |
| T5 | input type is `password` → `text` → `password` | I1.3 | B |
| T6 | `aria-label` attribute itself flips show → hide | I1.1 | B |
| T7 | the eye-with-slash glyph is the one shown while **visible** | I1.2 | B |

**T4's assertion, specified** (it was the absence of this that made T4 vacuous):

```tsx
const iconFor = (name: RegExp) => {
  const svg = screen.getByRole("button", { name }).querySelector("svg");
  expect(svg).not.toBeNull();        // guard: absent icon must fail loudly,
  return svg!.outerHTML;             // not silently compare undefined to undefined
};
const hidden = iconFor(/show/i);
fireEvent.click(screen.getByRole("button", { name: /show/i }));
const visible = iconFor(/hide/i);
expect(visible).not.toBe(hidden);
```

`outerHTML`, not `innerHTML`: `strokeWidth`, `className` and `viewBox` live on the
`<svg>` element itself, so `innerHTML` would miss an icon that changed only its
attributes. Whitespace-stable — React emits no inter-element whitespace in this
JSX. The `not.toBeNull` guard is what makes the comparison meaningful; **do not
remove it to make T3 and T4 non-redundant**, because it is precisely what stops
the `undefined === undefined` masquerade.

**T7 is what actually pins I1.2** (the icon/label *pairing*, as opposed to T4's
icon *difference*). It asserts the visible-state glyph contains the slash element
and the hidden-state glyph does not. This couples the test to the chosen path
data, which is a real cost — accepted, because the alternative is an invariant
with no test, and the first revision's attempt to pin it via T2 was measured not
to work.

T5 duplicates part of the existing test at `:90-97` deliberately. Note the
justification is narrower than the first revision claimed: T5 uses the same
name-based query, so it does **not** hedge against name loss — it hedges only
against edits to the existing test's body. Stated accurately here because the
overstated version would license skipping T6.

### Locale pinning in the tests (RT3)

The tests query by the English literals `/show/i` and `/hide/i`, while `t()`
resolves through `navigator.language` (`i18n.ts`). That works today only because
jsdom hardcodes `navigator.language` to `en-US` regardless of the host locale —
verified under this machine's `LANG=ja_JP.UTF-8`: all seven existing tests pass.

Ten other extension test files pin `navigator.language` explicitly;
`VaultUnlock.test.tsx` does not. The safety therefore rests on a jsdom default
the suite never states. **Add the same override** for parity with the sibling
files, so the tests assert under a locale they declare rather than one they
inherit. The ja rendering itself stays manual-only (M3) — scenario 5 claims ja
correctness and no automated test covers it, which is honest only if M3 is
actually run.

## Manual test plan

Covers VC1. Run `npm run dev` in `extension/`, load the unpacked build, open the
popup with the vault locked.

- **M1** — Confirm the eye icon appears to the right of the passphrase field and
  is vertically aligned with the input (the input is `h-10`; the button is not).
- **M2** — Click it: the passphrase becomes readable and the icon changes to
  eye-with-slash. Click again: it re-masks and the icon returns.
- **M3** — Hover: the native tooltip reads "Show" / "Hide" (and the Japanese
  equivalents under `ja`).
- **M4** — Check both light and dark mode: the icon inherits `currentColor`, so
  confirm it is legible against both backgrounds.

## Considerations & constraints

### Scope contract

- **SC1 — The web app's own passphrase toggles.** Out of scope as *code*, but the
  first revision's reasoning here was factually backwards and is corrected. It
  said the two surfaces "already are" inconsistent and that excluding the web app
  keeps them so. The opposite is true: the web app renders `Eye` / `EyeOff`
  (37 usages; `vault-lock-screen.tsx:245-257` is the direct analogue), the
  extension renders text — **that** is today's inconsistency, and this change
  *removes* it. The web app needs no edit at all.

  **Anti-Deferral**: cost of including web-app files = editing a package that has
  no defect, to no user-visible end. Cost of excluding = none; the surfaces
  converge without it. The one residual difference is the icon *mechanism* —
  `lucide-react` in the web app, inline SVG in the extension — and that is forced,
  not chosen: `extension/package.json` has no icon dependency. Owner: n/a — no
  work is owed.

- **SC2 — Extracting a shared `EyeIcon` component.** Out of scope. Every icon in
  the popup today is written inline at its use site (`App.tsx`, `MatchList.tsx`)
  — extracting only this one would create an inconsistency, and extracting all of
  them is a refactor with no behavioural content. **Anti-Deferral**: cost of
  including = touching three files to no functional end; cost of excluding = one
  more inline SVG in a codebase whose convention is inline SVGs. Owner: n/a — no
  work is owed unless the icon set grows.
- **SC3 — `jsx-a11y` lint rule for nameless buttons.** Out of scope, but worth
  naming: I1.1 is app-enforced only because no lint rule enforces it repo-wide.
  A `jsx-a11y/control-has-associated-label` rule would make the whole *class* of
  nameless-icon-button defects schema-enforced rather than test-enforced.
  **Anti-Deferral**: cost of including = adding an eslint plugin and fixing
  whatever it flags across the existing popup, an unbounded scope discovered
  mid-PR. Cost of excluding = the next icon button added without a label is
  caught only if someone writes a test for it. Owner: a future a11y tooling pass.
  Recorded per R34 rather than silently.

- **SC4 — Re-masking the passphrase after a failed unlock.** Out of scope, and the
  question is answered rather than left open. `VaultUnlock.tsx:37-42` clears the
  passphrase only on the success branch; on failure the value stays in React state
  and, if revealed, stays readable in the DOM for the rest of the popup session.
  **Verified mitigation**: the popup is a fresh document per open
  (`src/popup/main.tsx` calls `createRoot(...).render()` each load) and
  `showPassphrase` is component-local `useState` with no `chrome.storage` backing —
  so neither the reveal state nor the passphrase survives closing the popup. There
  is no cross-session exposure.

  **Anti-Deferral**: worst case = a wrong, revealed master passphrase stays on
  screen until the user closes the popup or retypes. Likelihood = only after a
  failed unlock *with* reveal already toggled on. Cost of including = turns a
  purely presentational change into a behavioural one, cutting against C1's own
  "signature unchanged" framing and requiring its own test matrix for the
  error path. Cost of excluding = the pre-existing window stays open, unchanged
  by this PR either way. Owner: a future unlock-flow hardening pass. Recorded so a
  later round does not re-litigate it as if undecided.

- **SC5 — `autoComplete="off"` / `spellCheck={false}` on the passphrase input.**
  Out of scope, and pre-existing: `VaultUnlock.tsx:57-64` sets neither, and grep
  confirms neither appears anywhere in `src/popup/`. This matters *adjacent* to
  this change because `type="text"` (the revealed state) is where browser
  save-prompt and spellcheck heuristics differ from `type="password"` — but that
  flip already exists on `main` and I1.3 pins it unchanged, so this change neither
  introduces nor widens the exposure (R43: no widening).

  Worth noting the web app's analogue **does** set `autoComplete` —
  `vault-lock-screen.tsx:241` uses `autoComplete="current-password"` — so there is
  an in-repo precedent for hardening this input, which strengthens the case for a
  follow-up. **Anti-Deferral**: cost of including = a behavioural change to
  autofill on a component this PR is otherwise only restyling, with no test able
  to verify browser heuristics (VC1's constraint class). Cost of excluding = an
  unchanged pre-existing gap. Owner: the same unlock-flow hardening pass as SC4.
  Recorded explicitly so a Phase-3 reviewer does not rediscover the `type="text"`
  concern and mistake it for fix-induced.

### Risks

- **Risk 1 — the icon reads backwards to some users.** The action-vs-state
  convention split is real (see Technical approach). Mitigated by keeping the
  text label as the tooltip and accessible name, so the meaning is recoverable
  by hovering. Accepted; M2 is the check.
- **Risk 2 — the accessible name is lost.** The whole reason `aria-label` is in
  the design. Pinned by T1/T2 and by the existing test's own query.
- **Risk 3 — vertical alignment shifts** once the text is replaced by a fixed-size
  icon. Not a correctness issue and not automatable (VC1); M1 is the check.

## User operation scenarios

1. **The reported scenario.** User opens the popup to unlock, sees an eye icon
   beside the passphrase field rather than the word "Show", and recognises it
   without reading.
2. **Verifying a typo.** User types a long passphrase, clicks the eye, reads it,
   clicks again to re-mask, then unlocks. Both the icon and the input type must
   round-trip — the scenario T2 and T5 pin.
3. **Keyboard-only user.** Tabs from the input to the button, activates with
   Space/Enter. `type="button"` (unchanged) keeps this from submitting the form.
4. **Screen-reader user.** Hears "Show, button" rather than "button" — the
   difference between a usable control and an unidentifiable one, and what I1.1
   exists for.
5. **Japanese locale.** Tooltip and accessible name read 表示 / 非表示 via the
   existing keys, with no new translation work.
