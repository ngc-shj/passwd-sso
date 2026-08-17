# Code Review: extension-passphrase-visibility-icon

Date: 2026-08-17
Review round: 1

## Changes from Previous Round

Initial code review. Three expert sub-agents reviewed `git diff main...HEAD` in parallel.
Ollama was unavailable, so seeds and `merge-findings` were skipped — manual dedup fallback.

## Summary

8 findings: **1 Major (withdrawn on verification), 7 Minor.** No Critical. The committed
code met every requirement; two Minors led to real test improvements.

**Security review: zero findings** — the first empty result across these three changes.
The masking mechanism (`type={showPassphrase ? "text" : "password"}`) was verified
byte-identical to `main` by SHA, and the two deferrals (SC4, SC5) were independently
confirmed honest rather than taken on trust.

## Functionality Findings

**F-Func-1 — Major — WITHDRAWN, misattributed.** The reviewer found an applied mutation
and two untracked `__probe*.test.tsx` files in the working tree and concluded Phase 2 had
left a mutation unreverted, falsifying the deviation log's "restoration verified after
each" claim.

The observation was real; the attribution was not. Those artifacts belonged to the
**testing reviewer**, running its own mutation pass concurrently in the same worktree.
The security reviewer hit the same interference from the other side, reporting a transient
T6 failure that vanished once *its* probe files were removed. Verified immediately after:
`git status --porcelain` showed only my own deviation-log edit, no probe files existed,
`HEAD` carried the correct slashed-eye glyph, and the suite was 1023/1023 green. The
reviewer itself reached the same conclusion after stashing.

**The genuine finding underneath is mine**, and it is recorded as D4: the previous change
on this package ended with exactly this lesson written down — *do not run verification
agents concurrently with a mutation pass that edits the tree they read* — and I ran three
Phase-3 reviewers in parallel while instructing one to mutate. The lesson was recorded and
not applied. Cost: one Major finding and one transient failure, both spent on an artifact
of my own scheduling.

**F-Func-2 — Minor — RESOLVED.** The deviation log's D2/D3 renumbering was uncommitted at
review time. *Resolution:* committed.

**F-Func-3 — Minor — RESOLVED.** NFR4's table claimed "colour / hover / active /
transition — unchanged", but three classes did change: `rounded` → `rounded-md`,
`text-gray-600` → `text-gray-500`, `hover:text-gray-800` → `hover:text-gray-700`. The
*code* was right — those are `App.tsx`'s icon-button values, which is what NFR3 asked for
— and the reviewer confirmed class-by-class that **no hover-background, active, or
transition class was dropped**. NFR3 and NFR4 simply contradicted each other.
*Resolution:* NFR4's table now enumerates the three shade changes; D2 records the same.

## Security Findings

**No findings.** Verification worth recording, all executed rather than asserted:

- **I1.3 / R43** — `VaultUnlock.tsx:58` is byte-identical to `main` (SHA-256 match on the
  line; the whole input block diffed identical). The diff touches only the sibling
  `<button>`. Mutating the ternary reddened 2 tests and left 11 green, so the invariant is
  load-bearing under test rather than decorative.
- **RS3/RS6** — both new SVGs are fully static JSX: no interpolation anywhere in either
  subtree, no attribute fed from the passphrase, a message payload, storage, or a tab URL.
  The only dynamic value in the added block is the `showPassphrase` boolean choosing
  between two constant subtrees. `dangerouslySetInnerHTML`: zero hits, both sides.
- **Label provenance** — `t()` resolves from statically-imported bundled JSON with no
  fetch and no storage read. The one externally-influenced input
  (`chrome.i18n.getUILanguage()` / `navigator.language`) is a *lookup key* constrained to
  `{en, ja}` with an `en` fallback, so a hostile locale cannot produce attacker-chosen
  text — worst case is the wrong one of two bundled strings.
- **SC4 honesty confirmed** — the popup is a fresh document per open
  (`main.tsx` calls `createRoot(...).render()` at module top level) and `showPassphrase`
  is component-local `useState` with no storage backing (grep: five references, all in
  `VaultUnlock.tsx`). So a revealed passphrase genuinely does not survive closing the
  popup. The underlying failure-path gap is real, correctly described, and pre-existing.
- **SC5 honesty confirmed** — `autoComplete` / `spellCheck` / `autoCorrect` /
  `autoCapitalize` are absent from **both** `main` and `HEAD`. Genuinely pre-existing and
  untouched, and the cited web-app precedent (`vault-lock-screen.tsx:241`) is real.
- **Test fixtures** — the new tests type no passphrase at all; none calls `fireEvent.change`
  on the input, and the input's `value` is never read. No snapshots anywhere in
  `__tests__/popup/`, so no serialized DOM containing a credential can reach a CI log.
- **R49** — nothing reads the glyph: no code outside `VaultUnlock.tsx` references
  `showPassphrase`, and no control flow or trust decision depends on the icon.

The reviewer explicitly declined to re-raise the shoulder-surfing angle, noting the
affordance, default state, and click cost are all unchanged — consistent with plan review's
disposition and correct under the Finding Floor.

## Testing Findings

The reviewer re-ran four of the six logged mutations and added three of its own. **All
four reproduced exactly**, including the two that matter most:

| Mutation | Log claimed | Reviewer observed |
| --- | --- | --- |
| delete `aria-label`, keep `title` | 1 red (T6), 12 green | **1 failed / 12 passed** |
| swap the icon/label pairing | 1 red (T7), T4 green | **1 failed / 12 passed** |
| same icon both states | 2 red (T4, T7) | **2 failed / 11 passed** |

It also confirmed the `iconFor` null guard **fires with the right error at the right
line** (`expected null not to be null` from `iconFor`, not a downstream `TypeError` or an
`undefined === undefined` masquerade) — the precise remedy plan review's Critical F-Test-1
demanded, verified in force.

**Bottom line on the vacuity hunt: no fourth vacuous test.** Every test was driven red by
at least one mutation.

**F-Test-1 — Minor — RESOLVED (test removed).** T3 was fully subsumed: the reviewer
deleted it and re-ran the no-svg mutation, confirming T4 and T7 catch everything T3 caught,
because all three route through the same `iconFor` guard. T3 had **no mutation it uniquely
reddened**. *Resolution:* deleted. Its only value — a clearer failure message — is
delivered by the guard itself, not by its `toContain("<svg")` line.

**F-Test-2 — Minor — RESOLVED (test tightened).** The sharpest finding: **a meaningless
square glyph in the hidden state passed all 13 tests.** T7 pinned "the visible state has a
slash", not "the hidden state is an eye", while the plan described it as pinning I1.2 (the
icon direction). *Verified independently* — I ran the square mutation and got 13/13 green.

*Resolution:* T7 now also asserts the hidden-state glyph contains its pupil `<circle>`.
**Prove-red executed:** the square mutation reddens T7 alone (it passed before), and the
no-svg mutation still fires the guard. jsdom cannot judge whether a path *looks* like an
eye — that stays with M2 — but the two elements carrying the meaning are now pinned.

**F-Test-3 — Minor — ACCEPTED as-is.** T7's `"<line"` coupling reddens on a semantically
equivalent path refactor. The reviewer established the error direction is **safe**: a
correct refactor produces a loud false positive, and no broken implementation stays green.
Documented at the test site.

**F-Test-4 — Minor — verified, no defect.** The locale pin is inert today (jsdom hardcodes
`en-US` regardless of host locale — confirmed under `LANG=ja_JP.UTF-8`) and is parity with
ten sibling files. The reviewer added a fact the plan missed: `getLocale()` prefers
`chrome.i18n.getUILanguage()`, and only because this file stubs no `chrome` object does
the `navigator.language` fallback govern — so the pin does work, for a slightly different
reason than the comment states.

**RT11 / CI** — no state leakage (the outer `beforeEach` covers the nested block; RTL
auto-cleanup verified active by probe; no ordering coupling introduced). CI picks the file
up: the `extension-ci` job fires on the `extension/**` path filter and runs `vitest run`
with no path argument.

## Adjacent Findings

Dispositioned above: SC4/SC5 (both confirmed honest, correctly deferred), the T7 path
coupling (accepted, documented), and the deviation-log hygiene note (committed).

## Quality Warnings

None. `merge-findings` could not run (Ollama unavailable). Manual substitute: the one
Major was independently re-verified before disposition — and withdrawn on the evidence
rather than accepted — and both test changes were prove-red executed against their own
mutation.

## Environment Verification Report

| Path | Classification | Basis |
| --- | --- | --- |
| C1 acceptance criteria | `verified-CI` | `npx vitest run` — 1022 passed / 61 files |
| Icon *appearance* (does it read as an eye) | `blocked-deferred` | **VC1** — jsdom renders no pixels; M1-M2. The square-glyph gap is exactly this boundary, now narrowed but not closed |
| Screen-reader announcement | `blocked-deferred` | **VC2** — testing-library approximates the accname computation; T6 pins the attribute, M3 covers the announcement |
| SC4 / SC5 | `blocked-deferred` | Pre-existing, Anti-Deferral entries recorded, both independently verified honest |

## Resolution Status

### F-Func-1 · Major · reported unreverted mutation
- Action: **Withdrawn** — misattributed to Phase 2; the artifacts were a concurrent
  reviewer's. Verified `HEAD` clean and the suite green. The real defect (my scheduling)
  is recorded as D4.

### F-Func-2 · Minor · uncommitted deviation-log rewrite
- Action: committed. Modified: `extension-passphrase-visibility-icon-deviation.md`

### F-Func-3 · Minor · NFR4 contradicted NFR3
- Action: NFR4's table now enumerates the three shade changes and confirms nothing was
  dropped. Modified: `extension-passphrase-visibility-icon-plan.md` (NFR4)

### F-Test-1 · Minor · T3 subsumed
- Action: deleted. Modified: `VaultUnlock.test.tsx`
- Red-proof: the reviewer deleted T3 and re-ran the no-svg mutation — T4/T7 still catch it.

### F-Test-2 · Minor · square glyph passed all tests
- Action: T7 additionally asserts the hidden glyph's pupil `<circle>`.
- Modified: `VaultUnlock.test.tsx`
- Red-proof: square-glyph mutation ⇒ T7 fails alone (passed before); no-svg ⇒ guard fires.

### F-Test-3 · Minor · T7 path coupling
- Action: **Accepted.** Worst case is a loud false positive on a correct refactor; no
  broken implementation stays green. Cost noted at the test site.

### F-Test-4 · Minor · locale pin mechanism
- Action: no change; the pin is correct. The `chrome.i18n` precedence detail is recorded
  here for the next reader.

## Verification after fixes

| Gate | Result |
| --- | --- |
| `npx vitest run` (extension) | **1022 passed / 61 files** |
| `npx tsc --noEmit` | clean |
| `npm run lint` (repo, `--max-warnings 0`) | clean |
| `npm run build` (extension) | clean |
| Worktree | clean |

## Round 2 assessment

Not run. Every finding is resolved, withdrawn on evidence, or accepted with its cost
stated. The two test changes were prove-red executed against their own mutation; the one
Major dissolved under verification. A Round 2 would be reviewing one deleted test and one
added assertion whose failure modes have both been demonstrated.
