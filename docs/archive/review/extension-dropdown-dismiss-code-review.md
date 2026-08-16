# Code Review: extension-dropdown-dismiss

Date: 2026-08-17
Review round: 1

## Changes from Previous Round

Initial code review. Three expert sub-agents reviewed `git diff main...HEAD` in parallel,
as incremental verification on top of the Phase 2 Step 2-5 self-R-check baseline (which
had returned no code findings). Ollama was unavailable, so seed generation and
`merge-findings` were both skipped — deduplication below is the documented manual
fallback, joined by hand on the experts' JSON findings indexes.

The testing expert ran **15 independent mutations** and the functionality expert ran
several more, all against the real production file with scratchpad restore. Both
verified the tree clean afterwards.

## Summary

8 findings: **1 Major, 7 Minor** (2 `[Adjacent]`). All resolved. No Critical.

The Major is the notable one, and it is the same defect class this whole change is
about: **a real behaviour with no test able to fail for it.**

## Functionality Findings

**F-Func-1 — Major — RESOLVED.** FR4's "shadow-root children are removed" clause was
pinned by nothing, while the plan claimed all four clauses were pinned by T13 and
T8/T11/T12. Those tests assert only `isDropdownVisible()` and `onDismiss` counts;
`isDropdownVisible()` reads a module variable (`currentDropdown !== null`) and never
inspects the shadow root.

*Verified by execution, independently:* deleting the `while (root.firstChild)` drain
loop from `hideDropdown()` left **all 1007 tests green**. The consequence is not
cosmetic — `showDropdown` appends a fresh `<style>` and `.psso-dropdown` on every call,
so a teardown that skips the drain stacks one stale dropdown per show. That is the
reported bug made worse, and the only thing preventing it was an untested loop.

*Resolution:* added **T16** — asserts the shadow root is drained after auto-dismiss
**and** after a manual `hideDropdown()`, so the two paths are shown to agree rather than
the timer path merely doing something. Allow side included (root non-empty while the
dropdown is up), so the test cannot pass by the dropdown never rendering. VC2 does not
block it: the test imports `getShadowHost()` directly rather than querying into the
closed root. **Prove-red executed:** mutation I (delete the drain loop) reddens exactly
T16 and nothing else. The plan's false FR4 sentence is corrected in the same change.

**F-Func-2 — Minor — RESOLVED.** D4's equivalent-mutant conclusion was correct but its
stated reason was incomplete: it argued from "one null-assignment site" and "arming
happens after `currentDropdown` is set", which does not close the case, because
`hideDropdown()` is re-entrant via `fn()` and that inner entry occurs *after*
`currentDropdown` has been nulled — exactly the state D4 called unreachable. What
actually decides it is one step further in (no timer is armed at that inner entry
either). *Resolution:* the deviation log now names the re-entrancy step, since that is
the step a future edit would break.

## Security Findings

**F-Sec-1 — Minor (question) — ANSWERED, deferred as SC7.** `outsideClickHandler` is
assigned inside a `requestAnimationFrame` callback, but `hideDropdown()` removes it only
`if (outsideClickHandler)`. A dismissal landing between `showDropdown()` returning and
the rAF firing strands a capture-phase `mousedown` listener on `document` forever.
**Pre-existing on `main`** (identical rAF and identical guard), and unreachable from the
timer path — 5000 ms is three orders of magnitude beyond a frame. The reachable paths
(`suppressInline`, SPA `navigationHandler`) are unchanged from `main`. Recorded as SC7
with cost-justification rather than fixed, because the fix (`cancelAnimationFrame` plus a
module-level handle) changes teardown semantics on all 18 external `hideDropdown()` call
sites — wider than the defect being fixed, in a PR the user framed around three messages.

**F-Sec-2 — Minor — RESOLVED.** `hideDropdown` was passed bare to `setTimeout`, so it
receives whatever arguments the host supplies. Harmless today (`hideDropdown(): void`
declares no parameters — verified, and a probe measured zero args passed), but it becomes
live the moment `hideDropdown` gains an optional parameter. The sibling this change
imitates, `save-banner.ts:84`, wraps its callback. *Resolution:* wrapped in an arrow.
Mutation E re-run after the change still reddens 3 tests, so the wrap is red-proof-neutral.

**F-Sec-3 — Minor `[Adjacent]` — DEFERRED, SC5 scope widened.** A `role="listbox"` that
vanishes after 5 s without user action is a WCAG 2.2.1 (Timing Adjustable) concern on the
screen-reader path. Unlike SC5's static `role` wart, this dimension *is* introduced here.
Recorded against SC5, whose named owner (a future a11y pass) is unchanged.

Security verification worth recording, all executed rather than inspected: the `Enter`
`isTrusted` guard and `isSafeSelectClick` are **byte-identical to `main`** (`git show`
comparison); the diff contains **zero `innerHTML` lines**, so sanitization is untouched;
the new Escape guard genuinely closes both exposures it was added for, pinned in all four
render states. The `ArrowDown` `defaultPrevented` oracle is pre-existing and this change
*narrows* it (the new per-case guards return before `preventDefault` in message states).
The timer cannot interfere with a fill: arming (message-only branches) and filling
(`onSelect`, bound only to entries-branch items) are mutually exclusive by construction.

## Testing Findings

**F-Test-1 — Minor — RESOLVED.** The plan mandated a pin on the `toFake` scoping ("one
auto-dismiss test asserts `document.addEventListener` was **not** called with
`mousedown`"); that assertion was never written. *Verified by execution:* replacing the
helper with a bare `vi.useFakeTimers()` left all 39 tests green — so the regression the
plan wrote three paragraphs to prevent was invisible to the suite. *Resolution:* added
that test. **Prove-red executed:** mutation J (bare `useFakeTimers()`) reddens exactly it.

**F-Test-2 — Minor — RESOLVED.** The deviation log's prove-red table recorded mutation E
as reddening 2 tests; the actual count is 3. The third is the test D4 says was kept on
its own merit — evidence it earns its place. The count was taken before that test landed
and not refreshed. *Resolution:* corrected, and the extra test named. This is a
documentation-accuracy defect in the one record whose purpose is to state what was
*observed*, which is D6's lesson exactly.

**F-Test-3 — Minor — RESOLVED.** `MESSAGE_AUTO_DISMISS_MS` was absent from the three
wholesale `vi.mock` factories. No live breakage (no detector imports it — verified), but
latent drift: the day one does, the mock returns `undefined` and fails far from its
cause. *Resolution:* added to both factories.

**The headline testing result: no vacuous test was found among the 39.** Given that
vacuity is this change's central risk — the original bug and two plan-review Criticals
were all of that class — that conclusion, established by 15 mutations rather than by
reading, is the most load-bearing thing in this review. Also cleared by execution: each
of the three `isMessageOnly` branches carries its own coverage (1/2/3 tests reddened
individually); the ArrowUp per-case guard is independently pinned (3 tests); RT8 is
satisfied (return value and mutation pinned separately); RT11 holds under three shuffle
seeds.

## Adjacent Findings

F-Sec-3 (a11y timing → SC5, deferred). The functionality expert also flagged D3's
constant-derivation tension and the Escape `isTrusted` rationale as `[Adjacent]`; both
were already resolved in Phase 2 and were confirmed sound.

## Quality Warnings

None. The `merge-findings` quality gate could not run (Ollama unavailable). Manual
substitute: the Major finding was independently re-verified by execution before
acceptance — I deleted the drain loop myself and observed 1007 green. Both new tests were
prove-red executed against their own mutation and confirmed to redden nothing else.

## Environment Verification Report

Phase 1 declared three constraints (VC1-VC3). Classification per contract:

| Path | Classification | Basis |
| --- | --- | --- |
| C1 all acceptance criteria | `verified-CI` | `npx vitest run` in `extension/` — 1009 passed / 61 files |
| C2 timer criteria incl. T13/T16 | `verified-CI` | Same run; fake timers with scoped `toFake`, now itself pinned |
| C2 real-browser confirmation (M1-M5) | `blocked-deferred` | **VC1** — no Playwright/headless-Chrome extension harness exists in this repo (re-verified this round). Manual test plan M1-M5 is executable locally by the developer; Anti-Deferral cost-justification at VC1 in the plan |
| SC1 click-to-unlock | `blocked-deferred` | **VC3** — `chrome.action.openPopup()` gesture propagation unmeasured; Anti-Deferral entry at SC1 |
| SC7 rAF listener-stranding window | `blocked-deferred` | New this round; Anti-Deferral entry at SC7, pre-existing on `main` and unreachable from the timer path |

VC2 (closed Shadow DOM) was **not** limiting after all: T16 reaches the shadow root by
importing `getShadowHost()` directly. The Phase 1 statement that VC2 constrains the
*shape* of tests but not their power held up, and this round exercised it.

## Recurring Issue Check

### Functionality expert

R1/R2 checked-clean (`MS_PER_SECOND` reused, constant named + exported). R8 (resource
leak) **finding-raised** — F-Func-1's untested DOM-drain class. R18 (docs drift)
**finding-raised** — the false FR4 sentence. R19 checked-clean (4 test files re-derived;
`passkey-dropdown.test.ts` greps the symbol but is comment-only, not a consumer). R21
checked-clean (tree verified clean after every mutation). R23/R28 checked-clean (the
Escape return-value change is discarded by all three callers — verified by reading all
three). R29 checked-clean (every citation and count re-run; table in the expert output).
R42 checked-clean (both greps re-run at Phase 3, not carried forward). R43 checked-clean
(`Enter` guard intact). R52 checked-clean. R57 **finding-raised** — F-Func-2, deviation
rationale gap. Remainder n-a or checked-clean.

### Security expert

R10/RS3/RS6 checked-clean (zero `innerHTML` lines in the diff; `escapeHtml` wraps every
interpolation). R16 checked-clean (vault-unlock race traced, benign in both orderings).
R17 **finding-raised** — F-Sec-1, pre-existing rAF window. R27 **finding-raised** —
F-Sec-3, a11y timing. R29 checked-clean (all greps and counts reproduced independently).
R43/R44/R45 checked-clean (both `isTrusted` guards fail closed; three trust boundaries
now aligned). R49 checked-clean (C1 fail-closed gate, C2 detection-only). R51
checked-clean (`e.isTrusted` is interpreter-supplied, not a surface heuristic). R53
checked-clean (Escape's oracle closed; ArrowDown's is pre-existing and narrowed). R54
checked-clean (closed Shadow DOM, random-token host, visual-safety helpers unchanged; the
timer *reduces* overlay dwell time). RS1/RS2/RS4/RS5 n-a.

### Testing expert

RT1/RT2 checked-clean. RT3 checked-clean (D3's pin resolves the derivation tension
without over-coupling — one assertion against twelve derived usages). RT4
**finding-raised** — F-Test-1, `toFake` unpinned. RT6 checked-clean. RT7 checked-clean
(prove-red executed; 15 further mutations this round). RT8 checked-clean (cleared by
three separate mutations). RT9 **finding-raised** — F-Test-3, mock drift. RT10
checked-clean (every new guard has both sides: Escape trusted/untrusted × 4 states,
ArrowDown/ArrowUp empty/populated, `isMessageOnly` message/entries). RT11 checked-clean
(three shuffle seeds, no order dependence). R21 **finding-raised** — F-Test-2, stale
mutation count.

## Resolution Status

### F-Func-1 · Major · FR4's shadow-root-drain clause unpinned
- Action: added T16 (`empties the shadow root, identically to a manual dismiss`), pinning
  auto-dismiss and manual paths against each other with an allow-side assertion. Corrected
  the plan's false FR4 claim.
- Modified: `extension/src/__tests__/content/ui/suggestion-dropdown.test.ts:301-320`,
  `docs/archive/review/extension-dropdown-dismiss-plan.md` (FR4)
- Red-proof: mutation I (delete the `while (root.firstChild)` loop) ⇒ T16 fails, alone.

### F-Func-2 · Minor · D4 rationale omits the re-entrancy step
- Action: deviation log D4 now names the `fn()` re-entrancy path as the deciding step.
- Modified: `docs/archive/review/extension-dropdown-dismiss-deviation.md` (D4)

### F-Sec-1 · Minor · rAF listener-stranding window
- Action: **Skipped — deferred as SC7** with Anti-Deferral cost-justification.
  Worst case: unbounded accumulation of capture-phase `document` listeners on an SPA that
  navigates repeatedly with an input focused; each adds one `composedPath()` per
  `mousedown`. No credential exposure — the stranded closure only calls `hideDropdown()`.
  Likelihood: unreachable from the timer path this PR adds (5000 ms vs a ~16 ms frame);
  reachable only via paths unchanged from `main`. Cost to fix: changes teardown semantics
  across all 18 external `hideDropdown()` call sites, needing its own test matrix — wider
  than the defect this PR fixes. Owner: a future teardown-lifecycle pass.

### F-Sec-2 · Minor · bare `hideDropdown` as `setTimeout` callback
- Action: wrapped in an arrow, matching `save-banner.ts:84`.
- Modified: `extension/src/content/ui/suggestion-dropdown.ts:155`
- Red-proof: mutation E re-run after the change still reddens 3 tests (unchanged).

### F-Sec-3 · Minor `[Adjacent]` · `role="listbox"` auto-removal (WCAG 2.2.1)
- Action: **Skipped — SC5 scope widened** to name the timing dimension. Worst case: a
  screen-reader user may still be hearing the message announced when it is removed at 5 s;
  affects the three message states only (the entries state arms no timer). Likelihood:
  every screen-reader encounter with a message state. Cost to fix: an ARIA semantics
  change (likely `role="status"` for message states) altering announcement behaviour, needing
  screen-reader verification that VC1's constraint class also blocks. Owner: the future
  a11y pass SC5 already names.

### F-Test-1 · Minor · `toFake` scoping unpinned
- Action: added `does not install the outside-click listener while the clock advances`.
- Modified: `extension/src/__tests__/content/ui/suggestion-dropdown.test.ts:277-292`
- Red-proof: mutation J (bare `vi.useFakeTimers()`) ⇒ that test fails, alone.

### F-Test-2 · Minor · prove-red table understated mutation E
- Action: corrected 2 → 3 and named the third test.
- Modified: `docs/archive/review/extension-dropdown-dismiss-deviation.md` (prove-red table)

### F-Test-3 · Minor · constant absent from wholesale mocks
- Action: added `MESSAGE_AUTO_DISMISS_MS` to both `vi.mock` factories.
- Modified: `extension/src/__tests__/content/form-detector-inline.test.ts:14`,
  `extension/src/__tests__/content/cc-identity-detector.test.ts:16`

## Verification after fixes

| Gate | Result |
| --- | --- |
| `npx vitest run` (extension) | **1009 passed / 61 files** (+2 new tests) |
| `npx tsc --noEmit` (extension) | clean |
| `npm run lint` (repo, `--max-warnings 0`) | clean |
| `npm run build` (extension) | clean, dist hygiene passed |
| Contract greps | combined guard absent; 2 per-case guards; 3 `isTrusted` boundaries |
| Worktree | clean — every mutation restored and verified |

## Round 2 assessment

Not run. Every finding is resolved or carries an Anti-Deferral entry; the only Major is
fixed and red-proven. The two deferrals are Minor, `[Adjacent]`-class, pre-existing or
a11y-scoped, with named owners. Both fixes that touched code were prove-red executed
against their own mutation and confirmed to redden nothing else, and the full suite is
green — so a Round 2 would be reviewing documentation edits and two tests whose failure
modes have already been demonstrated.
