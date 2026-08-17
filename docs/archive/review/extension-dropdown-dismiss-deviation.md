# Coding Deviation Log: extension-dropdown-dismiss

## D1 — Timer arming moved out of the message branches (design refinement, not a contract change)

**Plan text**: "Arming it in the three message branches rather than gating on
`itemElements.length === 0` after the fact keeps the condition co-located with the
branch that decides it."

**As implemented**: each message branch sets a local `isMessageOnly = true`; the single
`setTimeout` call sits after `currentDropdown` / `currentOnDismiss` / `currentOnSelect`
are assigned.

**Reason**: arming inside the branches would arm before `positionDropdown()` and
`root.appendChild()` run. A throw in either would leave a live timer pointing at a
dropdown that was never shown, and the timer would then fire `hideDropdown()` against
unrelated state. The plan's stated *intent* — the decision lives with the branch that
makes it — is preserved by the per-branch flag; only the arming point moved, to after
the dropdown is actually live. I2.1 (armed iff message-only) is unaffected and is
pinned by T10 plus mutation E.

## D2 — Interval constant uses `MS_PER_SECOND`

The plan said "a named module constant". Step 2-1's shared-utility inventory found
`MS_PER_SECOND` at `extension/src/lib/time.ts:2`, already used by the auto-dismiss
sibling (`save-banner.ts:7,11` → `15 * MS_PER_SECOND`). Implemented as
`5 * MS_PER_SECOND` rather than a bare `5000`, per R1/R2 reuse. Not a deviation from
intent; recorded because the plan named the constant without naming its unit source.

## D3 — Added a test the plan did not list: the constant's value is pinned directly

**Discovered by prove-red, and it is the reason the mutation pass exists.** Mutation D
set the interval to `5 * MS_PER_SECOND - 1` and **no test failed**. Cause: T8/T9 derive
their boundary from `MESSAGE_AUTO_DISMISS_MS` (RT3 — so they never drift from the
shipped value), which means shrinking the constant moves the assertions with it. The
two obligations are in genuine tension: importing the constant prevents drift but
also prevents the tests from detecting a change to it.

Resolution: keep the derived boundaries (RT3 satisfied) and add one test asserting
`MESSAGE_AUTO_DISMISS_MS === 5000` directly. Re-ran mutation D: now reddens exactly
that one test. Recorded because the plan's test list would have shipped an unpinned
constant.

## D4 — Mutation G is an equivalent mutant; no test was added for it

The plan's I2.2 requires the timer clear be unconditional, not nested inside
`if (currentDropdown)`. I mutated the code to nest it and **no test failed**. Rather
than invent a test shape to force a failure, I checked reachability: `currentDropdown`
is assigned `null` at exactly one place (`suggestion-dropdown.ts:188`), inside that same
block, and the timer is armed only after `currentDropdown` is set (`:147`, `:154-156`).
So `autoDismissTimer !== null && currentDropdown === null` is unreachable, and the
nested form is **semantically equivalent** to the unconditional one — not an unpinned
defect. An equivalent mutant cannot be killed by any test, and adding one that appeared
to kill it would have been the vacuous-test defect this plan exists to avoid.

Two speculative tests written during this investigation were reverted for exactly that
reason. One was kept, on its own merit rather than as a mutation-killer: *"does not
dismiss an entries dropdown put up by an onDismiss callback"* — it pins real behaviour
(FR3 across the re-entrancy path) and passes honestly. Phase 3 confirmed it earns its
place independently: it is one of the three tests mutation E reddens.

**Completing the reachability argument.** The two facts above — one null-assignment
site, arming only after `currentDropdown` is set — are not sufficient on their own,
because `hideDropdown()` is re-entrant through `fn()` at `:195`, and that inner entry
happens *after* `:188` has already nulled `currentDropdown`. So the state D4 calls
unreachable is in fact reached, on that path. What closes the argument is one step
further in: at that inner entry no timer is armed either, since the outer clear has
already fired and `showDropdown`'s own arm cannot have run yet. Verified by probe in
Phase 2 and independently in Phase 3. Recorded because the re-entrancy step is the one
a future edit would break — an `onDismiss` that arms a timer by some route other than
`showDropdown` would make the nested form leak while the unconditional form stays
correct, which is the second reason to keep the unconditional placement.

The unconditional placement is retained regardless: it is the form that stays correct if
a future edit arms a timer on a path where `currentDropdown` is null, and I2.2's real
constraint (clear *before* the `fn()` re-entrancy point) **is** pinned — mutation F
moves the clear after `fn()` and reddens two tests.

## D5 — T13 fakes `requestAnimationFrame` deliberately, against the block default

The plan mandates `toFake: ["setTimeout", "clearTimeout"]` for the auto-dismiss block so
the outside-click listener is never installed mid-test. T13 is the one test that *needs*
it installed — it asserts the listener is removed. It therefore adds
`"requestAnimationFrame"` to its own `toFake` list and drives it with
`vi.advanceTimersToNextFrame()`.

An earlier attempt kept real timers for the rAF and switched to fake timers afterwards;
that failed, because switching resets the clock and the already-armed `setTimeout` never
fired under the new one. Recorded so the next reader does not retry it.

## Prove-red results (Phase 2 obligation, all executed and observed)

Each mutation was applied to a scratchpad-restored copy of the real file, the suite run,
and the file restored from a pristine copy. No mutation was left in the tree — verified
by `git diff --stat` after each.

| Mutation | Reddens | Observed |
| --- | --- | --- |
| A: drop the Escape `isTrusted` guard | 4 tests (T15 ×3 states + entries state) | PASS |
| B: trusted Escape returns false without dismissing | 4 tests (T1-T3 + T4) | PASS |
| C: drop the `ArrowDown` per-case length guard | 3 tests (T5 ×3 states) | PASS |
| D: interval `− 1` (before D3's fix) | **nothing — gap found** | fixed, see D3 |
| D2: interval `− 1` (after D3's fix) | 1 test (constant value) | PASS |
| E: arm the timer unconditionally | 3 tests (T10, T14, and the onDismiss-reshow case) | PASS |
| F: move the clear after the `fn()` re-entrancy point | 2 tests (T11, T14) | PASS |
| G: nest the clear inside `if (currentDropdown)` | **nothing — equivalent mutant** | see D4 |
| H: hand-rolled teardown in the timer callback | 1 test (T13) | PASS |

Allow side, per the Remedy Floor: after every mutation-revert the full extension suite
was re-run green — **1007 tests in 61 files**, including the three test files that mock
the dropdown module wholesale (R19 parallel-test-tree check).

## Verification

All rows below were re-run against clean HEAD (`11fdca80`) after the mutation pass
finished, not inferred from a run taken during it. See D6 for why that distinction is
recorded rather than assumed.

| Gate | Result |
| --- | --- |
| `npx vitest run` (extension) | 1007 passed / 61 files |
| `npx vitest run` (repo root) | 14650 passed, 6 skipped / 1009 files |
| `npx tsc --noEmit` (extension) | clean |
| `npm run lint` (repo, `--max-warnings 0`) | clean |
| `npm run build` (extension) | clean, dist hygiene check passed |
| `npx next build` (repo) | Compiled successfully, 243/243 static pages |
| Contract conformance greps (4 forbidden patterns) | all absent |
| Files changed | 2 code + 2 docs in the implementation commit (plan, deviation); the review artifact landed in the plan commit |

## D6 — A self-check agent observed a live mutation; recorded rather than dismissed

The Phase 2-5 functionality self-check filed an R21 Major: it ran the extension suite
and saw 3 failures with `MESSAGE_AUTO_DISMISS_MS = 5 * MS_PER_SECOND - 1` live in the
tree — mutation D, mid-flight.

**Assessment: a true observation of a transient state, not residue.** The agent was
launched while the prove-red pass was still running, so its suite run fell inside a
mutation's apply→restore window. The committed state was never affected:
`git show HEAD:…/suggestion-dropdown.ts` reads `5 * MS_PER_SECOND`, and
`git diff HEAD -- extension/` is empty. The agent itself observed the tree return to
green at HEAD minutes later and said so.

**The part that was a real defect**: gate rows were added to the table above while
that window was open, and a "3 docs" file count was wrong. Both are corrected — every
row re-run against clean HEAD, and the count fixed. The agent was right that a
verification record must state what was observed at a known-clean revision rather than
what was expected to be true.

**Process lesson, since this is the second time the same shape appeared in this
change**: do not run verification agents concurrently with a mutation pass that edits
the tree they read. The prove-red pass is destructive by design and must own the
worktree exclusively for its duration.

No detector file was modified, no message file, no `.js` mirror — as FR6/NFR1/NFR2
predicted.

## D7 — SC7 reopened and fixed after an external security review refuted its premise

Phase 3 deferred the rAF listener-stranding window as SC7, reasoning that the timer path
could not reach it because 5000 ms ≫ one frame. A follow-up security review pointed out
that this holds only while rAF is running: **Chrome pauses `requestAnimationFrame` in a
background tab while timers keep running**, so the auto-dismiss becomes the *expected*
winner of that race, not an impossible one.

Reproduced by probe (fake `setTimeout`, real rAF — the hidden-tab ordering):
`installed=1, removed=0`. Fixed by retaining the frame handle and cancelling it in
`hideDropdown()`. The same review found the countdown ignored `visibilityState`, letting
a "Vault locked" notice expire unread behind a switched-away tab — fixed by measuring
visible time only.

Six tests added, three mutations run (K: drop `cancelAnimationFrame`; L: revert to a
plain timer; M: leak the visibility watcher), each reddening its own tests. Mutation K
reddens the allow-side test too, confirming the pair brackets the behaviour rather than
only tightening.

**The lesson worth keeping**: SC7's cost line was right and its likelihood line rested on
an assumption nobody measured. Three expert reviews passed over it. When a deferral turns
on "this path is unreachable", the reachability claim needs a probe, not an argument.

## D8 — Two optional visibility tests added after Round 2 approval

The Round 2 security review approved the fix and noted two further cases as optional:
"already hidden at show time" and "repeated hidden/visible round-trips". Both were added
rather than skipped — the second in particular, because `remaining` is an accumulator and
nothing else pinned its arithmetic across more than one cycle.

Neither was accepted on the strength of passing. Prove-red:

| Mutation | Reddens |
| --- | --- |
| N: `arm()` unconditionally, ignoring initial hidden state | the "already hidden" test, alone |
| O: re-arm with the full interval instead of `remaining` | 4 tests incl. the existing hidden-state trio |
| P: never debit elapsed visible time when hiding | 4 tests incl. the new round-trip test |

The review's assessment that "the current implementation handles both correctly by
construction" was right — the tests found no defect. They were still worth writing: the
structure that makes both cases correct (`arm()` skipped when initially hidden; the
`else if (autoDismissTimer === null)` branch starting the clock on first reveal) is
exactly the kind of thing a later edit silently breaks, and mutation N shows the gap it
would leave.
