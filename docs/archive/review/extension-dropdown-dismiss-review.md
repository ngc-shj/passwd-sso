# Plan Review: extension-dropdown-dismiss

Date: 2026-08-17
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing) reviewed
`extension-dropdown-dismiss-plan.md` in parallel against the actual extension source.
Local LLM pre-screening was skipped — Ollama unavailable at `localhost:11434`; the
`merge-findings` dedup call was likewise unavailable, so deduplication below is the
documented manual fallback (the JSON findings indexes from each expert were joined by
hand on file + root cause).

## Summary

19 findings: 2 Critical, 4 Major, 13 Minor (3 of them `[Adjacent]`). All Critical and
Major findings are resolved in the plan. **No finding was against the change's
destination** — the two-part fix (per-case guard split + auto-dismiss timer, confined
to `suggestion-dropdown.ts`) survived all three reviews intact. Every defect was in
the plan's reasoning, its enumeration, or its test design.

The two Criticals are the notable result, because both were found *by execution* and
both are the same defect class the plan was written to fix:

- **T5, T7, T9, T10 passed against unfixed `main`** — four of twelve proposed tests
  were vacuous. I re-ran this myself and confirmed all four green with no fix applied.
  The plan diagnosed the shipped bug as "a test that passed vacuously" and then
  reproduced that exact failure.
- **The fake-timer/rAF claim was factually inverted.** Vitest 4 fakes
  `requestAnimationFrame`, so `advanceTimersByTime` runs the pending rAF and installs
  the real outside-click handler mid-test. I had asserted the opposite from reasoning;
  a probe refuted it.

## Functionality Findings

**F-Func-1 — Major — RESOLVED.** I2.2's timer-clear ordering invariant was anchored to
the wrong landmark. `hideDropdown()` does not end at the `if (currentDropdown)` block —
it ends by invoking `currentOnDismiss()` **synchronously** at `:161-165`, a re-entrancy
point running detector-supplied code. "Clear before the `currentDropdown` block" is
correct today only by accident; the binding constraint is "clear before `fn()`".
*Resolution*: I2.2 restated against the `fn()` landmark; technical approach rewritten
to separate the two requirements (unconditional vs. before-any-exit); C2 gained a
re-entrant-`onDismiss` acceptance criterion and test T12's Kind-B mutation.

**F-Func-2 — Major — RESOLVED.** C3 enumerated six consumers and asserted completeness;
the code-derived set has seven. `src/__tests__/content/cc-identity-detector.test.ts`
was missing — a genuine behavioural consumer that mocks the module and reads the
captured options to drive `onSelect`. *Verified independently.* *Resolution*: Consumer 7
added with the same treatment as Consumer 6; the reproducing grep is now printed in the
plan so the enumeration is code-derived on its face.

**F-Func-3 — Major — RESOLVED.** Consumer 4's rationale claimed all three detectors
clear `currentContext` on dismiss. Only LOGIN has `currentContext` (`:342`); CC and
IDENTITY use `activeInput` (`cc:308`, `identity:354`). *Verified independently.* The
conclusion was right, the reason false for two of three subjects — R29's "false reason
under a true conclusion" class, in the one walkthrough the plan called design-
constraining. *Resolution*: split into Consumers 4a/4b with the shared conclusion
stated once; FR4 corrected to name both state variables.

**F-Func-4 — Major — RESOLVED.** Six `file:line` citations pointed at the wrong lines.
*Verified independently:* `makeOptions` is at `:39` not `:97-115` (the range the testing
strategy told the implementer to edit); `AUTO_DISMISS_MS` at `save-banner.ts:11` not
`:24`; manifest `content_scripts` at `:63-70` not `:61-68`; `web_accessible_resources`
at `:71-76` not `:69-74`; `blurHandler` at `:510-518`; LOGIN `onDismiss` at `:415-417`.
NFR1's *conclusion* was independently confirmed correct despite the wrong citation.
*Resolution*: all six corrected.

**F-Func-5 — Minor (question) — ANSWERED IN PLAN.** Message branches never reset
`itemElements`/`activeIndex`; C1's restructure makes `hideDropdown`'s conditional reset
load-bearing. No reachable path was found where `itemElements` survives into a message
render. *Resolution*: T5 now asserts `defaultPrevented === false` in message states,
which distinguishes "fell through untouched" from "handled then returned false" — the
property that would actually break.

**F-Func-6 — Minor — RESOLVED.** Auto-dismiss tests were blind to FR4's
listener-removal clause. *Resolution*: T13 added (see F-Test-5, same root cause).

**F-Func-7 — Minor `[Adjacent]` — DEFERRED as SC6.** `hideDropdown` invokes `onDismiss`
unwrapped while the module's other two cross-boundary calls are wrapped. Cost-
justification recorded: all three current callbacks are bare assignments that cannot
throw, so the exposure is latent; wrapping would change error semantics across all 18
dismissal call sites.

**F-Func-8 — Minor `[Adjacent]` — DEFERRED, SC5 scope widened.** SC5's `role="listbox"`
deferral addressed the static a11y wart, not the live-region concern FR2's auto-dismiss
newly introduces. Recorded rather than silently carried.

## Security Findings

**F-Sec-1 — Minor — RESOLVED (upgraded in treatment).** The `Escape` case has no
`isTrusted` guard, unlike the `Enter` case (`:192`) and the mouse path (`:45-51`). C1
is what makes it reachable in message states, so the exposure is *created by this
change*. Two consequences, **both probed and confirmed**: a page script can dispatch a
synthetic Escape to suppress the locked / no-match indicator (a UI-integrity signal for
a password manager), and it can read `e.defaultPrevented` on its own event object to
learn dropdown presence and — given C2's deliberate message-vs-entries timer asymmetry —
distinguish vault-locked from entries-present. *Resolution*: new invariant I1.4 (Escape
denies untrusted events without `preventDefault` and without dismissing), two acceptance
criteria, test T15, and a Kind-B mutation. The plan records that the hardening is
partial by construction — blur still suppresses the dropdown — and that the value is
consistency with the module's own two existing trust boundaries.

**F-Sec-2 — Minor (question) — ANSWERED.** Could the timer race a message→entries
re-show and tear down a list mid-selection? The design handles it via I2.2, but no test
covered the transition (T11 covered message→message only). *Resolution*: T14 added as
an explicit acceptance criterion.

**F-Sec-3 — Minor `[Adjacent]` — RESOLVED.** T5 pinned a return value, not I1.1's
non-indexing invariant. Merged with F-Func-5; same fix.

Clean checks worth recording: the closed shadow root (`mode:"closed"`, random-token
attribute) means the timer's teardown is not observable as DOM mutation, so the timer
adds no fingerprinting channel beyond F-Sec-1's; the visual-safety gates
(`isPageVisuallySafe` / `isElementVisuallySafe` / `isInputHitTestSafe` /
`hasVisiblePopoverOverlayNear`) run at `requestMatches` time and are untouched;
auto-dismiss marginally *helps* against overlay attacks by shortening the on-screen
window; RS3/RS6 clean — `escapeHtml` untouched, messages are i18n-sourced not
page-controlled.

## Testing Findings

**F-Test-1 — Critical — RESOLVED.** The plan's fake-timer claim was inverted. Vitest 4's
default `toFake` set includes `requestAnimationFrame`, so `advanceTimersByTime(5000)`
runs the pending rAF and installs the real `outsideClickHandler` on `document` mid-test.
**Independently probed and confirmed** (`rafRan after advance: true`). *Resolution*:
the block now specifies `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })`,
pinned by an assertion that no `mousedown` listener is registered during a clock
advance; the wrong belief and its correction are both recorded in the plan.

**F-Test-2 — Critical — RESOLVED.** T5, T7, T9, T10 pass on unfixed `main` — vacuous,
and with no prove-red obligation covering them. **I re-ran all four myself against
current `main`: all four green.** The plan's own diagnosis of the shipped bug is that
`:125` passed vacuously; the plan reproduced the class. *Resolution*: the prove-red
section is split into **Kind A** (red against unfixed `main` — genuine regression tests)
and **Kind B** (red against a *named mutation of the fix* — guard-preservation tests),
with a mandatory mutation per Kind-B row, each run and observed separately, plus a
mandatory full-suite green after every mutation-revert.

**F-Test-3 — Major — RESOLVED.** T11's aggregate `onDismiss` count cannot detect the
orphaned-timer bug it claims to pin: with an orphan, the second show fires `o1`, the
orphan fires `o2` and nulls the callback, the legitimate timer fires nothing — aggregate
is two either way. The discriminator is *when*, not *how many*. *Resolution*: T11
respecified with per-mock counts, a 3000 ms gap between the two shows (separating the
orphan's t=5000 deadline from the legitimate t=8000), and a checkpoint at t=7999.

**F-Test-4 — Major — RESOLVED.** A describe-scoped `vi.useRealTimers()` was measured to
leak fake timers into subsequent tests when an auto-dismiss test *fails* — RT11, fixture
outliving its own run on the failure path, converting one real failure into a cascade.
*Resolution*: moved to the file-level `afterEach` at `:60-63`, unconditional and ordered
before `hideDropdown()`. Noted that `vitest.config.ts` sets neither `restoreMocks` nor
`unstubGlobals`, so there is no config-level net.

**F-Test-5 — Major — RESOLVED.** Nothing pinned I2.3. A hand-rolled timer teardown
(`currentDropdown = null; currentOnDismiss?.()`) passes T8/T10/T11/T12 while leaking the
outside-click listener and the shadow-root children — the exact failure Consumer 4's
walkthrough identifies as design-constraining, guarded only by a forbidden-pattern grep
that catches one spelling. *Resolution*: T13 added, spying on
`document.addEventListener`/`removeEventListener` (observable outside the closed shadow
root), asserting removal exactly once and that the manual path produces the identical
call.

**F-Test-6 — Minor — RESOLVED.** T4 duplicated the existing `:125-132` test. The entries
axis was never the untested one. *Resolution*: T4 restated as "keep `:125` unchanged and
confirm it stays green post-fix", with an explicit instruction not to write a duplicate.

**F-Test-7 — Minor (question) — ANSWERED.** Would the interval constant be exported so
tests compute the boundary from it, or hardcoded? *Resolution*: exported; tests import it
and compute `CONSTANT` / `CONSTANT - 1` (RT3), and the export arrives with its consuming
tests (RT6).

**F-Test-8 — Minor `[Adjacent]` — RESOLVED.** The `window.setTimeout` rationale cited
`save-banner.ts` as the sibling to match while that file does the opposite (bare
`setTimeout` with `ReturnType<typeof setTimeout>`). *Resolution*: the plan now follows
`save-banner.ts` — the auto-dismiss sibling — and records that the previous conclusion
was defensible but its stated reason false.

## Adjacent Findings

Routed and dispositioned above: F-Func-7 (→ SC6, deferred), F-Func-8 (→ SC5 scope
widened), F-Sec-3 (→ merged with F-Func-5, resolved), F-Test-8 (→ resolved).

## Quality Warnings

None. The `merge-findings` quality gate (VAGUE / NO-EVIDENCE / UNTESTED-CLAIM) could not
run — Ollama unavailable. Manual substitute applied: every Critical and Major finding
above was independently re-verified against source or by execution before acceptance,
and the verification method is named per finding. Three findings were re-run as probes
(`rAF` faking, the four vacuous tests, the `defaultPrevented` oracle); five were checked
by reading the cited lines (`makeOptions`, `AUTO_DISMISS_MS`, manifest ranges,
`currentContext`/`activeInput`, the seventh consumer).

## Round 1 disposition

| Severity | Count | Resolved in plan | Deferred with cost-justification |
| --- | --- | --- | --- |
| Critical | 2 | 2 | 0 |
| Major | 4 | 4 | 0 |
| Minor | 13 | 11 | 2 (SC5 widened, SC6 new) |

No Critical or Major finding is open. Both deferrals are Minor, `[Adjacent]`, and carry
Anti-Deferral entries naming the owner and the cost on both sides.

## Recurring Issue Check

### Functionality expert

R1-R28 n-a or checked-clean (no dead code, no magic strings, no schema/migration/i18n
surface, no `any`, no floating promise, `hideDropdown` idempotency verified at test
`:98-100`). R29 **finding-raised** (F-Func-4 six mis-cited ranges; F-Func-3 false
rationale). R30-R41 checked-clean (SC1-SC6 carry cost-justifications; NFR1 conclusion
verified; VC3/SC1 handled honestly). R42 **finding-raised** (F-Func-2: code-derived
consumer set has 7, plan listed 6). R43 checked-clean (NFR3/I1.2/T6 preserve the `Enter`
guard). R44-R51 checked-clean (C1/C2 declare control class; decisions bind to the branch
object). R52 **finding-raised, partial** (plan pre-flagged it; F-Func-5 records the
residual). R53-R57 checked-clean (`number | null` timer handle cannot collide).

### Security expert

R1-R37 n-a or checked-clean. R38 **finding-raised** (F-Sec-2: timer async state,
message→entries re-show unpinned). R39-R42 n-a. R43 **finding-raised** (F-Sec-1: Escape
reachability widens an untrusted-event surface). R44-R46 n-a. R47 checked-clean (`Enter`
adjudicates on `Event.isTrusted` — interpreter-supplied, not surface-form). R48 n-a.
R49 checked-clean (C1/C2 control classes verified accurate against source; nothing leans
on C2 as a boundary). R50 n-a. R51 checked-clean. R52 **finding-raised** (F-Sec-1:
`Enter` re-audit adequate, Escape's reach extended without re-audit). R53-R54 n-a.
R55 checked-clean. R56-R57 n-a.
RS1 n-a. RS2 n-a. RS3 checked-clean. RS4 checked-clean. RS5 checked-clean.
RS6 checked-clean.

### Testing expert

R1-R57: R2 checked-clean (constant named; scoping raised as F-Test-7). R34 checked-clean.
R43 checked-clean. R49 checked-clean. R52 checked-clean. Remainder n-a.
RT1 checked-clean (both wholesale-mocking test files verified to never call the real
`showDropdown`). RT2 checked-clean (every finding is testable from outside the closed
shadow root; F-Test-5's remedy uses document-level spies, not shadow-root queries).
RT3 **finding-raised** (F-Test-7). RT4 checked-clean. RT5 checked-clean (tests call the
real primitives). RT6 **finding-raised** (F-Test-7: exported constant needs its test
consumer). RT7 **finding-raised** (F-Test-2: prove-red omitted T5/T7 and conflated
red-against-main with red-against-mutation). RT8 **finding-raised** (F-Test-3 aggregate
count; F-Test-5 status-without-mutation). RT9 checked-clean (single singleton, no twin
to drift). RT10 **finding-raised** (F-Test-2 T5/T7 cannot fail; F-Test-6 T4 duplicates).
RT11 **finding-raised** (F-Test-4, measured).

## Verification-constraint classification

| Contract | Classification | Basis |
| --- | --- | --- |
| C1 (all criteria) | `verifiable-CI` | Expressible against the exported surface under jsdom; the existing suite proves the pattern, including the `isTrusted` Proxy workaround at `:136-145` |
| C2 (timer criteria) | `verifiable-CI` | Via fake timers with the corrected `toFake` set; T13 closes the FR4 gap that made this partial |
| C2 real-browser | `blocked-deferred` (VC1) | No Playwright/Puppeteer harness, no headless-Chrome extension job in CI; covered by M1-M5 |
| SC1 click-to-unlock | deferred (VC3) | `chrome.action.openPopup()` gesture propagation genuinely unmeasured; deferral adds no regression over today |

## Round 2 assessment

Not run. Round 1 resolved every Critical and Major finding, and the saturation criterion
is deliberately **not** claimed — it requires at least two completed rounds, so it cannot
fire here. Proceeding to Phase 2 is a judgment call on the evidence, recorded as such:
all three experts' remaining findings are Minor; no finding was against the design; the
change is 2 edits in 1 file with 15 tests; and the two Criticals were both about the
*plan's own test design*, which Phase 2's mandatory prove-red execution will re-verify by
running the mutations rather than by reasoning about them. Should Phase 2 execution
contradict any Kind-A/Kind-B expectation in the table, that is a Round-2 input.
