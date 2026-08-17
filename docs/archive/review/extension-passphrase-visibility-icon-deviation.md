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

## D2 — Icon path data

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
