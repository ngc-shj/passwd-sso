# Code Review: fill-visibility-focus-scope
Date: 2026-10-13
Review round: 3

## Changes from Previous Round
Initial review of `0404df58f`. Three fresh expert sub-agents reviewed the full diff and ran jsdom probes and mutations in scratch copies. The Phase 2 self R-check had already resolved R47 (clip-path insets), R3 (the twin's hinted password scope) and RT7 (the x scroll window).

## Functionality Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Major | The scroll-window rule admitted a field placed before a scroll container's origin (`left:-9999px`). | Same as S-1. |
| F2 | Major | A fade-in modal focuses its field while an ancestor is still at opacity 0, so the dropdown never opened. | The dropdown gates and dropdown membership use `isDropdownFieldVisible` / `memberAdmission`: the field's own opacity, not its ancestors'. The fill re-checks the full rule at write time. |
| F3 | Major | Dropdown membership came from one page-wide detection, so a second form got no dropdown and C3 could not be triggered from the dropdown. | Each scan also detects every `<form>`. The remaining reach is recorded as D10. |
| F4 | Major | The card-form exclusion anchored on one card number per rule, so a second visible card form's CVV was LOGIN-eligible. | `ccCardBlockFields` anchors on every card-number candidate (`cardNumberCandidates`), in content and in the twin. |
| F5 | Major | An absolute field was clipped by static `overflow:hidden` ancestors that do not clip it. | The walk follows the containing-block chain (FLOW / ABSOLUTE / FIXED). |
| F6 | Minor | Focus-scope detections each built their own visibility cache. | One `fillAdmission()` per fill, shared by `focusScopedFields` and identity's nested `ccClaimedFields`. |
| F7 | Minor | An OTP key-catcher input hidden off-screen or at 1px is no longer filled. | Accepted cost, recorded as D11. |

## Security Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| S-1 | Major | A scroll-container ancestor cancelled R5: an off-screen-left password or CVV was filled. | On a scroll axis, content wholly before the scroll origin is denied (LTR left, RTL right, and y). A non-finite origin denies. This applies to content and the twin. |
| S-2 | Minor | A fixed field ended the clip walk, though a transformed or contained ancestor still clips it. | `containsFixed` ends the escape at that ancestor. |
| S-3 | Minor | The walk followed the DOM tree, so a slotted field skipped its shadow tree's clip. | `parentOf` follows `assignedSlot` first (the flat tree), in content and the twin. |

## Testing Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Critical | The review(1) fixes landed with no tests; every mutation survived. | Tests delegated, with red-proof for each branch. |
| F2 | Major | The R5 scroll-offset arm and the fixed negative arm were unpinned. | Tests delegated. |
| F3 | Major | The `overflow:clip`, `contain:strict` / `contain:content` and `content-visibility:auto` arms were untested. | Tests delegated. |
| F4 | Major | The twin's parity rows missed rules the content side pins. | Tests delegated. |
| F5 | Major | The cardholder Select2 test was vacuous. | Tests delegated. |
| F6 | Minor | A twin row was mislabelled. | Tests delegated. |
| F7 | Minor | The stub's client sizes are non-zero for inline elements, where Chrome gives 0. | Production fix: inline and `display:contents` ancestors clip nothing (overflow does not apply to inline boxes). |
| F8 | Minor | The rate-bound counting no longer bounds per-form scans. | Tests delegated. |
| F9 | Minor | No C3 test anchors on a focused `<select>`. | Tests delegated. |
| F10 | Minor | An unused test helper parameter. | Tests delegated. |
| F11 | Minor | An `elementFromPoint` restore was not in `finally`. | Tests delegated. |
| F12 | Minor (Adjacent) | Extension tests are typechecked nowhere; 52 pre-existing errors in 16 files. | Out of this PR's scope: see the Anti-Deferral entry below. |
| F13 | Minor (Adjacent) | The `focusScopedFields` signature deviated from the plan without a deviation-log entry. | Recorded as D9. |

## Testing F12: resolved in this branch (the user asked to fix it here)

- **Config:** `extension/tsconfig.test.json` extends `tsconfig.json`, adds the vitest globals types, and includes `src/__tests__` and `vitest.config.ts`.
- **Gate:** `npm run typecheck:test` runs in CI (Extension job, after the tests) and in `scripts/pre-pr.sh` ("Extension: Typecheck tests").
- **Errors fixed:** the 40 existing type errors in 13 test files, by typing mocks against the real signatures, narrowing nulls, and similar. No `any`, no suppression comments, and no assertion changed. The dead `environmentMatchGlobs` key was the 41st error (D6).
- **Red-proof:** a type error added to a test file on a scratch copy fails `tsc -p tsconfig.test.json`.

## Recurring Issue Check

### Functionality expert
- R3: F4
- R34: F3/F4, pre-existing in changed files and fixed
- R35: OK
- R41: F3
- R42: F4
- R47: F1/F5
- R52: F2
- Others: OK or n/a

### Security expert
- R29: S-1 / S-2 against plan C1's claims
- R47: S-2 / S-3
- R49: the bypass list. S-1 / S-2 / S-3 are fixed rather than listed.
- R52: S-1
- R42: OK
- R43: OK
- RS3: OK
- Others: n/a

### Testing expert
- R21: F1
- R34: F11
- R41: F1
- R42: F3 / F4
- R48: F4
- R52: F1
- RT1: F7
- RT6: F1
- RT7: F1, F2, F3, F5
- RT9: F4, F6
- RT10: F2
- RT11: F11
- Others: OK or n/a

## Round 2

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| R2-S1 / Q1 | Sec, Func | Major | Round 1 skipped inline ancestors before the containing-block transition, so an absolute field inside an inline `position:relative` span escaped the static clips above it. | An inline box skips only the clip; the transition always runs. Content and twin, with deny/allow tests. |
| R2-S2 | Sec | Major | `containsFixed` listed only some containing-block triggers, so the ABSOLUTE skip let fields escape clips that round 1 had applied. | Fail-safe: any listed trigger off its initial value (including unknown values) counts as a containing block. Content and twin, with per-trigger tests. |
| Q2 | Func | Minor | The scroll-origin rule ignored reversed axes (column-reverse, row-reverse, vertical-rl), denying reachable fields. | The axis direction is read from direction, writing-mode and flex-direction. Content and twin, with tests. |

Each fix was red-proved on a scratch copy by reverting it in content and in the twin.

## Round 3

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| R3-S1 | Sec | Major | Round 2's direction classification read `writing-mode: sideways-lr`'s inline axis backwards, so a field before a forward scroll origin was admitted. | The mechanism changed (D12): the scroll axis is bounded by the engine's scroll extent (`meetsScrollBand`), with no direction classification. A field the engine cannot scroll to is denied whatever the writing mode, direction or flex direction. Content and twin; the band edges, the forward extent and a non-finite extent are red-proved. |
| test N1–N4 | Test | Major/Minor | Twin and content arms that survived deletion; an unpinned reversed-axis boundary; a stale comment. | `fd7650db1`; each mutation red-proved. |

## Environment Verification Report
- **VE1** (real Chrome rendering: plan scenarios 1–8): `blocked-deferred` to the user's manual check before merge, per plan VE1.
- **Unit tests:** 1931 passed at `2327fa0c3` before the delegated test additions. tsc passes.

## Resolution Status

- **Production fixes:** `4561a5ca6` and `2327fa0c3`.
- **Tests:** the round-1 test commit addresses testing F1–F6 and F8–F11.
  - **Coverage:** every new branch has a deny/allow pair in the content predicate tests and a twin parity row.
  - **Red-proof:** each listed mutation, in content and in the twin, turns at least one test red, on a scratch copy.
  - **F5:** the vacuous cardholder Select2 test was deleted. Only the expiry roles accept a geometry-exempt select in CC; the identity date-of-birth pair covers a non-exempt role.
- **Full suite:** 2030 passed; tsc passes.
- **Pre-existing, not changed here:** on the twin's fallback username walk, a non-username text field preceding the password (for example `expiry`) can be taken as the username, where content's hint-checked walk takes `username`. Both pick the same password. The parity test already documented this as reported-not-fixed before this branch.
