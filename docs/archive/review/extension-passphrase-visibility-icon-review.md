# Plan Review: extension-passphrase-visibility-icon

Date: 2026-08-17
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing) reviewed the
plan in parallel against the real source. Ollama was unavailable, so pre-screening and
`merge-findings` were both skipped — deduplication below is the documented manual
fallback, joined by hand on the experts' JSON indexes.

## Summary

16 findings: **2 Critical, 4 Major, 10 Minor** (5 `[Adjacent]`). All Critical and Major
are resolved in the plan.

**No finding was against the change itself.** Replacing the text toggle with an eye icon
was never in question. Every defect was in the plan's reasoning, and they share one root
cause: **claims asserted from plausibility instead of measured.** Three of them were
refuted by execution in under a minute each.

## Functionality Findings

**F-Func-1 — Major — RESOLVED.** The plan's central premise — "replacing the text leaves
the button with *no* accessible name; `aria-label` is **mandatory**" — is false. `title`
alone supplies the accessible name, and the repo already depends on this: `App.tsx:146`
sets `title` only and `App.test.tsx:112` finds that button by name. *Verified by
execution.* The plan's own evidence table listed those `title`-only siblings on line 62
while line 78 claimed the opposite, and did not notice.

*Resolution:* the section is rewritten around the measured behaviour, with the probe
table inline. `aria-label` is kept but reframed as a **deliberate choice** (`title` is
not exposed to touch, is inconsistently announced, is the weakest name source) rather
than a necessity. The knock-on defect this caused in the test design is F-Test-2.

**F-Func-2 — Major — RESOLVED.** The R42 member-set was scoped to the wrong class. The
message-key derivation was correct and reproduced exactly, but the *behavioural* class —
"show/hide passphrase toggles in this repo" — has **37 members** in the web app, including
the direct analogue `src/components/vault/vault-lock-screen.tsx:245-257`, which renders
`showPassphrase ? <EyeOff/> : <Eye/>` on the same state variable name.

Two consequences. First, the plan spent a paragraph defending the action-vs-state icon
direction as "a real decision, not an obvious one" — while the repo had already made it,
uniformly, 37 times. Second, SC1's cost reasoning was **backwards**: it said the two
surfaces "already are" inconsistent and excluding the web app keeps them so, when in fact
web=icon / extension=text *is* the inconsistency and this change removes it.

*Resolution:* the icon direction now cites the precedent instead of arguing; SC1 is
rewritten; and the forced divergence is named (the extension has no icon dependency —
`package.json` lists only `otpauth`, `react`, `react-dom`, `tldts`, so it must inline).
*Verified independently:* 37 `EyeOff` usages, the analogue's code, and the absent lucide
dep.

**F-Func-3 — Major — RESOLVED.** The plan named the button's layout change as a risk
(M1, Risk 3) and then specified no className change — in a document otherwise specified
down to `strokeLinejoin`. The existing `px-2 py-1` matches none of the seven sibling icon
buttons, which uniformly use `p-1.5`, and `text-xs` becomes dead once no text renders.
The expert also computed what the plan had merely asserted: `px-2 py-1` + a 16px glyph
gives 32×24 px, clearing WCAG 2.2 SC 2.5.8's 24×24 minimum on one axis only and by luck
of the glyph size.

*Resolution:* new **NFR4** with a before/after table, `p-1.5` + `w-4 h-4` (28×28),
justified against all seven siblings. M1 strengthened from "confirm alignment" to
"confirm square, `p-1.5`-padded, centred against the `h-10` input".

**F-Func-4 — Minor (question) — ANSWERED.** Should the `<svg>` carry `aria-hidden`?
*Resolution:* documented as deliberately omitted, following the `App.tsx` /
`MatchList.tsx` majority; noted that `FillMismatchDialog.tsx` differs, which is why the
choice is stated rather than left implicit.

**F-Func-5 — Minor — RESOLVED.** The `aria-pressed` rejection was sound but never said
what conveys the *current* state under an action label. *Resolution:* one paragraph —
inferred from the action name, and independently observable from the input's own `type`.

## Security Findings

**F-Sec-1 — Minor (question) — ANSWERED, deferred as SC4.** A failed unlock leaves the
passphrase in React state and, if revealed, readable in the DOM for the rest of the popup
session (`VaultUnlock.tsx:37-42` clears only on success). *The expert verified the
mitigation rather than asserting the risk*: the popup is a fresh document per open and
`showPassphrase` is component-local with no `chrome.storage` backing, so **nothing
survives closing the popup**. Pre-existing and untouched by this change.
*Resolution:* recorded as SC4 with a full Anti-Deferral entry, so a later round does not
re-litigate it as undecided.

**F-Sec-2 — Minor — DEFERRED as SC5.** The passphrase input sets neither
`autoComplete="off"` nor `spellCheck={false}` — relevant because `type="text"` is where
browser save-prompt and spellcheck heuristics differ. Pre-existing; I1.3 pins the `type`
flip unchanged, so **R43: no widening**. Notably the web app's analogue *does* set
`autoComplete="current-password"` (`vault-lock-screen.tsx:241`), so there is in-repo
precedent for a follow-up. *Resolution:* SC5, recorded explicitly so Phase 3 does not
rediscover the `type="text"` concern and mistake it for fix-induced.

**F-Sec-3 — Minor `[Adjacent]` — NOTED.** T5's red-proof is the only security-relevant
clause in the mutation table (I1.3 is the masking invariant); it must not be waived if
Phase 3 is compressed. Carried into Phase 2 as a priority note.

The security expert also declined to raise the obvious-looking finding: that a more
discoverable reveal affordance increases shoulder-surfing exposure. Correctly — the
control already exists, the default is unchanged (`useState(false)`), the click count is
unchanged, and "an icon is more salient than a word" is an unfalsifiable claim about
pixels that VC1 already declares unverifiable. Recording the *non*-finding because it is
the one a reader will expect to see.

Verification worth recording: **zero `dangerouslySetInnerHTML` hits extension-wide**, so
C1's forbidden pattern starts from a verified-zero baseline; the six `icons.ts` strings
are static literals with no interpolation, so even the existing content-script consumer
is not an injection sink; and `showPassphrase` has exactly three references, none
touching storage or messaging — **the icon is load-bearing for nothing** (R49 confirmed).

## Testing Findings

**F-Test-1 — Critical — RESOLVED.** T4's assertion was unspecified, and the natural
implementation reddens against `main` **for the wrong reason**. Comparing
`querySelector("svg")?.innerHTML` across states yields `undefined` on both sides (no
`<svg>` exists on `main`), so the test fails on `Object.is(undefined, undefined)` — a red
that says nothing about icon differentiation and that vanishes the moment *any* `<svg>`
lands, differentiated or not. *Verified by execution.*

*Resolution:* T4's assertion is now written out in full, with a `not.toBeNull` guard so
the absent-element case fails loudly instead of masquerading, and `outerHTML` rather than
`innerHTML` (because `strokeWidth` / `className` / `viewBox` live on the element itself).
The plan states explicitly that the guard must not be removed to de-duplicate T3.

**F-Test-2 — Critical — RESOLVED.** The Kind-B mutation "swap the icon/label pairing" was
listed as reddening T2. It does not: T2 asserts the accessible *name* round-trips, and
swapping which glyph pairs with which label leaves every name untouched. *Verified:* the
swapped implementation passes T2 **and** T4. So **I1.2 was declared as an invariant and
pinned by nothing** — a mutation table row recording a red-proof that would not reproduce,
which is the exact shape of the prior incident on this package.

*Resolution:* new **T7** binds a specific glyph to a specific state (the slash element
must be present in the visible-state icon and absent in the hidden-state one). The
coupling to path data is accepted and stated, because the alternative was an unpinned
invariant.

**F-Test-3 — Major — RESOLVED.** T3 passes against a same-icon implementation
(*verified*), so it is subsumed by the corrected T4 rather than independent coverage.
*Resolution:* T3 is kept — it distinguishes "no icon" from "same icon" in the failure
message — but the plan now says that is its only value, instead of implying broader
coverage.

**F-Test-4 — Major — RESOLVED.** VC2 stated the accessible-name situation backwards, and
the consequence was concrete: **every test in T1-T5 would pass on an implementation that
drops the `aria-label` the plan called mandatory.** *Resolution:* VC2 rewritten around the
measurement, and new **T6** asserts the `aria-label` attribute directly, with the
paired expectation that T1/T2/T5 stay *green* under the same mutation — that green is the
evidence `aria-label` is load-bearing.

**F-Test-5 — Minor — RESOLVED.** T5's stated justification overclaimed: it uses the same
name-based query, so it hedges against edits to the existing test's body, not against
name loss. *Resolution:* corrected in place, because the overstated version would have
licensed skipping T6.

**F-Test-6 — Minor — RESOLVED.** The tests hardcode English literals while `t()` resolves
through `navigator.language`; ten sibling test files pin the locale and
`VaultUnlock.test.tsx` does not. It passes today only because jsdom defaults to `en-US`
regardless of host locale (*verified under `LANG=ja_JP.UTF-8`*). *Resolution:* the plan
now requires the same override for parity, and states that ja rendering stays manual-only
(M3).

**F-Test-7 — clean.** No fixture leakage (`beforeEach` clears and re-seeds), no
status-without-mutation assertion, real component with only boundary mocks, no new
production exports.

## Adjacent Findings

Routed and dispositioned above: F-Sec-3 (priority note → Phase 2), F-Func-6/F-Test A1
(SC3 overstated the nameless-button exposure, since `title`-only siblings *do* have names
— folded into F-Func-1's correction), F-Test A2 (`vitest.config.ts`
`environmentMatchGlobs` vs docblock inconsistency — pre-existing, not introduced, no
action), F-Func-8 (`title` on a passphrase-adjacent control — content is the literal word
"Show"/"Hide", non-sensitive; confirmed by security).

## Quality Warnings

None. The `merge-findings` quality gate could not run (Ollama unavailable). Manual
substitute: every Critical and Major was independently re-verified before acceptance —
the 37-member `EyeOff` class and the analogue's code were read directly, and T3's vacuity
plus the same-icon `outerHTML` equality were re-run as probes. Verification method is
named per finding.

## Recurring Issue Check

### Functionality expert

R1 checked-clean (`icons.ts` = HTML strings for `innerHTML`, verified; no other popup
icon helper; no lucide dep). R3 **finding-raised** (F-Func-2, 37-member class). R7/R8
**finding-raised** (F-Func-3, dead `text-xs`, `px-2 py-1` vs uniform `p-1.5`). R26
checked-clean (button has no disabled state, so no cue owed). R29 checked-clean (all 8
citations + baseline `d22f252c` verified exact). R30/R39/R43 **finding-raised**
(F-Func-1, overclaim contradicted by the plan's own line 62). R41 checked-clean. R42
**finding-raised** (message-key greps clean; class scoping wrong). R49 checked-clean. R50
**finding-raised** (F-Func-3, layout boundary unnamed). R52 **finding-raised** (F-Func-1,
the named T1/T2 mutation will not redden). Remainder n-a or checked-clean.

### Security expert

R29 checked-clean — **all citations and both greps reproduce exactly**, unusual enough to
state plainly. R43 checked-clean (no widening; `type` ternary preserved and pinned by
I1.3). R49 checked-clean (control class declared *and* correctly separated from the
masking property). RS3/RS6 checked-clean (zero `dangerouslySetInnerHTML` extension-wide;
icon strings are static literals; JSX path introduces no sink). RS4 checked-clean (no PII;
fixtures use `"pw"` / `example.com`). RS1/RS2/RS5 n-a. Remainder n-a or checked-clean.

### Testing expert

RT2 **finding-raised** (F-Test-1, T4 unspecified and vacuous as naturally written). RT3
**finding-raised** (F-Test-6, locale). RT5 checked-clean (real component, boundary mocks
only). RT6 checked-clean (no new production exports). RT7 **finding-raised** (F-Test-1
and F-Test-2 — one Kind-A red for the wrong reason, one Kind-B row that does not
reproduce). RT8 checked-clean. RT9 checked-clean. RT10 **finding-raised** (F-Test-4,
`aria-label` has neither side). RT11 checked-clean (`vi.clearAllMocks()` + re-seed).

## Round 2 assessment

Not run. Saturation is deliberately **not** claimed — it requires two completed rounds, so
it cannot fire here. Proceeding to Phase 2 is a judgment recorded as such: every Critical
and Major is resolved; no finding was against the design; the change is one component
plus its test; and the two Criticals were both about *test design*, which Phase 2's
mandatory prove-red execution re-verifies by running the mutations rather than reasoning
about them. If any Kind-A/Kind-B expectation fails to reproduce in Phase 2, that is a
Round-2 input.
