# Coding Deviation Log: extension-passphrase-visibility-icon

Citations in this log are against the implementation (post-change), unlike the plan,
which declares a `main` baseline at `d22f252c`.

## D1 — The plan's T6 mutation was wrong, and prove-red caught it

The plan's Kind-B table specified, for T6:

> hardcode `aria-label` only, leaving `title` state-dependent → **T6 must fail; T1/T2/T5
> must stay green**

Run as written, this reddened **six** tests, not one. The reason is the very precedence
fact the plan had measured and recorded two sections earlier and then failed to apply:
**`aria-label` overrides `title`**. Hardcoding `aria-label="Show"` therefore freezes the
accessible name in *both* states, so the name-based queries in T1/T2/T5 stop
distinguishing them — the mutation breaks far more than the clause it was aimed at, and
proves nothing about whether `aria-label` is load-bearing.

**The correct mutation is to delete `aria-label` entirely**, leaving `title` to supply the
name. Run:

```
MUTATION[B2: delete aria-label (title remains)] => Tests 1 failed
    red: sets aria-label itself, not only the title fallback
```

One test red, twelve green. *That* is the evidence the plan wanted: T6 sees the defect and
nothing else can. Corrected in the plan's Kind-B table.

Worth naming the pattern, because it is the third time in two changes on this package:
the plan measured a fact correctly, stated it correctly, and then wrote a downstream
step that contradicted it. Measuring is not enough if the measurement is not carried
through to every step that depends on it.

## D2 — Three className changes beyond NFR4's table

NFR4 tabulated padding, text size, and icon size. The implementation also changed three
colour/shape classes, adopting `App.tsx`'s icon-button values wholesale rather than
keeping the text button's:

| Class | Before (`main`) | After | Source |
| --- | --- | --- | --- |
| corner | `rounded` | `rounded-md` | `App.tsx:137,147,156` |
| base text | `text-gray-600 dark:text-gray-400` | `text-gray-500 dark:text-gray-400` | same |
| hover text | `hover:text-gray-800` | `hover:text-gray-700` | same |

Rationale: NFR4's stated intent is "matches the popup's icon-button idiom", and taking
two-thirds of that idiom while keeping the text button's leftover colours would have been
a half-conformance nobody could later explain. Every hover/active/transition class is
otherwise **preserved verbatim** — verified by diffing the token sets between
`git show main:...` and HEAD.

Recorded because NFR4's table did not enumerate these, and an unrecorded className delta
in a plan otherwise specified to this level of detail reads as drift rather than intent.

## D3 — Icon path data

The plan specified the icon *idiom* (`viewBox="0 0 24 24"`, `stroke="currentColor"`,
`strokeWidth="2"`, `w-4 h-4`) but not the path geometry, since the extension cannot import
`lucide-react` (no icon dependency). The paths implemented are equivalents of lucide's
`Eye` and `EyeOff` — the same glyphs the web app renders at
`src/components/vault/vault-lock-screen.tsx:245-257` — so the two surfaces now show the
same picture through different mechanisms, which is what SC1 predicted.

`EyeOff` carries a `<line>` element for the slash; T7 keys on exactly that, which is the
coupling to path data the plan accepted explicitly.

## Prove-red results (all executed and observed)

Each mutation was applied to the real file, the suite run, and the file restored from a
pristine scratchpad copy. Restoration verified after each.

| Mutation | Reddens | Observed |
| --- | --- | --- |
| A: hardcode both `aria-label` and `title` | 6 tests (name-based queries collapse) | PASS |
| B: hardcode `aria-label` only | **6 tests — plan predicted 1** | corrected, see D1 |
| B2: delete `aria-label`, keep `title` | **1 test (T6), 12 green** | PASS |
| C: same icon in both states | 2 tests (T4, T7) | PASS |
| D: remove the `type` ternary | 2 tests (T5 + the pre-existing toggle test) | PASS |
| E: swap the icon/label pairing | **1 test (T7); T4 stays green** | PASS |

**Mutation E is the one that justifies T7's existence.** Plan review found that the
originally-proposed mutation table claimed this case was caught by T2, and measured that
it was not — T2 asserts the name round-trip, which a swapped pairing leaves untouched.
E confirms both halves: T7 catches it, and T4 does *not* (the icons still differ, merely
backwards). Without T7 this defect would have shipped with a green suite.

**Allow side, per the Remedy Floor**: after every mutation-revert the full extension suite
was re-run green — 1023 tests in 61 files, including `App.test.tsx` and `MatchList.test.tsx`,
which query sibling icon buttons by accessible name and so would notice a change to the
popup's naming convention.

## Verification

| Gate | Result |
| --- | --- |
| `npx vitest run` (extension) | **1023 passed / 61 files** (+6) |
| `npx tsc --noEmit` (extension) | clean |
| `npm run lint` (repo, `--max-warnings 0`) | clean |
| `npm run build` (extension) | clean |
| Files changed | 2 code + 2 docs — matches the Implementation Checklist |

## Not verifiable here (VC1)

M1-M4 remain manual: whether the glyph reads as show/hide, whether the 28×28 button
centres against the `h-10` input, the native tooltip text under both locales, and
legibility in dark mode. `blocked-deferred` for automation, executable locally by the
developer.

## D4 — A Phase-3 reviewer saw another reviewer's mutation and reported it as ours

The Phase 3 functionality review filed a Major: it found `VaultUnlock.tsx` carrying an
applied "same plain eye in both states" mutation plus two untracked `__probe*.test.tsx`
files, and concluded that Phase 2 had left a mutation unreverted — falsifying this log's
"restoration verified after each" claim.

**The observation was real; the attribution was wrong.** Those artifacts belonged to the
*testing* reviewer, which was running its own mutation pass concurrently in the same
worktree. The security reviewer independently hit the same interference from the opposite
side, reporting a transient T6 failure that vanished once its own probe files were
removed. Checked immediately afterwards:

```console
$ git status --porcelain
 M docs/archive/review/extension-passphrase-visibility-icon-deviation.md   ← this file, mine
$ ls extension/src/__tests__/popup/ | grep -i probe
  (none)
$ git show HEAD:extension/src/popup/components/VaultUnlock.tsx | grep -c '<line x1="2"'
1                                        ← the slashed eye is committed correctly
$ npx vitest run
Test Files  61 passed (61)   Tests  1023 passed (1023)
```

The reviewer itself reached the same conclusion after stashing — it recorded that HEAD is
clean and that this is "process hygiene, not a defect in what merges". That part is right.

**What is genuinely mine, and it is the more useful finding**: the previous change on this
package ended with exactly this lesson written down — *do not run verification agents
concurrently with a mutation pass that edits the tree they read; the prove-red pass must
own the worktree exclusively.* I wrote that, and then ran three Phase-3 reviewers in
parallel while telling one of them to mutate. The lesson was recorded and not applied.

The concrete cost is not a shipped defect but a reviewer-hours defect: one Major finding
and one transient failure both spent on an artifact of my own scheduling. Next time,
either serialize the mutating reviewer or give it an isolated worktree.

## D5 — Phase 3 narrowed what the icon tests actually pin

Two test changes came out of code review, both prove-red executed:

- **T3 deleted.** The reviewer proved it reddened under no mutation that T4 and T7 did not
  also catch — all three route through `iconFor`, whose null guard does the work T3's
  `toContain("<svg")` appeared to do.
- **T7 tightened.** A meaningless square glyph in the hidden state **passed all 13 tests**:
  T7 pinned "the visible state has a slash", not "the hidden state is an eye", while the
  plan described it as pinning the icon direction. T7 now also asserts the hidden glyph's
  pupil `<circle>`. Re-run: the square mutation reddens T7 alone, where it was green before.

What remains unpinnable is unchanged and honest: jsdom cannot judge whether a path *looks*
like an eye. T7 pins the two elements that carry the meaning; M2 covers the rest.

## D6 — SC4 and SC5 implemented after a follow-up security review

Both were deferred in Phase 1 and re-raised by a follow-up review that arrived at them
independently. Implemented rather than re-deferred; see the plan's addendum for why the
original cost estimate was wrong.

- **SC4**: `setShowPassphrase(false)` on both failure branches. The passphrase *value* is
  deliberately kept so the user can fix a typo — only visibility resets.
- **SC5**: `autoComplete="current-password"` (matching the web app's five passphrase
  inputs), plus `spellCheck` / `autoCorrect` / `autoCapitalize` off.

Three tests added, four mutations run:

| Mutation | Reddens |
| --- | --- |
| H: drop re-mask on the invalid-passphrase branch | that branch's test alone |
| I: drop re-mask on the permission-denied branch | that branch's test alone |
| J: also clear the value on failure | the "value survives" assertion |
| K: drop `spellCheck` | the attribute test |

H and I reddening separately is the point: the two failure paths are independently pinned
rather than sharing one assertion, so removing either is visible.

Gates after: 1025 extension tests, tsc clean, lint clean, build clean, `git diff --check`
clean.
