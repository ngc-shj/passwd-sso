# Plan: LOGIN detection skips fields the CC detector claims (`#877`)

Revision 6 (after plan review rounds 1-3 incl. Opus-tier security, see `login-detection-skips-cc-fields-review.md`).

## Project context

- Type: browser extension (MV3, CRXJS/Vite, TypeScript) inside the web app repo.
- Test infrastructure: unit (vitest + jsdom) + CI. The extension's gates are `tsc` (via `npm run build`), vitest, and `scripts/checks/lint-extension.mjs`.
- Verification environment constraints:
  - **VE1**: real-site behaviour on a page holding both a login form and a card form needs the installed extension. Manual, `blocked-deferred` to the user. It uses the tailscale-served scratch pages from `#880` (ports other than 8443).

## Problem

`detectCreditCardFields` claims card fields (number, name, expiry, CVV) once a card-number field exists on the page. LOGIN detection does not exclude them, which produces three overlaps:

1. **Fill (`autofill-lib.ts`, at T0 and relocate).**
   - `findPasswordInput` takes the last visible `type=password` input, which can be a masked CVV.
   - The OTP finders can pick a field the CVV regex also claims, because both regexes contain `security.?code` / `セキュリティコード`.
2. **Inline trigger (`form-detector-lib.ts`).** `shouldTriggerForInput` opens the LOGIN dropdown on any `type=password` input, so the LOGIN dropdown and the CC dropdown compete on a masked CVV.
3. **Direct fallback (`background/direct-autofill.ts`).** `directAutofill`'s `findPasswordInScope` repeats the same last-visible-password heuristic, with no CC awareness. It runs when the first send and the pinned bundle injection both fail, for example on a page outside the bundle's manifest scope.
4. **Save capture (`login-detector-lib.ts`).** On submit of a checkout form whose only password field is a masked CVV, the CVV can be captured as a login password. It is then sent to the background as a pending save, and the user is offered a "save login" banner.

Two constraints shape the fix:

- The CC detector's CVV regex match is page-wide. Excluding every claimed field from LOGIN would therefore also exclude an unrelated login field, such as a `security_code` password or one cell of a `security-code-N` split OTP, whenever any card number exists on the page.
- `cc-form-detector-lib.ts` imports `form-detector-lib.ts`. The exclusion logic cannot live in the former and be imported by the latter without creating a cycle (R10).

## Requirements

- **FR1.** A field that the CC form owns is not a LOGIN password, username or OTP candidate. This applies in fill (T0 and relocate), in the inline trigger, and in save capture.
- **FR2.** User decision: a field whose `autocomplete` explicitly declares a LOGIN role (`username`, `email`, `current-password` or `one-time-code`) stays LOGIN-eligible. The page's own declaration wins, as in D14 of `autofill-sequential-fill-deviation.md`.
- **FR3.** A page with no card number keeps today's behaviour exactly.
- **FR4.** A CC-regex match that is not part of the card form does not lose LOGIN eligibility (C2). Examples are a login password named `security_code`, or a split OTP named `security-code-N` in a separate login form.
- **NF1.** Custom-field targets are unchanged (SC1).
- **NF2.** The CC detector's own claims and the identity detector's exclusion are unchanged in behaviour (SC2). Only their code location moves (C1).
- **NF3.** No added full-document scan per focus event when the field could not trigger LOGIN anyway, and at most one card scan per fill tick (C3, C4).

## Contracts

### C1: module layout (acyclic)

- **New leaf `extension/src/content/field-query-lib.ts`.** It holds the pure helpers moved from `form-detector-lib.ts`: `isUsableInput`, `isUsableFieldOfType`, `resolveOpacity`, `isElementVisible`, `getHintString`, `getAutocomplete` (module-private), `findFieldByAutocomplete` and `findFieldByRegex`. It imports nothing from `content/`.
  - `resolveOpacity` becomes exported. It was module-private before; `isElementVisuallySafe`, `isPageVisuallySafe` and `hasVisiblePopoverOverlayNear`, which stay in `form-detector-lib.ts`, still call it.
- **New DOM-free leaf `extension/src/lib/cc-patterns.ts`.** It holds the CC hint regexes (`CC_DETECT_RE`, the JA regexes, `CC_CONF_NUM_RE`, the expiry regexes) and `LOGIN_AUTOCOMPLETE_TOKENS`. Both `cc-field-detection-lib` and the service worker import it, so the patterns have one definition (C6).
- **New `extension/src/content/cc-field-detection-lib.ts`.** It holds `CreditCardFormFields`, the CC field allowlist (`isUsableField` / `FILLABLE_INPUT_TYPES`), `isCreditCardFillable`, `looksLikeCvvField`, `isCoLocatedWith`, `findConfNumCvvInForm` and `detectCreditCardFields`, all moved from `cc-form-detector-lib.ts`.
  - It adds `ccClaimedFields` and `ccFormFields` (C2).
  - It imports the regexes from `lib/cc-patterns.ts` and does not redefine them. Its other import is `field-query-lib`.
  - `detectExpiryFormat` and `formatCombinedExpiry` stay in `cc-form-detector-lib.ts`.
- **New `extension/src/content/login-field-eligibility.ts`.** It holds C2's predicates and imports only `cc-field-detection-lib`.
- **Callers.** `form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`, `autofill-lib.ts` and `autofill-cc-lib.ts` import from these modules directly. There are no re-export barrels. Every importer of a moved symbol is updated (R19). The test importers known now are:
  - `__tests__/content/cc-form-detector.test.ts`, whose import line splits three ways;
  - `__tests__/content/form-detector.test.ts` (`isUsableInput`).
- **Invariant:** the dependency graph has no cycle.
  - Check: `rg "^import" extension/src/content extension/src/lib/cc-patterns.ts` shows these edges and no others:
    - `cc-patterns ← cc-field-detection-lib`;
    - `field-query-lib ← cc-field-detection-lib`;
    - `cc-field-detection-lib ← login-field-eligibility ← {form-detector-lib, autofill-lib}`;
    - `cc-field-detection-lib ← {form-detector-lib, autofill-lib}`, which call `ccFormFields` directly;
    - `field-query-lib ← {form-detector-lib, cc-form-detector-lib, identity-form-detector-lib}`;
    - `cc-field-detection-lib ← {cc-form-detector-lib, identity-form-detector-lib, autofill-cc-lib}`.
  - `cc-form-detector-lib` and `identity-form-detector-lib` import the lower modules, never the reverse.
- Identity detection's inline claim loop and the CC detector's `collectCcFields` both use `ccClaimedFields` (R1).

### C2: what LOGIN excludes

```ts
// cc-field-detection-lib.ts
export function ccClaimedFields(root: ParentNode): Set<HTMLElement>; // every non-null field of detectCreditCardFields(root)
export function ccFormFields(root: ParentNode): Set<HTMLElement>;
// login-field-eligibility.ts
export function hasExplicitLoginAutocomplete(el: HTMLInputElement): boolean;
export function isLoginEligible(el: HTMLInputElement, ccForm: ReadonlySet<HTMLElement>): boolean;
```

- **`ccFormFields(root)`** is the set of fields that belong to the card form. It is built by a scan, not from `detectCreditCardFields`' single-valued claims: `detectCreditCardFields` claims one CVV, the first DOM match, so a `security_code` login field earlier in the page would take that claim and leave the real masked CVV unclaimed.
  - **Empty** when `detectCreditCardFields(root)` finds no card number.
  - **CC-hinted field.** A visible field (`isElementVisible`, which includes the opacity rule) that passes `isUsableField` (`FILLABLE_INPUT_TYPES`; inputs and selects), and either:
    - has a `getHintString` matching the CVV, expiry or holder-name regexes (Latin or JA, from `cc-patterns`; `conf.?num` excluded); or
    - carries a `cc-*` token.
  - **Card number.** The card number is the one `detectCreditCardFields` chose: the first `cc-number` token, else the first regex match among visible, usable fields.
  - **Card block.** Otherwise the card block is found as follows:
    - When the card number's form (`cardNumber.form`) holds another CC-hinted field, the block is that form. Membership is `form.contains(el) || el.form === form`, which covers `form=`-associated fields.
    - Otherwise the block is the lowest ancestor of the card number, below `<body>`, that also contains another CC-hinted field which is not inside a different `<form>`. That is `isCoLocatedWith`'s rule that a form-wrapped candidate needs the card number's own form.
    - A form-less `<table>` card block is one case of this rule; `<div>`-only SPA checkouts are another.
  - **Members:**
    - When a block exists: the card number, every CC-hinted field inside the block, and every `cc-*` field anywhere.
    - **When no block exists** — a lone card-number match with no CC-hinted neighbour, such as a `利用者カード番号` library or loyalty login — the members are only the `cc-*` fields. The lone card-number field is not excluded, because it is not a password or CVV hazard (S12).
  - A CC-regex match outside the card block is not in the set (FR4).
  - `detectCreditCardFields` and `ccClaimedFields` are unchanged (SC2).
- **`hasExplicitLoginAutocomplete(el)`**: the `autocomplete` attribute's whitespace-separated tokens, lowercased, include `username`, `email`, `current-password` or `one-time-code`.
- **`isLoginEligible(el, ccForm)`** = `!ccForm.has(el) || hasExplicitLoginAutocomplete(el)`.
- **Scope.** LOGIN always evaluates `ccFormFields(document)`, regardless of the caller's own root (`form` in the login detector). The card form is a page-level fact. Identity detection keeps its `root`-scoped `ccClaimedFields(root)`, which is its existing behaviour; the two differ deliberately (R48).
- **Control class:** **best-effort heuristic** over page markup, not a security boundary. Known gaps:
  - a CVV whose card form has no detectable card number still reaches LOGIN, as today;
  - a card field that the page labels with a LOGIN autocomplete wins by FR2;
  - fill eligibility is decided at T0 for `initial` targets and per tick for relocates. A target that was eligible at T0 is still written if a card number appears before its turn; `accepts` does not re-check eligibility;
  - a card number or CVV in another frame stays eligible in that frame, for every LOGIN path (fill, trigger, capture): each frame computes `ccFormFields` over its own document only, as today (S14);
  - a LOGIN field inside the card block whose hints collide with a CC regex (for example `account_security_code` in a single guest-checkout form) is excluded unless FR2 applies. This fails safe: no fill or capture happens, and nothing leaks. It is pinned as "excluded, by design".

### C3: fill (`autofill-lib.ts`)

- **At T0.** `ccForm = ccFormFields(document)` is computed once.
  - The hinted single candidate (`targetHint` resolution) and the focused one (`findFocusedTextInput`) are gated by `isLoginEligible`.
  - The candidate lists are filtered by `isLoginEligible` before use:
  - `findPasswordInput` (scoped and page-wide);
  - `findUsernameInput`;
  - `findOtpInput` and `findSplitOtpInputs` (scoped and page-wide);
- **At relocate.** Each step's `relocate` filters the same way, reading `ccForm` from a per-task memo. The memo is computed on first use and cleared by a `queueMicrotask` scheduled at that point, so all relocates within one `tick` share a single scan (NF3).
- Custom-field matching is not filtered (NF1).

### C4: inline trigger and shared finders (`form-detector-lib.ts`)

- **`shouldTriggerForInput`.** It becomes a short-circuited expression: the per-field checks (`type === "password"`, `isLikelyUsernameInput`, `isLikelyOtpInput`) first, then `findAssociatedPasswordInput`. It returns `false` for an ineligible input. This covers its literal `input.type === "password"` branch as well as the username/OTP branches. The eligibility check runs only after the cheap checks have said the input would trigger, so a non-candidate focus costs no card scan (NF3).
- **`rawPasswordInputs(root)`** is a new private helper in `form-detector-lib.ts`: today's one-line `input[type="password"]` query plus `isUsableInput`.
- **`findPasswordInputs(root)`** first calls `rawPasswordInputs`. It computes `ccFormFields(document)` only when that scan found at least one usable password field, and then drops the ineligible ones. Its callers are `findAssociatedPasswordInput` and the login detector.
- **`scanInputs`** runs on every mutation batch and navigation, and only attaches listeners. It calls `rawPasswordInputs`, not `findPasswordInputs`, because eligibility is decided at trigger and capture time, not on DOM churn (NF3).
- **`PSSO_TRIGGER_INLINE_SUGGESTIONS` handler.** It runs `shouldTriggerForInput` over every input, so it computes `ccForm` once per invocation and passes it to the eligibility checks (S17).
- **`findUsernameInput`** (the `form-detector-lib` twin) skips ineligible candidates.
- These sites call `ccFormFields(document)` themselves; there is no cache across events.

### C6: direct fallback (`background/direct-autofill.ts`)

- `directAutofill` must stay self-contained, because it is serialized by `executeScript`. It therefore re-implements C2's `ccFormFields` / `isLoginEligible` inline, using C2's exact definitions of the CC-hinted field, the card number and the card block (form-with-neighbour, else the lowest ancestor; no block → `cc-*` only). The inputs that parity depends on are pinned:
  - the hint attribute set of `getHintString`: name, id, placeholder, aria-label, `label[for]`, ancestor `<label>`;
  - visibility = `isElementVisible` (display, visibility, opacity ≤ 0.05). `directAutofill`'s own `isVisible` is extended to match;
  - selects are scanned as CC-hinted neighbours, while inputs remain the only write targets;
  - the card-number choice order is the first `cc-number` token, else the first regex match;
  - the FR2 exception.
- **One source for the patterns.** The regexes and the token list are not duplicated.
  - **Signature:** `directAutofill(usernameArg, passwordArg, targetHintArg?, customFieldsArg?, ccPatternsArg?: { [key: string]: { source: string; flags: string } } | null, loginTokensArg?: string[] | null)`.
  - **Absent args:** when `ccPatternsArg` is absent, no card exclusion runs. This keeps the module-purity `toString()` test and today's 4-arg calls valid. The production call site always passes both.
  - **Updated tests:** all existing `direct-autofill.test.ts` calls are updated or kept deliberately 4-arg.
  - The service worker passes `CC_DETECT_RE` / JA patterns as `{ source, flags }` and `LOGIN_AUTOCOMPLETE_TOKENS` as these args, and `directAutofill` rebuilds them with `new RegExp`. The patterns are static extension constants, not page data. The `unserializable` retry only nulls the hint arg, so these survive.
- **Filtered candidates.** All three are filtered: the password candidate (`findPasswordInScope`), the hinted/active username candidate, and the fallback username walk (the nearest preceding text field).
- **Call site pinned.** A `background.test.ts` assertion requires that every direct-fallback injection, including the `unserializable` retry, carries six args with non-null `args[4]` and `args[5]`. It is red-proven by dropping either one (S16).
- This is a deliberate twin of C2, deleted by `#878`. Drift is pinned by a parity test: `directAutofill` and `performAutofill`, run on the same fixtures, choose the same password and username targets. The fixtures, each with red proofs one mutation per difference:
  - login + card form;
  - an FR2 field;
  - an FR4 `security_code` login password placed before the card CVV (claim-stealing);
  - a label-only JA CVV (`<label>セキュリティコード</label>`, non-matching name);
  - a form-less `<table>` card block;
  - a hidden card-number field (allow: nothing excluded);
  - a focused card-number field (username not written there);
  - a `<div>`-only card block, with no form and no table (F-S10);
  - a `label[for]`-labelled CVV, with the `CSS.escape` polyfill used by sibling tests;
  - three password fields (the fallback target);
  - an opacity-0 card number (allow: no block);
  - a `<select>`-only expiry neighbour anchoring the block;
  - a card form before a password-only login form (the username walk does not land in the card form);
  - a lone card number plus a login `security_code` in a separate `<form>` (allow: both eligible);
  - a `利用者カード番号` + password login (allow: the username is filled);
  - a form-wrapped card number with a `form=`-associated CVV outside the form (deny).
- Control class: best-effort heuristic, as C2.

### C5: save capture (`login-detector-lib.ts`)

- Capture goes through C4's finders.
  - A checkout form whose only password field is a card-form CVV is not captured.
  - A single `<form>` holding a login password and a card-form CVV now counts one password, so `shouldSkipForm` no longer skips it as a two-password form. The login password is captured. The CVV value is never read.
- **Not closed.** Both cases are pinned by tests as "captured, by design", so they cannot later read as fixed:
  - **(a)** a page that labels its CVV with a LOGIN autocomplete keeps it eligible (FR2). This is neutral compared with today, where the `byAutocomplete` branches already give that field priority. It is not a widening (R43).
  - **(b)** card detection is a point-in-time, single-document snapshot. A CVV-only step submitted after the card number left the DOM, or whose card number is in another frame, is captured as today.

### Member set (R42)

- **Twin implementations:** `rg -n 'type === "password"' extension/src/background` finds `direct-autofill.ts` (C6). The LOGIN class spans `content/` and `background/`.
- **Call sites** are derived with `rg -nE "\b(findPasswordInputs?|findUsernameInput|findOtpInput|findSplitOtpInputs|findFocusedTextInput|shouldTriggerForInput|isLikelyUsernameInput|isLikelyOtpInput|findAssociatedPasswordInput)\(" extension/src/content`. They are in `autofill-lib.ts`, `form-detector-lib.ts` and `login-detector-lib.ts`.
- That grep covers call sites only. Two members are found by reading instead:
  - `shouldTriggerForInput`'s literal `input.type === "password"` branch: `rg -n 'type === "password"' extension/src/content`;
  - the `targetHint` resolution block in `performAutofill`.

  Both are in C3/C4.

## Testing strategy

- **`__tests__/content/login-field-eligibility.test.ts` (new).**
  - `hasExplicitLoginAutocomplete`: each of the four tokens, with section/billing prefixes. Refused: `cc-csc`, `new-password`, empty.
  - `ccFormFields`:
    - empty without a card number;
    - card form fields included;
    - a CVV-regex match in a different form excluded (FR4);
    - a `cc-*` autocomplete field outside the card form included.
- **Fill (`__tests__/content/autofill.test.ts`)**, on a login form followed by a card form with a masked CVV:
  - the password goes to the login password, and the CVV stays empty;
  - paired allow: without the card number, today's last-password choice is unchanged;
  - FR2: a card-form field with `autocomplete="current-password"` is filled;
  - FR4: a login password named `security_code`, on a page that also has a card form elsewhere, is still filled;
  - split OTP: `security-code-0..5` in a login form, with a card form elsewhere, are all filled. Deny pair: a `セキュリティコード` CVV inside the card form is not the OTP target.
- **Trigger (`__tests__/content/form-detector-inline.test.ts`, which already drives `initFormDetector` with a chrome stub).** Focusing the card-form CVV sends no `GET_MATCHES_FOR_URL`. The positive control is the login password on the same page, which does send it, observed first. Any negative assertion is ordered behind a distinguishable positive control (memory `feedback_negative_assertion_needs_distinguishable_control`).
- **Capture (new `__tests__/content/login-capture-cc.test.ts`)** uses the REAL `form-detector-lib`, and stubs `chrome.runtime.id` / `sendMessage` as `login-detector.test.ts` does. `isContextValid()` gates both capture paths: without the stub every deny case would pass for the wrong reason, because nothing would be captured at all. `login-detector.test.ts` mocks it wholesale, so a capture test there would be vacuous. Cases:
  - checkout-form submit → `extractCredentials` returns null, and no `LOGIN_DETECTED`;
  - paired allow: the login-form submit on the same page → captured;
  - the combined single-form case → the login password is captured, not the CVV.
- **Direct fallback (`__tests__/background/direct-autofill.test.ts`):** the C6 parity fixtures, plus a deny case (the CVV is not written) and its paired allow case (the login password is written).
- **Three password fields** (in both `autofill.test.ts` and the C6 parity set): a login password, an unrelated non-card masked field after it, and a card-form CVV. This pins the post-fix fallback target, which is the last eligible field, i.e. the unrelated field, as today's heuristic would pick among eligible fields.
- **`<div>`-only card block (F-S10):**
  - Deny: the CVV is excluded.
  - Allow: an unrelated `security_code` login field in a sibling `<div>` stays eligible.
  - Red proofs: reverting to form/table-only must fail the deny test; widening to page-wide must fail the allow test.
- **Same-block collision** (Known gaps): an `account_security_code` field inside the card form is excluded, pinned as by design. Its control in the same fixture is a plain `username` field inside the same card form, which stays eligible.
- **NF3 call counts**, with `vi.spyOn` on the exported `ccFormFields`, following the `fill-sequence-lib.test.ts` precedent:
  - a multi-relocate fill calls it once per tick;
  - a mutation batch that adds a card-form CVV does not call it (`scanInputs` uses `rawPasswordInputs`);
  - a focus on a non-candidate input does not call it.

  Each count assertion is paired with a positive count on a path that must scan.
- **Click-based capture (`extractCredentialsFromPage`):**
  - a filled login password plus a filled card CVV → the login password is captured (before: null);
  - only a filled CVV → null.

  Both use the real `form-detector-lib`.
- **Claim-stealing (F1):**
  - Deny: a login form `[username, password name=security_code]` followed by a card form `[cardnum, password name=cvv]` without `cc-csc`, with nothing focused → the login field gets the password and the CVV stays empty.
  - Allow: the same page without the card number → today's choice.
  - Split OTP: the same deny/allow pair with the OTP cells before the card CVV.
  - Red proof: reverting to the claim-derived set must fail the deny test.
- **Capture gaps pinned (C5 a/b):** a CVV with `autocomplete="current-password"` is captured; a CVV-only form with no card number in the DOM is captured.
- **Moved modules:** existing CC and identity tests pass unchanged, apart from import paths.
- **Red proofs:** every new assertion is red-proven on a scratchpad copy, one mutation per clause.

## Scope contract

- **SC1:** custom-field targets are not filtered. A label equal to a card field's `id`/`name` is the user's deliberate choice.
- **SC2:** CC detector heuristics are unchanged. That covers its page-wide CVV regex and a card field that carries a LOGIN autocomplete still being claimed by CC. C2 narrows only what LOGIN excludes.
- **SC3:** `#881` (stale context menu) is unrelated.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | acyclic module layout | locked |
| C2 | `ccFormFields` / `isLoginEligible` | locked |
| C3 | fill T0 + relocate | locked |
| C4 | inline trigger + shared finders | locked |
| C5 | save capture | locked |
| C6 | direct-fallback inline exclusion + parity test | locked |
