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
| T-F5 | A positive control beside the identical-response negative. The round-1 `vi.waitFor` gates were vacuous (R2-F1) and were replaced in round 2 | `changed = true` reddens only the negative |
| T-F6 | Insert a field: 1 scan before any timer; an attribute-only change: 0 | `runNow` replaced by `noteAttributeChange`, each detector separately |
| T-F7 | `data-x` mutation: 0 scans; `class`: 1 | Drop `attributeFilter`, each detector separately |
| T-F8 | Second same-host refresh within the TTL: no `removeAll` | TTL-hit `version: 0` |
| T-F9 | Every detector init goes through a file-level destroy registry | — |

Full suite: 1543 passed, twice. tsc is clean.

---

# Round 2
Date: 2026-10-12

## Changes from Previous Round
Round 2 is an incremental review of `23dbc6bb9..ad799f960`. All round-1 findings were verified as resolved. The exception is T-F5, which was only partly resolved (R2-F1). Three findings are new against the round-1 F-F1 fix (N1, F5, F6), and four test pins were missing.

## Findings
- **N1 [Minor, security, R43 vs round 1].** `ownSinglePart` let a strict own name override a label that names another subject. As a result, `passport_exp_month`/`passport_exp_year` under "Passport expiry (MM/YY)" both became single-part picks.
- **F5 [Major, functionality].** `ownSinglePart` re-admitted date-of-birth selects (`birth_year`/`birth_month` under 生年月日, and 生年月日（年） beside 有効期限（月）) as expiry parts.
- **F6 [Major, functionality].** A combined MM/YY input whose own name or id names one part (`exp_month`, `cc-exp-month`) became split month-only.
- **R2-F1 [Major, testing].** The round-1 `vi.waitFor` gates were already satisfied by the UNLOCK cascade, so they waited for nothing.
- **R2-F2 / R2-F3 / R2-F4 [Minor, testing].** Mutations that leave the suite green:
  - removing `ownSinglePart`'s placeholder, id or aria-label;
  - removing `textarea` from the adjacency set;
  - deduplicating only the first target of a batch.

## Resolution Status
### N1 and F5: a label naming another subject keeps its veto
- **Action:** `ownSinglePart` overrides `mentions` only when the hint, with the field's own attributes removed, is expiry vocabulary (`labelIsExpiryVocabulary`). 生年月日 / Passport / Date of birth labels therefore keep excluding the field.
- **Tests:** CR3 rows: the passport pair, `id=card_month` under Date of birth, the 生年月日 selects, and 生年月日（年） beside 有効期限（月）.
  - Red on the pre-fix HEAD.
  - The passport row and both 生年月日 rows are red when the gate is removed.
  - The `id=card_month` row is not red when the gate is removed. Without the gate it becomes combined rather than a month pick; it is claimed either way, as on main. It pins only "not a month".
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts` (`ownAttributes`, `labelIsExpiryVocabulary`, `describeCandidate`).

### F6: a combined input named after its first half
- **Action:** when tier 2 finds no partner, an input anchor whose whole hint mentions both parts becomes the combined field. This does not apply when autocomplete decided a part.
- **Tests:** CR3 rows: `Expiry date (MM/YY)` on `exp_month`, and `Expiration (MM/YY)` on `id=cc-exp-month`. Both are red without the fallback and on the pre-fix HEAD.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts` (`hintMentionsBoth`, the tier-2 tail).

### R2-F1: vacuous quiescence gates
- **Action:** `unlockAndSettleMenu()` clears the menu mocks before UNLOCK and waits for that rebuild's `psso-open-popup`. The team-entries test gets the same treatment.
- **Verification:** with the gate made synchronous, six tests go red, so the gate is not vacuous. `changed = true` still turns only the negative red, and `changed = entries === null` still turns the positives red.
- **Modified files:** `extension/src/__tests__/background.test.ts`, `extension/src/__tests__/background/team-entries.test.ts`.

### R2-F2 / R2-F3 / R2-F4
- **Action:** added CR3 rows for an own placeholder, an own id and an own aria-label, plus a textarea between month and Year. Also added a multi-target batch test (first target has no input), run for both detector profiles.
- **Verification:** each row or test is red under its own mutation: drop placeholder, drop id, drop aria-label, drop textarea, and first-target-only dedupe.

Full suite: 1555 passed, twice. tsc is clean.

---

# Round 3
Date: 2026-10-12

## Changes from Previous Round
Round 3 is an incremental review of `ad799f960..c93e040b7`.
- **Security:** no findings. The F6 fallback adds no element that round 2 did not already claim, and the N1 widening is gone.
- **Functionality:** F5 and F6 resolved; two new findings (F7, F8).
- **Testing:** the round-3 run terminated on an authentication error before reporting, so it was relaunched against the round-3 fixes.

## Findings
- **F7 [Major, functionality]** `labelIsExpiryVocabulary` rejected ordinary card wording. As a result, the split month was dropped again; main split these correctly. The rejected wording:
  - "Credit card expiration date";
  - "… as shown on card";
  - "Good thru";
  - month-name option text inside a wrapping label;
  - カード有効期限;
  - 必須.
- **F8 [Minor, functionality]** The no-partner fallback fired on an input with `maxlength=2`, which would write `MM/YY` into a two-character field.

## Resolution Status
### F7: card wording in the label
- **Action:** the label vocabulary is still an allow-list, with these additions:
  - `EXPIRY_WORDS` gains `credit debit good until shown printed` and the English month names (full and three-letter forms).
  - `JA_EXPIRY_VOCABULARY_RE` gains カード / 必須 / 任意.
- **What still fails the label check:** passport, birth, ポイント, マイナンバー and any other subject word.
- **Residual (SC3):** a label with an unlisted decoration word loses its month, as in round 2.
- **Tests:** CR4 rows. Five are red on the pre-fix HEAD: credit card, カード有効期限, 必須, as shown on card, Good thru. The month-name option row passes on HEAD in jsdom and is kept as a guard.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts`

### F8: fallback on a two-character input
- **Action:** the fallback is skipped when `maxLength` is 1 or 2. An unset `maxLength` (0 or less) still falls back.
- **Tests:** CR4 `maxlength=2` row, red on the pre-fix HEAD.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts`

Full suite: 1562 passed. tsc is clean.

---

# Round 4
Date: 2026-10-12

## Changes from Previous Round
This round reviews `c93e040b7..7432efb62` incrementally. The testing review also covers the round-3 range that its interrupted run had not reported. All earlier findings stay resolved.

## Findings
- **N2 [Minor, security, R43 vs round 3]** `credit`, `debit` and `until` counted as vocabulary on their own. A field labelled "Debit date", "Good until" or "Valid until" next to the card's expiry could therefore become the tier-2 partner.
- **F9 [Minor, functionality]** Month names were added to the shared `EXPIRY_WORDS`. That also widened the tier-2 token claim: a DOB "Month" select with month-name options would qualify.
- **R3-F1 [Major, testing; regression from c93e040b7]** Removing the start-of-test settle exposed a pending menu debounce left by an earlier test's module instance. Under shuffle seeds 2, 13 and 16 it fired into the next test and satisfied the open-popup gate early.
- **R3-F2 to R3-F7 [Minor, testing]** The following were unpinned:
  - the fallback's input-only condition;
  - the autocomplete exclusion, on both sides;
  - the month side of `hintMentionsBoth`;
  - the allow side of the maxLength boundary;
  - the month-name group (the existing row was vacuous: jsdom fuses the option text, and the label named only one part);
  - the words `debit`, `until`, `printed`, `任意` and `optional`.

## Resolution Status
### N2: subject-ambiguous card words
- **Action:** `CARD_QUALIFIED_WORDS` (credit/debit/until) count as vocabulary only when the hint also contains `card`.
- **Tests:**
  - CR5 "Debit date (MM)" beside the expiry year, and "Valid until (YYYY)" beside the expiry month. Both are red on the pre-fix HEAD.
  - The allow side is "Debit card valid until (MM)", which is still claimed.

### F9: month names only for the label check
- **Action:** month names move to `MONTH_NAME_WORDS`, which only `labelIsExpiryVocabulary` passes in. `loose` and `names` are as in round 3.
- **Tests:** the CR4 rows with full and abbreviated month-name options, separated by whitespace under an `(MM/YY)` label.
  - Each row is red when its month-name group is removed.
  - The DOB-Month guard row passes on HEAD in jsdom, because the option text fuses there.

### R3-F1: cross-test debounce leak
- **Action:** a file-level `afterEach` in `background.test.ts` calls the current instance's `disableContextMenu()`.
- **Verification:**
  - `background.test.ts` passes under seeds 2, 13 and 16.
  - The full suite passes under seeds 1, 2 and 13: 1575 tests.
  - The synchronous-gate and T-F5 mutations keep their red results, per the testing reviewer's scratch validation of the same remedy.

### R3-F2 to R3-F7
- **Action:** CR5 rows were added.
- **Verification:** each row is red under its own mutation:
  - input-only;
  - the autocomplete month exclusion;
  - the autocomplete year exclusion;
  - the month side of `hintMentionsBoth`;
  - `<= 4`;
  - full month names;
  - month-name abbreviations;
  - `debit`, `until`, `printed`, `任意` and `optional`.

Full suite: 1575 passed under seeds 1, 2 and 13. tsc is clean.

---

# Round 5
Date: 2026-10-12

## Changes from Previous Round
This round reviews `7432efb62..9b9ef7896` incrementally.
- **Security:** no findings. Both vocabulary predicates are strict subsets of round 4's.
- **Testing:** R3-F1 is resolved. A seed sweep over seeds 1–20 found 0 failures across `background.test.ts` and `context-menu.test.ts`. The sweep found two Minor unpinned rules.
- **Functionality:** two new findings, F10 and F11.

## Findings
- **F10 [Major, functionality].** `until` counted only when the label text contained "card", so "Valid until (MM/YY)" on the card's own `exp_month` / `card_exp_month` selects lost the month, or both parts. Main split these correctly.
- **F11 [Minor, functionality].** The JA labels クレジットカード有効期限 and デビットカード有効期限 failed the gate, because クレジット / デビット remained as CJK text.
- **R5-F1 [Minor, testing].** The DOB month-name guard row was vacuous: its fused option text formed no word.
- **R5-F2 [Minor, testing].** The card qualification of `credit` had no pinning test.

## Resolution Status
### F10: a card-expiry own name qualifies the label
- **Action:** `labelIsExpiryVocabulary` passes `cardQualified` when the field's own attributes strictly name a card-expiry part (`CC_DETECT_RE.expiry*` or `cc.?exp`). Fields named for another subject (`member_month`, `debit_month`) still need "card" in the label.
- **Tests:** CR6 rows for `exp_month` / `card_exp_month` and a wrapping "Valid until" label, each red on the pre-fix HEAD and red without the qualification. The `member_month` deny row stays unclaimed.

### F11: JA credit and debit card nouns
- **Action:** `JA_EXPIRY_VOCABULARY_RE` strips `(?:クレジット|デビット)?カード`. ポイントカード and マイナンバーカード still fail.
- **Tests:** the CR6 クレジットカード有効期限 row, red on the pre-fix HEAD and red under the old regex.

### R5-F1 and R5-F2
- **Action:** the DOB row now separates its options with whitespace; it turns red when month names are passed to `loose` / `names`. A "Credit date (MM)" deny row was added; it turns red without the `credit` qualification.

Full suite: 1581 passed under seeds 1 and 2. tsc is clean.

---

# Round 6
Date: 2026-10-12

## Changes from Previous Round
Incremental review of `9b9ef7896..82a996602`.
- **Functionality:** No findings. 48 probe rows were compared against main: 12 are improvements, 3 are accepted narrowings or residuals, and the rest are unchanged.
- **Security:** one Minor (N3).
- **Testing:** not run this round, because the user stopped the testing reviewer.

## Findings
- **N3 [Minor, security, R43 vs round 5]** `ownNamesCardExpiry` trusted a strict substring of the own name, so `member_exp_month` / `passport_exp_month` / `licence_exp_month` under "Valid until (MM/YY)" qualified `until`. As a result, `member_exp_month` became a new card recipient.

## Resolution Status
### N3: own name must itself be expiry vocabulary
- **Action:** the qualification also requires every own attribute to pass `isExpiryVocabulary`, with a leading `cc` allowed (`cc_exp_month`, `ccmonth`). A subject word in the name withholds it.
- **Tests:** the CR7 row with `member_exp_month` beside the expiry year is red on the pre-fix HEAD. The allow side is the CR6 `exp_month` / `card_exp_*` / wrapping-label / クレジットカード rows, which still pass.
- **Recorded residual (security, not a finding):** `passport_exp_month` / `passport_exp_year` under a subject-less "Expiry (MM/YY)" label split into both passport fields. Main does the same, so this is unchanged from main. Tightening the whole `ownSinglePart` override would instead make `birth_month` under that label combined (a regression), so it is left as an SC3 residual.

Full suite: see commit. tsc clean.

---

# Round 7
Date: 2026-10-12

## Changes from Previous Round
Incremental review of `82a996602..61a125a55`.
- **Security:** no findings. N3 is resolved, and the added conjunct can only narrow what is accepted.
- **Functionality:** one new Major (F12).

## Findings
- **F12 [Major, functionality]** The N3 own-name check lowercased the names before splitting them into words, so camelCase names fused into a single word (`expMonth`, `ccExpMonth`, `expirationMonth`, `cardExpiryMonth`). Names with a card-flow prefix (`billing_`, `payment_`) also failed the check. As a result, "Valid until (MM/YY)" lost the month, which main and round 6 kept.

## Resolution Status
### F12: camelCase and card-flow prefixes in the own-name check
- **Action:**
  - The check now reads `ownWordsOf`, which splits camelCase before lowercasing.
  - It accepts `CARD_FLOW_WORDS` (billing, payment, checkout, order) as extra words.
  - `member` / `passport` / `licence` are still rejected.
- **Tests:** CR8 rows `expMonth`, `billing_exp_month`, `ccExpMonth` and `cardExpiryMonth`. Each fails on the pre-fix HEAD. The CR7 `member_exp_month` deny row still passes.

---

# Round 8 (termination)
Date: 2026-10-12

## Changes from Previous Round
Round 8 is an incremental review of `61a125a55..39675b4e1`.

- **Security:** no findings.
  - All five security findings are resolved: F1, F2, N1, N2 and N3.
  - The camelCase subject variants (`memberExpMonth`, `passportExpMonth`) are still denied.
- **Functionality:** no findings.
  - All 56 probe rows match the F12 prototype.
  - Every difference from main is either an improvement or an accepted item.
- **Minor follow-up:** the security reviewer noted that `ownWordsOf` duplicates the attribute list in `ownAttributes`.
  - Both now read a shared `rawOwnAttributes`.
  - This is a refactor with no change in behaviour. The full suite passes: 1586 tests.

## Termination
- **Functionality and security:** rounds 7 and 8 found nothing new.
- **Testing:** the reviewer last reported in round 5.
  - All of its findings are resolved, and a seed sweep over seeds 1–20 was clean.
  - The user stopped this reviewer during round 6, so rounds 6–8 had no separate testing review.
  - Instead, every change in those rounds carries its own pinning row, and each row was red-proven against the HEAD before the fix.

## Environment Verification Report
- **VE1 (plan):** `blocked-deferred`. It is run manually on tailscale-served pages before merge.
  - It covers real-browser fill into expiry fields, the rendered context menu, and the reveal followed by the dropdown.
  - The constraint and its cost-justification are in plan VE1.
- **Unit:** `cd extension && npx vitest run` passes all 1586 tests. tsc and the build pass.
