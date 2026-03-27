# Code Review: sample-data-and-unused-code
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening (0 findings)
No issues found.

## Functionality Findings

### F-1 [Minor] `autofill.js` loop variable `var lower` closure pattern
- **Problem:** `var lower` in a `for` loop captured by `inputs.find()` callback. Since `find()` executes synchronously, no actual bug occurs.
- **Impact:** None currently. Potential confusion for future readers.
- **Recommended action:** Accept as-is. Plain JS file intentionally avoids `let`/`const` for older runtime compat.

### F-2 [Major → Dismissed] URL-type custom fields in sample data
- **Problem:** Sample data adds `url` type custom fields; concern about whether they function for multi-URL matching.
- **Resolution:** By design, `url` type custom fields are extracted as `additionalUrlHosts` in `buildPersonalEntryPayload`. They are not intended for form autofill. The sample data correctly demonstrates the multi-URL matching feature. No change needed.

## Security Findings

### S-1 [Major] `autofill-cc.js` and `autofill-identity.js` missing `sender.id` check
- **Problem:** Message listeners in `autofill-cc.js` (line 243) and `autofill-identity.js` (line 187) do not verify `sender.id === chrome.runtime.id`. Both are `web_accessible_resources`.
- **Impact:** External web pages could potentially send crafted messages to trigger credit card or identity autofill.
- **Action:** Fixed — added `sender.id === chrome.runtime.id` check to both files.

### S-2 [Minor] `form-detector-lib.ts` / `login-detector-lib.ts` listeners lack `sender.id` check
- **Problem:** Content script message listeners don't verify sender. No `externally_connectable` in manifest, so no immediate attack vector.
- **Action:** Accepted as minor. Out of scope for this branch.

### S-3 [Minor] Sample data uses real routing number / SWIFT code
- **Problem:** `routingNumber: "021000021"` (JPMorgan Chase) and `swiftBic: "BOFAUS3N"` (Bank of America) are real values.
- **Action:** Accepted. These are in a clearly-labeled sample/test context and pose no security risk.

## Testing Findings

### T-1 [Minor] No test for custom field target excluding focused input
- **Problem:** The `effectiveFocusedUsername` / `isCustomFieldTarget` exclusion path is not explicitly tested.
- **Action:** Accepted. The existing custom field tests cover the core logic; the exclusion path is a defensive guard.

### T-2 [Minor] No CI lint/parity check for `autofill.js`
- **Problem:** `autofill.js` is a plain JS copy of `autofill-lib.ts` logic with no automated parity verification.
- **Action:** Pre-existing issue. Out of scope for this branch.

### T-3 [Critical] `autofill.js` has no test coverage (pre-existing)
- **Problem:** `autofill.js` is never executed by Vitest. All tests exercise `autofill-lib.ts` only.
- **Action:** Pre-existing, accepted in prior review (`split-otp-autofill-code-review.md` T5). Out of scope.

## Adjacent Findings
None.

## Resolution Status

### S-1 [Major] `sender.id` check missing in autofill-cc.js and autofill-identity.js
- Action: Added `sender.id === chrome.runtime.id` check to both message listeners
- Modified files: `extension/src/content/autofill-cc.js:243`, `extension/src/content/autofill-identity.js:187`

All actionable findings resolved. Remaining items are pre-existing or accepted as minor.
