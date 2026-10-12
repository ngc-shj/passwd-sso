# Coding Deviation Log: extension-detection-followups

## D1: C1 fixtures in a dedicated test file
- **Plan:** the C1 detection table in `cc-form-detector.test.ts`.
- **Actual:** `extension/src/__tests__/content/cc-expiry-picks.test.ts`, holding the 69-row table ported from prototype v5.
- **Reason:** the table is large and self-contained. `cc-form-detector.test.ts` keeps its existing pure-detection cases.

## D2: F-S16b fixture field renamed from `yy_field` to `yy`
- **Reason:** with the expiry-vocabulary gate added in round 6, `yy_field` no longer counts as a loose year (`field` is not expiry vocabulary). The fixture then stopped catching M13. A bare `yy` is loose and context-free, which is the case M13 exists to catch. It was re-proven red under M13 against the real code.

## D3: two-digit year applies only when the input asks for it
- **Implementation:** `yearForInput` normalises and slices to two digits only for a `YY` hint (delimiter-aware) or `maxLength === 2`. Every other input receives the payload unchanged, as today. The plan's FR3 wording matches; recorded because the "unchanged otherwise" half is a decision.

## D4: extra C2 test for a build superseded mid-way through creating items
- **Problem:** acceptance item 3's test aborts at the gated snapshot. The rebuild has not recorded the snapshot's version at that point, so the version check alone forces a full rebuild, and removing the wrapper's `lastMenuHost = null` left that test green (the C2 implementer's red-proof table, row 3).
- **Added test:** it holds the first entry item's `contextMenus.create`, after both host and version are recorded. It is red-proven against removal of the wrapper's host reset on a scratch copy.

## D5: side-fix in `background.test.ts`
- `encryptData` was added to the hoisted crypto mocks. No earlier test in this file exercised the `SAVE_LOGIN` success path, which acceptance item 9 needs.

## D6: plan IDs removed from production comments
- Comments written during implementation cited plan and finding IDs (`#881`, `FR4`, `NF1`, `F-S2`). Those IDs are removed from production code, because they mean nothing outside the plan and rot when it changes. Test titles keep finding IDs, because the plan's mutation table maps to them.

## Carried-Forward Plan Findings disposition
- **TR6 (testing round 6, not delivered):** M1–M17, and M7, were re-run against the real code (scratch copy `c1real`). Each mutation turns its named fixtures red. The review itself is carried to Phase 3's testing expert.

## D7: C1 rules added during code review
Code review rounds 1–7 added the following rules to `pickExpiry`.

- **Adjacency:** judged over every `input, select, textarea` in the document, not over the pool.
- **Own attributes:** `ownSinglePart` (English patterns only), gated by `labelIsExpiryVocabulary`.
- **Label vocabulary:**
  - card wording;
  - month names, for the label check only;
  - カード / クレジットカード / デビットカード / 必須 / 任意.
- **credit/debit/until:** count only alongside "card", or when the field's own name is card-expiry vocabulary. For that check, camelCase is split and card-flow prefixes are accepted.
- **No-partner fallback to combined:**
  - applies to inputs only;
  - not when the part was decided by autocomplete;
  - not when `maxLength` is 1–2.

Each rule is pinned by the CR1–CR8 rows in `cc-expiry-picks.test.ts`, and each row was red-proven against the HEAD before its fix.

## SC3 residuals (best-effort, recorded during code review)
- A label with an unlisted decoration word loses its month.
- A passport month/year pair under a subject-less "Expiry (MM/YY)" label is split across both fields. Main does the same.
