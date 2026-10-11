# Coding Deviation Log: login-detection-skips-cc-fields

## D1: the single-character JA month/year patterns are not card-neighbour hints (C2)

- C2 counts "the expiry regexes (Latin or JA)" as card-neighbour hints. `CARD_NEIGHBOUR_PATTERNS` (`lib/cc-patterns.ts`) leaves out `CC_EXPIRY_MONTH_JA_RE = /月/` and `CC_EXPIRY_YEAR_JA_RE = /年/`.
- `detectCreditCardFields` uses those two only next to a card number it has already found. As neighbour hints they would let a birth-date field (生年月日) or any dated field anchor a card block. Without them, a field labelled only 月 / 年 is not a card neighbour.
- The combined JA expiry pattern (有効期限) is kept.

## D2: `login-field-eligibility` imports only `lib/cc-patterns` (C1)

- C1's graph has `cc-field-detection-lib ← login-field-eligibility`. `isLoginEligible` takes the card-form set as a parameter, so the module needs only `LOGIN_AUTOCOMPLETE_TOKENS`.
- `form-detector-lib` and `autofill-lib` call `ccFormFields` directly, which is the C1 edge added in revision 6. The graph stays acyclic.

## D3: a lazy card-form source (C4/C5)

- `form-detector-lib` exports `lazyCcForm(): CcFormSource`, a thunk that scans `ccFormFields(document)` on first call only.
  - `findPasswordInputs(root, ccForm = lazyCcForm())` calls it only when a raw password input exists.
  - `findUsernameInput(passwordInput, ccForm = null)` filters only when given a source. `null` is input tracking (`scanInputs`).
- One source is shared across `shouldTriggerForInput`'s associated-password lookup and its final eligibility check, and across the whole `PSSO_TRIGGER_INLINE_SUGGESTIONS` handler. The login detector likewise shares one source through `shouldSkipForm` and the capture.
- This is how C4's "computed once per invocation" and NF3 are realised.

## D4: the shape of the `directAutofill` pattern arg (C6)

- C6 names `ccPatternsArg?: { [key]: { source, flags } }`. The implementation passes `{ number: PatternSource[]; neighbour: PatternSource[] }`, built from `CARD_NUMBER_PATTERNS` / `CARD_NEIGHBOUR_PATTERNS` (`CARD_PATTERN_SOURCES`). The content side's `ccFormFields` reads the same two lists, so the matcher sets are one definition.
- `directAutofill`'s `isVisible` gains the opacity rule (≤ 0.05 counts as hidden), as C6 requires for parity. That also applies to its custom-field and write checks.

## D5: `collectCcFields` removed; expiry formatting stays put (C1)

- The CC detector's `rescan` now fills its WeakSet from `ccClaimedFields(document)`.
- `detectExpiryFormat` and `formatCombinedExpiry` stay in `cc-form-detector-lib.ts`. `autofill-cc-lib` imports them from there and the detection symbols from `cc-field-detection-lib`.

## D6: parity pins three username-walk divergences that predate this change (C6)

C6 says the parity test asserts the same password and username targets. Three fixtures pin a different username target instead, with the reason in the test. In each, both implementations agree on the password target and on what the card-form rule excludes. The divergence is in the username fallback walk, which predates this change:

- `directAutofill` takes the nearest preceding usable text field;
- `performAutofill`'s `findUsernameInput` also requires a username-shaped hint (`isUsernameLike`).

The fixtures, all in `__tests__/background/direct-autofill-parity.test.ts`:
- **8, hidden card number:** the twin stops on the hidden field and writes nothing.
- **14, lone card number:** the card number is not excluded (S12), so the twin's walk fills it.
- **15, `利用者カード番号` login:** `isUsernameLike` has no card-number term, so the content fill writes no username. The twin fills it.

Anti-Deferral:
- **Not fixed here.** Mirroring `isUsernameLike` inside the self-contained twin would duplicate its whole Latin/JA hint grammar into a function that `#878` deletes.
- **Worst case:** on the fallback path only, the username lands in a visible text field before the password, as on `main`. No password or CVV is involved.
- **Owner:** `#878`.
- The divergences are pinned, not hidden, so the parity test fails if either side changes.

## D7: card fields placed directly under `<body>` form no card block (C2 known gap)

- The ancestor search stops below `<body>` so that the whole page never becomes the card block. A card number whose card neighbours are siblings directly under `<body>`, with no wrapping element, therefore forms no block, and those fields stay LOGIN-eligible, as on `main`.
- This is the same class as F-S10 (layout coverage the change does not reach, not a widening), and it fails toward today's behaviour.
- Fixtures wrap card fields in a `<form>`, `<table>` or `<div>`, so the rule is exercised. A test fixture that was accidentally flat was caught by its red proof and fixed during Phase 2.

## D8: the CC detector's CVV claim prefers the card block (supersedes NF2/SC2 for the CVV claim)

- NF2/SC2 kept `detectCreditCardFields` unchanged. Code review round 1 (F-F2) showed what that left in place under the FR4 fixture: the CVV regex's first page-wide match is an earlier login `security_code` field.
  - The CC detector claims that field and opens the CC dropdown on it, competing with LOGIN's.
  - A CC fill writes the card's CVV into the login field.
- The defect predates this change and lies in the PR's own scenario, so it is fixed here.
- The fix: the regex fallback for `cvv` now prefers a match inside the card block (`cardBlock`, the same rule as C2). Without a block it falls back to the first page-wide match, as before.
  - The `cc-csc` autocomplete priority and the `conf.?num` fallback are unchanged, as are the other roles (number, name, expiry).
- Tests in `cc-form-detector.test.ts` cover both cases: the in-block CVV is claimed over an earlier login `security_code`, and with no block the first page-wide match is claimed as before. Red proof: the first-match-only claim fails the in-block test.
