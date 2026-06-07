# Coding Deviation Log: directory-structure-review

## Phase A (C1/C2/C3 + S3)

### D1 — C2 `notification.ts` pin reason: dropped the importer count
- **Plan said**: augment the reason with "19 importers via `@/lib/notification`" plus
  the `check-bypass-rls.mjs` citation.
- **Implemented**: reason is `RLS-bypass-allowlisted (scripts/checks/check-bypass-rls.mjs:67, CI-gated)` —
  the importer count was dropped.
- **Why**: Phase 3 review (F1) flagged "19" as a miscount. Verified precise count
  of files importing `notification.ts` itself is **10** (`@/lib/notification` exact +
  the self-test); "19" had conflated the whole `@/lib/notification*` tree (the 8
  `@/lib/notification/` subdir importers target a different module). The importer
  count is also drift-prone and is NOT the load-bearing pin reason — importers are
  auto-rewritten by the codemod on a move; the genuine mechanical pin is the
  CI-gated `check-bypass-rls.mjs:67` allowlist entry (moving the file breaks that
  gate unless the allowlist path is updated). Citing only the allowlist is more
  accurate and more stable. No contract weakened — the load-bearing reason is
  preserved and made precise.

No other deviations. C1, C3, and the S3 `pre-pr.sh` hardening were implemented as
specified in the locked plan.

## Phase B (C4 — move `password-generator.ts` → `src/lib/generator/`)

### D2 — removed an orphaned `vitest.config.ts` coverage.include entry (pre-existing)
- **Not in the plan**: `refactor-phase-verify`'s `check-vitest-coverage-include`
  (runs only on `refactor/*` branches) failed on a stale entry
  `"src/lib/inject-extension-bridge-code.ts"` — that file was deleted in `#492`
  (`24a20026`) and is absent from `origin/main`'s tree; the coverage entry was
  never cleaned up.
- **Action**: removed the orphaned line from `vitest.config.ts`.
- **Why fix here**: `vitest.config.ts` is already in this PR's diff (the codemod
  rewrote the `password-generator` coverage path), so the pre-existing stale entry
  is in-scope per Anti-Deferral; and the refactor gate (a required CI check on
  `refactor/*`) cannot pass while the orphan exists. Unrelated to the move itself.

### N1 — `.git-blame-ignore-revs`: no self-referential move-SHA entry added
- **Plan C4 said**: append the move-commit SHA to `.git-blame-ignore-revs` (VEC4).
- **Implemented**: no entry added on the branch. Rationale: a commit cannot
  reference its own (post-amend) SHA, and this repo squash-merges standalone PRs
  (e.g. `#521`), so any branch SHA would be orphaned on `main`. The repo's actual
  pattern adds the *prior* phase's known SHA in a multi-phase branch, or the SHA
  lands via the merge commit. `check-blame-ignore-revs` passed (it validates only
  listed SHAs; HEAD need not be listed). The move is a 2-file rename that
  `git blame --follow` already tracks. **Post-merge action** (optional): append the
  squashed `main` SHA to `.git-blame-ignore-revs` if blame-ignore is desired —
  noted in the PR body. No gate depends on it.

### Note — `.refactor-phase-verify-baseline`
- Bumped the local (gitignored) baseline to current `origin/main`
  (`77eb6b5d…`) so the stale-branch guard passes; not a committed change.

## Phase C (C5 delete + C6 relocate + C7 investigate)

### D3 — C6 vi.mock prep: aliased only the *live* mocks, left the dead ones
- **Plan C4/C6 said**: convert all 7 relative `vi.mock` in
  `vault-context-loading-timeout.test.tsx` to `@/lib` aliases and DELETE the dead
  `crypto-emergency` mock.
- **Implemented**: aliased only the 3 *live* mocks
  (`team-vault-context`, `auto-lock-context`, `emergency-access-context`) plus
  `url-helpers` in `callback-url-basepath.test.ts`. Left the 4 dead mocks
  (`./crypto-client`, `./crypto-emergency`, `./crypto-team`, `./webauthn-client`)
  **unchanged**, and did NOT delete any mock line.
- **Why**: closer analysis showed those 4 mock specifiers already do not match
  `vault-context.tsx`'s imports (it loads `../crypto/*` and `../auth/webauthn/*`,
  not `./crypto-*`) — they are dead no-ops at both the old and new path. (1)
  *Activating* them by aliasing to the real modules with `() => ({})` would
  replace real crypto with empty stubs the loading-timeout test never needs, a
  behavior change and a regression risk. (2) *Deleting* a `vi.mock` line is a body
  change that `verify-move-only-diff` would flag (it blanks vi.mock *specifiers*
  but a removed call is a real body diff), so a deletion would force a separate
  prep PR. Leaving them is the behavior-preserving, move-only-safe choice. Phase 3
  review (all three experts) confirmed leaving them is correct. Cleanup of the
  dead mocks is a minor follow-up: `TODO(directory-structure-review): drop the 4
  dead ./crypto-*/webauthn-client vi.mock no-ops in vault-context-loading-timeout.test.tsx`.

### C7 — `validations.test.ts`: confirmed NOT redundant, left in place
- Verified (review T7) the root `src/lib/validations.test.ts` holds unique
  assertions absent from `src/lib/validations/validations.test.ts` (aadVersion
  defaults/boundaries; passkey share-link fields). **No deletion/move.** Follow-up:
  `TODO(directory-structure-review): merge unique src/lib/validations.test.ts
  assertions into validations/validations.test.ts, then remove the root file`.

### N2 — `.git-blame-ignore-revs`: no self-referential entry (same as Phase B N1)
- Not added; squash-merge would orphan it; no gate depends on it. The relocated
  tests are content-changed renames that `git blame --follow` tracks.
