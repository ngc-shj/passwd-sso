# Code Review: extension-detection-followups
Date: 2026-10-12
Review round: 1

## Changes from Previous Round
Initial review of HEAD `23dbc6bb9` by three fresh expert sub-agents. No Ollama seed was used; each did a full-diff review, with mutations run in scratch copies.

## Functionality Findings
- **F-F1 [Major]** A split expiry field whose label describes the pair's format was dropped as naming both parts, so the month (or both parts) was lost where main filled them. Examples: `<label for>Expiration date (MM/YY)</label>` over `exp_month`/`exp_year`, a wrapping label with option text, and JA `card_exp_month`.
  - **Missed by tests because:** jsdom has no `CSS.escape`, so the `<label for>` path never ran in tests.
- **F-F2 [Minor]** Locked, disconnected and disabled menus never recorded the cache version, so the same-host skip never fired again and every tab event rebuilt the menu.
- **F-F3 [Minor]** The post-snapshot lock re-check left a bare parent with no locked item.
- **F-F4 [Minor]** The attribute filter walked the subtree once per record.

## Security Findings
- **F-S1 [Major, R43/R49]** Tier-2 adjacency was counted over the filtered pool. A DOB "Year" behind skipped controls, or across another form when the card number is form-less, took the card year where main claimed nothing. This was proven end to end.
- **F-S2 [Minor, adjacent, pre-existing]** Post-lock teardown depended on `tabs.query` returning an active tab. With none, entry items created before the lock persisted.

## Testing Findings
TR6 was re-verified: M1–M17 all turn red against the real code. The remaining findings:

- **T-F1 [Major]** No test pins these three rules: the `!fromAutocomplete` exception, the CJK vocabulary clause, and the combined both-or-neither equality.
- **T-F2 [Major]** No test pins the host reset in the post-snapshot lock re-check.
- **T-F3 [Major]** No test pins the length check in `menuViewChanged` (append and shrink).
- **T-F4 [Major]** Acceptance-3's red-proof is order-dependent, because `lastMenuCacheVersion` leaks across tests.
- **T-F5 [Major]** The background C2 tests rely on fixed real-timer settle windows, and the negative test has no positive control.
- **T-F6 [Minor]** No test pins the immediate `runNow` on added nodes.
- **T-F7 [Minor]** No test pins `attributeFilter`.
- **T-F8 [Minor]** No test pins the TTL-hit snapshot version.
- **T-F9 [Minor, adjacent]** Pre-existing detector tests call `destroy()` after their assertions.

## Adjacent Findings
- F-S2 (security → functionality).
- T-F9 (testing, pre-existing).
- #885 note from the security expert: `cacheVersion` carries no lock epoch. #885 must invalidate the cache or version on unlock.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- **Findings:** R22 F-F1 · R34 folded into F-F1 · R38 F-F3 · R48 F-F1 · R52 F-F1
- **OK:** R2 · R3 · R4 · R10 · R13 · R17 · R29 · R41 · R42 · R50 · R55 · R57
- **N/A:** the rest

### Security expert
- **Findings:** R38 F-S2 · R43 F-S1 · R49 F-S1, F-S2
- **OK:** R1 · R2 · R3 · R13 · R17 · R42 · RS3
- **N/A:** the rest, including RS1/RS2/RS4–RS6

### Testing expert
- **R19:** OK
- **R42:** Checked
- **RT1:** Partial (T-F8)
- **RT2 / RT3 / RT5 / RT6:** OK
- **RT7:** T-F1, T-F2, T-F3, T-F4, T-F6, T-F7, T-F8
- **RT8 / RT10:** OK, except the C2 negative test (T-F5)
- **RT11:** T-F4, T-F9
- **N/A:** the rest

## Environment Verification Report
- VE1 (real-browser fill, rendered context menu, reveal dropdown): `blocked-deferred` (plan VE1). It will run on tailscale-served scratch pages before merge.
- Unit coverage: `cd extension && npx vitest run`.

## Resolution Status
### F-F1 [Major] Split field with a pair-format label dropped
- **Action:** `mentions` comes from the field's own name/id/placeholder/aria-label (English patterns) when those name exactly one part. Otherwise the whole hint decides.
- **Tests:** `cc-expiry-picks.test.ts` gains a `CSS.escape` stub and CR1 rows. The label[for] cases, `Valid thru (month/year)` and JA wrapping-label cases are red on the pre-fix HEAD.
- **Note:** two rows (option text, autocomplete plus wrapping label) did not reproduce on HEAD in jsdom. They are kept as regression guards.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts` (`describeCandidate`, `ownSinglePart`)

### F-S1 [Major] Tier-2 adjacency over the filtered pool
- **Action:** adjacency now uses every `input, select, textarea` in the document. A hidden, unusable or other-form control in between blocks the match, and the anchor must still be in the pool.
- **Tests:** CR1 form-less/other-form and same-form/skipped-controls rows. Both are red on the pre-fix HEAD.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts` (`pickExpiry`)

### F-F2 [Minor] Locked menu defeats the same-host skip
- **Action:** `lastMenuCacheVersion = version` is recorded with `lastMenuHost` for every menu built.
- **Tests:** a test that a locked menu skips same-host refreshes (unique version, red-proven), plus a version-bump rebuild as the allow side.
- **Modified file:** `extension/src/background/context-menu.ts` (`doUpdateMenu`)

### F-F3 [Minor] Bare parent after the post-snapshot lock re-check
- **Action:** `createLockedItem()` runs on that branch.
- **Tests:** the lock re-check test now asserts `psso-login-locked` (red-proven).
- **Modified file:** `extension/src/background/context-menu.ts`

### F-S2 [Minor] Teardown depends on `tabs.query`
- **Action:** `refreshContextMenu` always schedules a rebuild. With no tab, or a rejected query, the rebuild is URL-less and resets the menu to the bare parent.
- **Tests:** `it.each` for no tab and for a rejected query (red-proven).
- **Modified file:** `extension/src/background/context-menu.ts` (`refreshContextMenu`)

### F-F4 [Minor] Subtree walk per record
- **Action:** each target is inspected once per batch, in both detectors. The rate bound itself is unchanged; NF1 governs it.
- **Modified files:** `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`

### T-F1 … T-F9: test-only batch
Production code is unchanged. Each new test is green on the current code and red under its named mutation, applied to a scratch copy.

| Finding | Test added or changed | Mutation that turns it red |
|---|---|---|
| T-F1 | Three CR2 rows in `cc-expiry-picks.test.ts` | Each of the three rules (`!fromAutocomplete`, the CJK check, the both-or-neither equality) reddens its own row only |
| T-F2 | `context-menu.test.ts`: post-snapshot lock re-check then a same-host follow-up | Drop `lastMenuHost = null` |
| T-F3 | `background.test.ts`: append and shrink cases. They need an identical-prefix entry keyed to the registered ciphertext, because an unregistered one silently became a replace | Drop the length check |
| T-F4 | Acceptance-3 now establishes `lastMenuCacheVersion === 1` itself | Drop the wrapper host reset: red under seeds 1–5, green under 1–5, 11 and 42 |
| T-F5 | Sleeps before `mockClear` replaced by `vi.waitFor` quiescence gates; a positive control added beside the identical-response negative | `changed = true` reddens only the negative |
| T-F6 | Insert a field: 1 scan before any timer; an attribute-only change: 0 | `runNow` replaced by `noteAttributeChange`, each detector separately |
| T-F7 | `data-x` mutation: 0 scans; `class`: 1 | Drop `attributeFilter`, each detector separately |
| T-F8 | Second same-host refresh within the TTL: no `removeAll` | TTL-hit `version: 0` |
| T-F9 | Every detector init goes through a file-level destroy registry | — |

Full suite: 1543 passed, twice. tsc is clean.
