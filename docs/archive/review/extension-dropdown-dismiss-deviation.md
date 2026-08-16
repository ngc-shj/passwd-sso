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
(FR3 across the re-entrancy path) and passes honestly.

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
| E: arm the timer unconditionally | 2 tests (T10, T14) | PASS |
| F: move the clear after the `fn()` re-entrancy point | 2 tests (T11, T14) | PASS |
| G: nest the clear inside `if (currentDropdown)` | **nothing — equivalent mutant** | see D4 |
| H: hand-rolled teardown in the timer callback | 1 test (T13) | PASS |

Allow side, per the Remedy Floor: after every mutation-revert the full extension suite
was re-run green — **1007 tests in 61 files**, including the three test files that mock
the dropdown module wholesale (R19 parallel-test-tree check).

## Verification

| Gate | Result |
| --- | --- |
| `npx vitest run` (extension) | 1007 passed / 61 files |
| `npx tsc --noEmit` (extension) | clean |
| `npm run lint` (repo, `--max-warnings 0`) | clean |
| Contract conformance greps (4 forbidden patterns) | all absent |
| Files changed | 2 code + 2 docs — matches the Implementation Checklist exactly |

No detector file was modified, no message file, no `.js` mirror — as FR6/NFR1/NFR2
predicted.
