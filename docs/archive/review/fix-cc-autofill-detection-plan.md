# Plan: fix-cc-autofill-detection

Date: 2026-07-11
Branch: `fix/cc-autofill-detection`

## Project context

- Type: web app + browser extension (this change is **extension-only**: `extension/src/content/*`)
- Test infrastructure: unit tests (vitest, jsdom) + CI (extension build/test jobs run in pre-pr.sh and CI)
- Verification environment constraints:
  - **VE1 (blocked-deferred)**: end-to-end verification against the 7 real production sites (JustMyshop, ドスパラ, さくらインターネット, IIJmio, BBexcite, ふるさとチョイス, シラス) requires the user's live accounts/sessions; cannot be exercised locally or in CI. Cost justification: each site's card form is behind login + purchase flow; automated E2E against third-party production payment forms is neither possible nor appropriate. Mitigation: jsdom fixture tests reproduce each site's exact form markup (name/id/label structure) — `verifiable-local`. Final on-site confirmation is delegated to the user after merge.
  - **VE2 (out of scope)**: シラス (Stripe Elements) uses cross-origin iframes; unsupported by design in this PR (SC2).

## Objective

Credit-card autofill fails on major Japanese sites. Three root-cause classes are fixed:

1. **Detection regexes too narrow** (`cc-form-detector-lib.ts` + duplicated copy in `autofill-cc.js`): misses `ccno`/`card_no` (number), `cardExpireMonth`/`card_expire[m]` (expiry), `securitycd`/`conf_num` (CVV), `cardName`/`holder_name`/`meigi` (holder).
2. **Year `<select>` matching does not canonicalize 2-digit vs 4-digit years** (`autofill-cc-lib.ts` + `autofill-cc.js`): stored `"2030"` never matches `<option value="30">30</option>` (ドスパラ).
3. **IDENTITY detector claims CC fields and its dropdown wins the response race** (ふるさとチョイス: card-number input's parent label "カード番号" matches `ADDRESS_JA_RE /…|番号/`; holder input "カード名義人" matches `GIVEN_NAME_JA_RE /名/`; both detectors register `focusin` handlers and the identity response overwrites the CC dropdown → user sees identity candidates, never card entries).

## Requirements

- Functional: after the fix, `detectCreditCardFields` must detect the fields listed per-site in "User operation scenarios" below; year selects must fill for both 2-digit and 4-digit option values; on a CC-claimed field the CC dropdown (not identity) must be shown.
- Non-functional: no new false-positive classes on LOGIN forms (CC detection still gated on card-number presence); no change to the "no fuzzy select match" security posture — year canonicalization is a deterministic bijection (`26 ⇄ 2026`), not a nearest-match; frame-scoping invariants untouched (no `allFrames` change).

## Technical approach

All changes are content-script-side pure logic (regex tables + one normalization function + one detection-time exclusion). No background/API/schema changes. No concurrency primitives involved (no DB probe needed).

**Parallel-implementation constraint** (project invariant): `autofill-cc.js` / `autofill-identity.js` are plain-JS web-accessible resources that CANNOT import modules; the regexes are therefore force-duplicated. Every regex change lands in BOTH copies, and a new parity test (C6) pins the copies together by extracting the literals from the `.js` source text.

### Member-set derivation (R42) — "every copy of the detection regexes is updated in sync"

Defining primitive grep (executed 2026-07-11):

```
grep -rn "card.?num\|カード番号" extension/src --include="*.ts" --include="*.js" | grep -v __tests__
→ extension/src/content/autofill-cc.js:166-167
→ extension/src/content/cc-form-detector-lib.ts:83-84
grep -rn "住所|番地|丁目|番号" extension/src/content/autofill-identity.js extension/src/content/identity-form-detector-lib.ts
→ extension/src/content/autofill-identity.js:163
→ extension/src/content/identity-form-detector-lib.ts:105
```

Member-set: CC regex table = { `cc-form-detector-lib.ts:83-99`, `autofill-cc.js:166-177` }; year normalizer = { `autofill-cc-lib.ts:58-64`, `autofill-cc.js:48-53` }; identity ADDRESS_JA = { `identity-form-detector-lib.ts:105`, `autofill-identity.js:163` }. No other copies exist (popup/background contain no CC field regexes).

## Contracts

### C1 — CC detection regex table update (`extension/src/content/cc-form-detector-lib.ts`)

Replace the five English-hint regexes; JA regexes unchanged. Export the table for the parity test.

```ts
export const CC_DETECT_RE = {
  number:      /card.?num|cc.?num|\bcard.?no\b|\bccno\b|\bpan\b/i,
  name:        /card.?holder|holder.?name|cc.?name|card.?name|name.?on.?card|meigi/i,
  expiryMonth: /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}month|card.?month|cc.?month|expire\W{0,2}mm?\b/i,
  expiryYear:  /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}year|card.?year|cc.?year|expire\W{0,2}yy?\b/i,
  cvv:         /cvv|cvc|csc|cv2|security.?code|security.?cd|\bcard.?verif|card.?code/i,
} as const;
// conf.?num is NOT here — it is a co-located-only CVV fallback (CC_CONF_NUM_RE).
```

Notes locked with rationale:
- `pan` → `\bpan\b`: the current unanchored `pan` matches `japan`, `company`, `expand` — tightening is in-scope because the widened `card.?no` alternation raises the number-detection surface.
- `card.?no\b` → `\bcard.?no\b` and `ccno\b` → `\bccno\b` (Phase 3 code-review, user-approved): the trailing-only boundary matched any `*_card_no` field (`loyalty_card_no`, `insurance_card_no`, `student_card_no`, member/library/point-card numbers) — a member-card-number field would surface a spurious CC-number suggestion. Same-page misfill is security-benign (user must still pick from the dropdown; SC4/S2 bound) but is a UX false-positive. Adding the leading `\b` rejects the mid-word `_card_no` class while keeping every target-site hint (`ccno`, `card_no`, `cardnumber`, `creditcardnumber`) — verified. Consistent with the `\bpan\b` tightening rationale. Decoy counter-fixture (d) + matrix rows added (C7).
- Month/year use the bounded prefix `exp(?:ir(?:y|e|ation))?` (NOT `exp\w*`) so `export_month` / `expected_month` / `experience_month` are rejected while `expmonth`, `exp_month`, `expiry-month`, `expiration_month`, `cardexpiremonth` still match (F1). The verification matrix is **committed as a table-driven `it.each` test** against the exported `CC_DETECT_RE` (T12), not a one-off run — see C7 "regex matrix" row.
- `expire\W{0,2}mm?\b` / `yy?\b` covers BBexcite `card_expire[m]` / `card_expire[Y]`; the literal `expire` prefix prevents `expiry` (trailing `y`) from matching the year regex.
- `\bcard.?verif` covers ふるさとチョイス `js-card_verification_code` by name/id. The `card` prefix is required so bare OTP-style `verification_code` fields do NOT match (F2); the leading `\b` (S5) additionally rejects mid-word `card` (`discard verification`) while `js-card_…`'s hyphen still provides the boundary. 3DS/ACS OTP pages are further neutralized by the card-number gate (no card-number input on ACS pages → detection returns null). Independently, that site's CVC field also carries `label[for]` = セキュリティコード, which the unchanged `CC_CVV_JA_RE` matches — the C7 fixture asserts BOTH paths (name-based and label-based) explicitly rather than relying on either silently.
- `conf.?num` (ドスパラ `conf_number`) — **REMOVED from the page-wide `CC_DETECT_RE.cvv` alternation (Phase 3, user-directed).** SC4 had accepted it as "same-page misfill within the trust boundary", but the concrete risk is sharper: when the real CVV field lacks `autocomplete="cc-csc"` (typical on JP sites), CVV detection falls to the regex fallback, which is first-match-wins over the whole document — an unrelated `conf_number` field (order/booking confirmation) appearing before the real CVV would receive the CVV write, potentially submitting the secret to a different form/log. Fix: `conf.?num` is now a **co-located** fallback only — the exported `CC_CONF_NUM_RE` matches a `conf_number` field ONLY when it shares the card-number field's `<form>` (or, on form-less table-based pages like ドスパラ, a common ancestor tighter than `<body>`), via `findConfNumCvvInForm` / `isCoLocatedWith`. Strong CVV signals (cvv/cvc/csc/security_code/`\bcard.?verif`) still win page-wide and run first. Both copies (lib + .js) mirror the helper; parity test pins `CC_CONF_NUM_RE` and asserts `conf` is absent from `CC_DETECT_RE.cvv`. Security regression tests: unrelated-section conf_number → cvv null (detection AND fill paths), co-located → claimed, strong-signal-wins. Mutation-verified (neutralizing `isCoLocatedWith` reddens both the detection and fill security tests).
- Detection priority (autocomplete `cc-*` first, regex fallback second) and the card-number-required gate at `detectCreditCardFields` are unchanged.
- Combined-vs-split ordering (F3): `CC_EXPIRY_RE` (`card.?exp`) matches BBexcite's `card_expire[m]` hint, but the combined branch only claims `HTMLInputElement`s — captured page HTML confirms `card_expire[m]`/`card_expire[Y]` are `<select>` elements on the real site, so the split month/year regexes are reached. The C7 BBexcite fixture MUST use `<select>` for these two fields to mirror reality.

Invariants (app-enforced): I1 — `CC_DETECT_RE` in the lib and the literals in `autofill-cc.js` are byte-identical (enforced by C6 test, which is the strongest form available — the `.js` file cannot import, so schema-level sharing is impossible).

Acceptance: the per-site fixture matrix (C7) passes.

### C2 — Mirror regex table into `extension/src/content/autofill-cc.js` (lines 166-177)

Same five literals, `var` style, byte-identical regex bodies. Consumer-flow walkthrough: consumer is `performCreditCardAutofill` in the same file — reads each regex to locate fields at fill time; the inline dropdown path (C1 consumer: `initCreditCardDetector` → `ccFields` WeakSet) and the fill path (C2) must agree on which element is the card-number field, otherwise the dropdown appears on a field the fill script won't fill. Byte-identical tables guarantee agreement.

### C3 — Year canonicalization (`autofill-cc-lib.ts` `normalizeYearValue` + `autofill-cc.js` copy)

```ts
function normalizeYearValue(value: string): string;
// trim → parseInt; NaN → trimmed input unchanged;
// 0 <= n <= 99  → String(2000 + n)   // "26"→"2026", "05"→"2005"
// otherwise     → String(n)          // "2030"→"2030", "2026年"→"2026"
```

- Canonicalizes 2-digit years to `20xx`; values outside `[0,99]` pass through unchanged (they match only if the select's raw value/text already equals the stored form). NOT a fuzzy/nearest match — the existing "silent failure on no exact match" branch stays. Security review confirmed the pass-through creates no unexpected-match risk (F5/S-verify #2).
- `setSelectValue` logic (value-first, textContent-fallback) unchanged.
- Consumer-flow walkthrough: sole consumers are the two `setSelectValue(expiryYear, …, normalizeYearValue)` call sites (lib + .js); both receive the same canonical 4-digit form on both sides of the comparison. Month normalizer untouched.
- Verified (T6): no existing test exercises a 2-digit year option — C3's tests are purely additive; no existing assertion changes.

Acceptance: ドスパラ fixture (options `value="26"`…`"35"`, 2-digit text; stored "2030" → canonical "2030" matches option `value="30"`), さくら fixture (4-digit values `2026`-`2045`), ふるさとチョイス fixture (`value="30"`, text `"2030年"` → textContent-fallback parseInt path).

### C4 — CC-priority arbitration in identity detection (`extension/src/content/identity-form-detector-lib.ts`)

`detectIdentityFields(root)` first calls `detectCreditCardFields(root)` (import from `cc-form-detector-lib`; no import cycle — cc lib does not import identity lib) and excludes every element claimed by the CC detection from `visibleFields` before identity matching. Effects:

- A field claimed by BOTH detectors (ふるさとチョイス card_no, holder_name) belongs to CC only → identity `focusin` handler no longer requests/renders a dropdown for it → the CC dropdown is no longer overwritten by the identity response race.
- Pure identity pages: `detectCreditCardFields` returns null (no card number) → exclusion is a no-op.
- Mixed checkout pages (identity + CC sections): identity keeps its non-CC fields; fieldCount threshold (≥2) now counts only non-CC fields.

Invariant (app-enforced) I2: an element present in the CC detection result is never present in the identity detection result for the same root. Acceptance: extended T7 test — overlap field focus → `GET_CC_MATCHES_FOR_URL` only, never `GET_IDENTITY_MATCHES_FOR_URL`.

### C5 — Tighten `ADDRESS_JA_RE`: drop `番号` (`identity-form-detector-lib.ts:105` + `autofill-identity.js:163`)

`/住所|番地|丁目|番号/` → `/住所|番地|丁目/`. Rationale: `番号` alone claims カード番号 / 郵便番号 / 電話番号 / 会員番号 as "address" (the ADDRESS search runs before POSTAL/PHONE, so it steals those fields today). JP address forms are reliably hinted by 住所/番地/丁目. Both copies updated (member-set above). **`export` the `ADDRESS_JA_RE` const** (currently unexported at `identity-form-detector-lib.ts:105`) so the C6 parity test can pin against the imported symbol, not a hardcoded string (T13).

### C6 — Regex parity test (new: `extension/src/__tests__/content/cc-regex-parity.test.ts`)

Follows the repo's established one-stage twin-sync pattern (`token-bridge-js-sync.test.ts` / `autofill-js-sync.test.ts` / `c11-constants-sync.test.ts`): import the `.js` source via `?raw` and assert containment of the TS-side regex literal — NO extract-then-compare second regex (T1).

- One `it()` per pinned item, each independently red-provable (T2).
- **Pin the FULL delimited literal, flags included — `RegExp.prototype.toString()`, NOT `.source`** (F6+S6+T9 convergence, Major). `.toContain(RE.source)` is append-blind: after C5, `ADDRESS_JA_RE.source === "住所|番地|丁目"` is a substring of the forbidden widened form `"住所|番地|丁目|番号"`, so a `.js`-only reintroduction of `|番号` (the exact regression Forbidden-pattern 4 bans) stays green; the same one-directional blindness lets any `.js`-only alternation append (`…|extra/i`) pass, and `.source` drops the `/i` flag so a lost flag diverges silently. Using the full literal closes both directions:
  1-5. `expect(autofillCcRaw).toContain(CC_DETECT_RE.number.toString())` … one per CC regex (number, name, expiryMonth, expiryYear, cvv). `.toString()` yields e.g. `/card.?num|cc.?num|card.?no\b|ccno\b|\bpan\b/i` — closing `/i` included, so append/prepend drift AND flag drift both break containment.
  6. `expect(autofillIdentityRaw).toContain(ADDRESS_JA_RE.toString())` (C5 parity — the closing `/` makes `|番号`-reintroduction fail).
  7. Explicit negative for the forbidden pattern: `expect(autofillIdentityRaw).not.toMatch(/addrJa\s*=[^;]*番号/)` (belt-and-suspenders on Forbidden-pattern 4).
  8. Year-normalizer pins (C3 parity): `expect(autofillCcRaw).toContain("return String(2000 + num)")` AND `expect(autofillCcRaw).toContain("num >= 0 && num <= 99")` (pin the `[0,99]` guard line too, not just the mapping line, so a `.js`-side range drift like `<= 999` is caught — F6).
- Requires `ADDRESS_JA_RE` be exported from `identity-form-detector-lib.ts` (T13; add the `export` in C5) and `CC_DETECT_RE` exported from `cc-form-detector-lib.ts` (C1). Pinning against a hardcoded string instead of the imported symbol would defeat the pin (test passes even when the lib copy drifts).
- Note: today `autofill-cc.js`'s regex table has ZERO test coverage (verified) — this contract closes a real, currently-unenforced drift gap, not a hypothetical one.

### C7 — Per-site fixture tests (extend `cc-form-detector.test.ts`, `autofill-cc.test.ts`, `cc-identity-detector.test.ts`)

jsdom fixtures reproducing each site's field naming/label structure (trimmed to the structural essentials, no real personal data):

| Site fixture | Asserts |
|---|---|
| ドスパラ (`ccno`, `exp_month`/`exp_year` selects w/ 2-digit opts, `conf_number`, `ccmeigi`) | number/expiry/cvv/name detected; year "2030" fills option value "30" |
| BBexcite (`card_no`, `card_expire[m]`/`card_expire[Y]`, `security_code`, `holder_name`) | all five detected |
| JustMyshop (`cardNumberText`, `cardExpireMonth/YearSelect`, `cardSecurityCode`, `cardNameText`, decoy `cardBirthMonth/Day` selects) | expiry selects detected; birth selects NOT claimed as expiry |
| IIJmio (`creditCardNumber`, `creditCardExpireYear/Month`, `creditCardSecurityCode`, disabled owner inputs) | number/expiry/cvv detected; disabled name inputs skipped |
| さくら (`cardnumberinput`, `securitycdinput`, label-wrapped 月/年 selects w/ 4-digit opts, `cardholdernameinput`) | cvv now detected; year 4-digit fill |
| ふるさとチョイス (label-hinted `card_no` type=tel, `holder_name`, `js-card_verification_code` w/ `label[for]`=セキュリティコード, month/year selects w/ `2030年` text) | CC detects all — CVC asserted via BOTH the `card.?verif` name path AND the label path (two fixture variants); `detectIdentityFields` excludes card_no+holder_name |
| T7-extension (overlap race, T5+T11 spec) | ONE form containing: a **holder** overlap field (`name="holder_name"` + `<label>カード名義人</label>` — CC-claimed via `holder.?name`/名義, AND identity-claimed via `GIVEN_NAME_JA_RE /名/` **which survives C5**, so it is de-claimed only by C4) + the card-number field (`name="card_no"` + `<label>カード番号</label>`) + ≥2 genuinely non-CC identity fields (郵便番号, 住所). Assert: **focus the holder field → `GET_CC_MATCHES_FOR_URL` exactly once AND `GET_IDENTITY_MATCHES_FOR_URL` zero times.** This is red under a C4-alone revert (holder still in the identity WeakSet via 名 → both fire), so it genuinely pins C4's I2 invariant — NOT `card_no`, whose identity claim vanishes under C5 alone and would leave the test green on C4 revert (T11). Also assert: focus 住所 field → identity dropdown still works (exclusion didn't over-reach). The ≥2 non-CC identity fields keep post-fix `fieldCount≥2`, isolating the exclusion mechanism from the fieldCount mechanism. **Do NOT add a focus-`card_no` → GET_IDENTITY-zero assertion** (T14): post-C5 `card_no` carries no identity claim, so that assertion passes on a C4 revert (the T11 trap); `card_no` is present ONLY to satisfy the card-number-required gate so CC detection runs — assert C4's effect on the holder field alone |
| fieldCount boundary (T10 spec — corrected) | mixed fixture: 1 CC card-number field + 1 **holder** overlap field (`holder_name`+カード名義人, identity claim survives C5) + **exactly 1** genuine non-CC identity field (郵便番号). Pre-fix / C4-reverted: identity fieldCount=2 (holder + 郵便番号) → identity form detected. Post-C4: holder excluded → fieldCount=1 → `detectIdentityFields` returns null. Red-provable on C4 revert. (The earlier "0 other identity fields" spec was vacuous — fieldCount<2 pre-exclusion too, so it stayed null with C4 reverted; T10 corrects it) |
| Negative / counter-fixtures (T3) | (a) form with `japan_flag`/`company_name`/`expand_section` and no real card field → `detectCreditCardFields` null (pins `\bpan\b`); (b) lone `confirmation_number` field, no card number → null (proves the SC4 gate explicitly); (c) `export_month`/`expected_month` decoy select inside a REAL CC form → expiryMonth `.toBe(legitimateExpirySelect)`, not the decoy |
| Regex matrix (T12) | table-driven `it.each` over `[hint, matchesNumber?, matchesName?, matchesMonth?, matchesYear?, matchesCvv?]` asserting each field of `CC_DETECT_RE` directly (imported symbol): all target-site hint strings (per site) MATCH their field; decoys (`export_month`, `expected_month`, `experience_month`, `cardbirthmonth`, `verification_code`, `discard verification`, `japan`, `company`, `expand`, `card_note`) are REJECTED by the relevant field. Committed, not a one-off node run |
| Regression | existing autocomplete/`cc-*`, combined-expiry, and login-form non-detection tests keep passing; a plain identity form (住所/氏名/郵便番号) still detects WITHOUT `番号`-dependent hints |

Assertion style (T4): all "decoy NOT claimed" checks pin element identity — `expect(fields!.expiryMonth).toBe(<legitimate select>)` — never truthiness or `.not.toBe(decoy)` alone (mirrors the kana-disambiguation pattern in `identity-form-detector.test.ts`).

## Forbidden patterns

- `pattern: /pan/i` (unanchored `pan` alternation in any CC number regex) — reason: false-positives on japan/company/expand; must be `\bpan\b`.
- `pattern: allFrames` — reason: injection stays frame-scoped (autofill frame-origin gate invariant); this PR must not touch injection targets.
- `pattern: levenshtein|closest|fuzzy` in select matching — reason: security review banned nearest-match option selection; only exact match after deterministic canonicalization.
- `pattern: 番号` inside `ADDRESS_JA` in either identity copy — reason: C5 removes it; reintroduction regresses ふるさとチョイス.

## Testing strategy

- Unit (jsdom): C7 fixture matrix + C6 parity pins + existing suites (`npx vitest run` in `extension/`).
- Build: `cd extension && npm run build` (CRXJS bundling of form-detector.ts; .js resources copied as-is).
- Root repo: `npx vitest run` unaffected (no `src/` change) but run per Mandatory Checks; `npx next build` skipped — extension-only change (per established practice for changes with no web-app surface; extension has its own build).
- Manual (user, post-merge): re-test the 6 non-Stripe sites (VE1).

## Considerations & constraints / Scope contract

- **SC1**: Structural heading hints (`<th>`/`<p class="sub_ttl">` proximity text) — deferred. The regex widening covers all 6 target sites without it. Owner: future issue (detection-heuristics enhancement).
- **SC2**: シラス / Stripe Elements (cross-origin iframe fill) — out of scope; requires a per-frame injection design that conflicts with the S2 cross-origin-subframe guard; needs its own threat-model review. Owner: separate design discussion.
- **SC3**: Identity-fill-time arbitration inside `autofill-identity.js` (fill script cannot import CC detection; inlining it would duplicate ~80 lines). After C5, the only residual overlap is holder-name-type fields (名義 contains 名) — misfill risk is a name-into-name-field, low harm, and identity fill is always user-initiated per entry pick. Owner: revisit only if a real misfill report arrives.
- **SC4**: `conf.?num` CVV alternation genericism — **ACCEPTED by security review (S2)**: card-number-required gate is sufficient; residual risk = same-page misplacement within user-accepted trust boundary. Counter-fixture mandated (C7 negative row b).
- **SC5 (S1, accepted)**: C4 doubles per-rescan DOM-scan cost on the pre-existing un-throttled MutationObserver. Worst case: perf jank on adversarial rapid-mutation pages; likelihood low; cost to fix (shared single-pass scan across detectors) exceeds the 30-min bar with regression risk. TODO(fix-cc-autofill-detection): shared scan if perf complaints arrive.
- Verified (T6): NO existing test relies on bare `番号` as an address hint (occurrences are the unrelated login-id test's カード番号 and 郵便番号, which `POSTAL_JA_RE` claims before the address fallback) — C5 requires no existing-test updates; new fixtures only.

## User operation scenarios

1. ドスパラ月額サービスのカード登録: focus カード番号 (`name=ccno`) → CCドロップダウン表示 → エントリ選択 → 番号/名義(`ccmeigi`)/期限(2桁select)/セキュリティコード(`conf_number`, type=password)が入る。
2. BBexcite カード変更: `card_no`/`holder_name`/`card_expire[m]`/`[Y]`/`security_code` 全て入る(reCAPTCHAは手動)。
3. JustMyshop: 期限selectが入り、誕生日select(`cardBirthMonth/Day`)には書き込まない。
4. IIJmio: 名義欄はdisabledなので触らない(正しい挙動)。期限・CVCが入る。
5. さくら: セキュリティコード(`securitycdinput`)が入るようになる。
6. ふるさとチョイス: カード番号欄フォーカスで個人情報候補ではなく**カード候補**が出る。個人情報フォーム(住所/氏名)では従来どおり個人情報候補が出る。

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | CC detection regex table update (lib)                          | locked |
| C2  | Regex mirror in autofill-cc.js                                 | locked |
| C3  | Year 2/4-digit canonicalization (lib + .js)                    | locked |
| C4  | CC-priority exclusion in detectIdentityFields                  | locked |
| C5  | ADDRESS_JA_RE drops 番号 (lib + .js)                            | locked |
| C6  | Regex parity pin test (.js ↔ lib)                              | locked |
| C7  | Per-site fixture test matrix                                   | locked |

## Implementation Checklist

Files to modify (member-set verified by grep 2026-07-11):
- [ ] `extension/src/content/cc-form-detector-lib.ts` — replace CC_NUMBER_RE/CC_NAME_RE/CC_EXPIRY_MONTH_RE/CC_EXPIRY_YEAR_RE/CC_CVV_RE with the exported `CC_DETECT_RE` object (C1); rewire `findFieldByRegex` call sites to `CC_DETECT_RE.*`.
- [ ] `extension/src/content/autofill-cc.js` — mirror the 5 regex literals byte-identically (C2).
- [ ] `extension/src/content/autofill-cc-lib.ts` — `normalizeYearValue`: `0..99 → String(2000+n)` (C3).
- [ ] `extension/src/content/autofill-cc.js` — mirror `normalizeYearValue` (C3).
- [ ] `extension/src/content/identity-form-detector-lib.ts` — `ADDRESS_JA_RE` drop `番号`; add `export` (C5, T13).
- [ ] `extension/src/content/autofill-identity.js` — mirror `addrJa` (drop `番号`) (C5).
- [ ] `extension/src/content/identity-form-detector-lib.ts` — `detectIdentityFields` runs `detectCreditCardFields(root)` first, excludes CC-claimed elements from `visibleFields` (C4). Import from `./cc-form-detector-lib` (no cycle — verified cc lib does not import identity lib).

Test trees (R19 — all 4 enumerated):
- [ ] `extension/src/__tests__/content/cc-form-detector.test.ts` — per-site detection + negative + regex matrix (C7)
- [ ] `extension/src/__tests__/content/autofill-cc.test.ts` — year 2/4-digit fill fixtures (C3/C7)
- [ ] `extension/src/__tests__/content/cc-identity-detector.test.ts` — T7-extension race + fieldCount boundary (C4/C7)
- [ ] `extension/src/__tests__/content/identity-form-detector.test.ts` — verify no break from C5 (T6: none expected)
- [ ] `extension/src/__tests__/content/cc-regex-parity.test.ts` — NEW, full-literal `.toString()` pins + negative + year-guard pin (C6)

Reuse (R1/R17): none — in-place edits to existing regex tables/functions only; no new shared helper. `?raw` twin-sync precedent: `autofill-js-sync.test.ts`.

CI parity: extension test+build run in BOTH CI and scripts/pre-pr.sh (verified). No parity gap.
