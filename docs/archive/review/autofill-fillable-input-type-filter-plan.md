# Plan: Restrict identity/CC autofill to fillable input types

## Project context

- **Type**: web app (browser extension — MV3 content scripts)
- **Test infrastructure**: unit tests only (vitest + jsdom for the extension package; no E2E in the extension package)
- **Verification environment constraints**: none that block this change. Field-detection logic is pure DOM over jsdom and fully exercisable in unit tests. (Real-browser autofill smoke test is desirable but the detection primitive itself is verifiable locally.)

## Objective

Stop the extension from treating non-fillable `<input>` elements (radio, checkbox, hidden, submit, button, reset, file, image, range, color) as identity/credit-card fields. A user reported a 2FA-method chooser triggering the identity-suggestion dropdown:

```html
<div>
  <input checked id="MobileCode" name="AuthenicationType" type="radio" value="MobileCode"> My mobile number
  <input id="Email"      name="AuthenicationType" type="radio" value="Email">      My registered email address
  <input id="backup"     name="AuthenicationType" type="radio" value="backup">     No. I want to use backup code
</div>
```

`id="Email"` matches `EMAIL_RE`, `id="MobileCode"` matches `PHONE_RE` (`mobile`) → two "identity fields" detected → the identity dropdown fires on focus of a radio button.

## Requirements

**Functional**
- Radio / checkbox / hidden / submit / button / reset / file / image / range / color inputs MUST NOT be detected as identity or credit-card fields, regardless of matching `id`/`name`/`label` hints.
- Genuine identity fields (`text`, `email`, `tel`, `number`, `search`, `url`, `date`, `month`, and inputs with no `type` attribute → default `text`) MUST still be detected.
- CVV fields commonly masked as `type="password"` MUST still be detected by the CC detector.
- Both the **detection** path (inline suggestion dropdown) and the **fill** path (actual value write-back) must apply the same restriction.

**Non-functional**
- No regression to existing detector unit tests (923 tests currently green).
- No new user-facing strings.

## Technical approach

Two layers, both required:

**Layer 1 — fillable-input-type allowlist in the detector `-lib.ts` (already implemented).**
Add a **fillable-input-type allowlist** (fail-closed for unknown/future types) to the `isUsableField` predicate that every field finder already funnels through. Allowlist rather than a blacklist of `radio|checkbox|...` because the HTML input-type set is open-ended (future spec additions) and the safe default for a password manager is "do not autofill an input we do not understand."

**Layer 2 — eliminate the fill-path twin drift at its root (RT9 — the essential fix).**
Phase-1 review (3 independent experts) found that Layer 1 alone is a half-fix: the detector `-lib.ts` governs only the inline-suggestion DROPDOWN. The actual VALUE WRITE-BACK runs in `autofill-identity.js` / `autofill-cc.js` — hand-maintained plain-JS content scripts that **re-implement the entire field-detection logic inline** (their own `getHintString`, `findFieldByRegex`, regex blocks, and a type-filter-less `isUsableField`). These `.js` files are injected via `chrome.scripting.executeScript({ files: [...] })` and are NOT covered by any test (the suite imports the `-lib.ts` twins). A patch to the detector does not reach them, so identity/CC PII can still be written into a radio/checkbox harvesting field.

The essential (root-cause) remediation is NOT to copy the type filter into the `.js` files — that leaves three parallel implementations and a permanent drift surface. Instead, unify the CC/Identity fill path onto the SAME single-source architecture the LOGIN fill path already uses:

- `autofill-lib.ts` (LOGIN) exports `performAutofill` AND self-registers its `AUTOFILL_FILL` listener at module load. `form-detector.ts` (a manifest `content_scripts` entry that CRXJS bundles) does `import "./autofill-lib"`, so the listener is always present — no hand-written `.js`, no `executeScript` needed for the common path (only a fallback).
- `autofill-identity-lib.ts` / `autofill-cc-lib.ts` already exist and already delegate detection to `detectIdentityFields` / `detectCreditCardFields` (so they inherit Layer 1 automatically) — but they only `export performXxx`; the listener registration lives in the divergent hand-written `.js`.

**Root-cause fix**: give the CC/Identity libs the same self-registering listener block as `autofill-lib.ts`, `import` them from `form-detector.ts` so CRXJS bundles them, switch `background/index.ts` CC/Identity paths to the message-send pattern (with executeScript as fallback, mirroring LOGIN), and **delete `autofill-identity.js` / `autofill-cc.js`**. After deletion there is exactly ONE implementation of each fill path, it is the tested `-lib.ts`, and it inherits the Layer-1 type filter through `detectXxxFields`. Twin drift becomes structurally impossible — the preferred RT9 closure ("single-source build, drift impossible"), not the fallback parity guard.

**Design decision — allowlist membership (R42 primitive):**
The defining primitive is *"input types into which a free-text-like credential/identity/CC value can be meaningfully written by the extension's `setInputValue` path."* Derived member-sets:

- **Identity detector** — `text, email, tel, number, search, url, date, month`.
  - Excludes `password` (an identity form does not write a secret into a masked field; a masked field on an identity form is far more likely a login password than a name/phone).
  - Excludes `datetime-local`, `week`, `time` deliberately: no identity payload field maps to them today (`dateOfBirth` targets `date`). Revisit only if a payload field for them is added.
- **CC detector** — `text, tel, number, password`.
  - Includes `password` because CVV fields are commonly masked (`looksLikeCvvField` already treats `type="password"` as a CVV signal).
  - Excludes `email, url, search, date, month`: no CC payload field maps to them.

**Design decision — empty/unknown `type` attribute:**
`HTMLInputElement.type` reflects the *resolved* type: an `<input>` with no `type` attribute or an unrecognized value reports `"text"` per the HTML spec (jsdom matches this). So the allowlist admits attribute-less inputs correctly without a special case. This must be asserted by a test (the resolved-type behavior is the load-bearing assumption).

**Design decision — consistency with `login-detector-lib.ts`:**
The login detector already filters by type but uses a *blacklist* (`type === "hidden" || "submit" || "button"` rejected; `text|tel|email` accepted). The identity/CC detectors adopt an *allowlist* instead. This divergence is intentional and must be documented in-code: login detection has a narrow known set of relevant types and benefits from admitting unusual text-like inputs; identity/CC autofill writes richer PII/financial data and should fail closed. Not unifying the two is a deliberate choice (R3 divergence-is-a-finding: recorded here so reviewers do not flag it as an oversight).

## Contracts

### C1 — Identity detector fillable-type gate (`identity-form-detector-lib.ts`)

- **Signature**: `isUsableField(el: HTMLInputElement | HTMLSelectElement): boolean` — unchanged signature; new precondition for `HTMLInputElement`.
- **Invariant** (app-enforced): for every `HTMLInputElement el`, `isUsableField(el) === false` when `el.type ∉ FILLABLE_INPUT_TYPES`. `HTMLSelectElement` unaffected (selects have no `type`; region/city/country legitimately use `<select>`).
  - **Member-set derivation (R42)**: primitive = "input types a `<select>`-or-text identity value writes into". `FILLABLE_INPUT_TYPES = {text, email, tel, number, search, url, date, month}`. Grep for every `type=` literal in identity test fixtures + payload→field mapping in `autofill-identity.js:performIdentityAutofill` to confirm no payload field targets an excluded type.
- **Forbidden patterns**:
  - `pattern: querySelectorAll\("input"\) …\.filter\(.*isUsableField` returning radios — reason: detection must not admit radio. (Verified by test, not grep.)
- **Acceptance**:
  - The reported radio-group HTML → `detectIdentityFields` returns `null`.
  - `<input type="checkbox">`, `type="hidden"`, `type="submit"` with matching hints → not detected.
  - Attribute-less `<input name="fullName">` + `<input name="phone">` → still detected (resolved type `text`).

### C2 — CC detector fillable-type gate (`cc-form-detector-lib.ts`)

- **Signature**: `isUsableField(...)` — same shape as C1.
- **Invariant** (app-enforced): `FILLABLE_INPUT_TYPES = {text, tel, number, password}`; masked CVV (`type="password"`) still admitted.
- **Acceptance**:
  - Payment-method radios → `detectCreditCardFields` returns `null`.
  - `autocomplete="cc-number"` text + `autocomplete="cc-csc"` `type="password"` → CVV still detected.

### C3 — Root-cause fill-path unification (delete hand-written `.js`) — **RT9**

- **Signatures**:
  - `autofill-identity-lib.ts` / `autofill-cc-lib.ts`: add a module-load self-registration block mirroring `autofill-lib.ts:346-360` — GUARD flag + `chrome.runtime.onMessage.addListener` gated on `message.type === AUTOFILL_IDENTITY_FILL/AUTOFILL_CC_FILL && sender.id === chrome.runtime.id` → calls the existing `performXxx`. Import `AUTOFILL_IDENTITY_FILL`/`AUTOFILL_CC_FILL` from `../lib/constants` (the `.js` used string literals because it could not import the module; the lib CAN).
  - `form-detector.ts`: add `import "./autofill-cc-lib"` and `import "./autofill-identity-lib"` (alongside the existing `import "./autofill-lib"`) so CRXJS bundles the listeners into the manifest content script.
  - `background/index.ts` CC path (1554-1571) and Identity path (1576-1605): replace the `executeScript({ files: ["src/content/autofill-*.js"] })` + `sendFillMessage` pair with the LOGIN-style pattern — `sendFillMessage(...)` to the already-present bundled listener, `executeScript` only as the catch-fallback (frame-scoped `executeTarget`, same as LOGIN). Preserve the `NO_CARD_NUMBER` pre-check and all payload fields.
  - **Delete** `src/content/autofill-identity.js` and `src/content/autofill-cc.js`.
- **Invariant** (app-enforced, RT9): after this contract there is exactly ONE fill implementation per type — the `-lib.ts` — and it obtains its field set exclusively from `detectIdentityFields`/`detectCreditCardFields`, inheriting the Layer-1 (C1/C2) fillable-type filter. No code path writes an autofill value into an input that `detectXxxFields` did not return. Twin drift is structurally impossible (no second implementation exists).
- **Why root-cause, not parity**: the hand-written `.js` re-implements detection; a parity guard would freeze THREE implementations in lockstep forever. Deleting the `.js` and bundling the lib (exactly how LOGIN already works) removes the drift surface instead of policing it. This is the RT9 "preferred: single-source-of-truth build" closure.
- **Frame-scope preservation (security boundary — R43)**: the fill message delivery MUST remain frame-scoped to `executeTarget` for content-driven fills exactly as the LOGIN path documents (index.ts:1659-1662) — never widen to a tab-wide broadcast that could leak identity/CC data into a cross-origin subframe. CC/Identity fills are always content/popup-initiated to a known target; confirm `sendFillMessage` carries the same frameId scoping the LOGIN path uses. Do NOT introduce an `allowedHosts`-style tab-wide broadcast for CC/Identity unless the origin gate is ported too.
- **Forbidden patterns**:
  - `pattern: src/content/autofill-identity\.js|src/content/autofill-cc\.js` anywhere in `src/` after this change — reason: the hand-written twins must be gone, not merely patched.
  - `pattern: function isUsableField\(el\) \{` in any remaining `.js` under `src/content/` — reason: no plain-JS re-implementation of the field predicate should survive.
- **Acceptance**:
  - `git ls-files` shows `autofill-identity.js` / `autofill-cc.js` removed.
  - `grep -rn "autofill-identity.js\|autofill-cc.js" src/` returns nothing.
  - `npm run build` succeeds; the bundled `form-detector` chunk contains the CC + Identity listeners (verify the `AUTOFILL_IDENTITY_FILL`/`AUTOFILL_CC_FILL` strings appear in the built output).
  - Existing `autofill-identity.test.ts` / `autofill-cc.test.ts` (which import the `-lib.ts`) still pass — they now test the actual production path.
  - A regression test asserts the identity/CC lib's listener block ignores messages whose `sender.id !== chrome.runtime.id` (the security gate the `.js` had).

### C4 — Regression tests (RT5/RT7/RT8)

- **Invariant**: every new gate has a red-provable test that exercises the REAL production predicate (RT5) and is proven able to fail (RT7). After C3, the `-lib.ts` IS the production predicate, so `detectXxxFields`-based tests satisfy RT5 directly.
- **Acceptance**:
  - Identity detector: reported radio HTML → `null`; checkbox/hidden/submit → `null`; **attribute-less input (`<input name="fullName">`, resolved type `text`) → still detected** (the plan's load-bearing assumption; explicit test required per review A-1/F4).
  - CC detector: payment-method radios → `null`; masked CVV (`type="password"`) → still detected.
  - Fill path: `performIdentityAutofill` / `performCreditCardAutofill` (imported from `-lib.ts`, now the production path) invoked on the reported radio-group DOM writes NOTHING into the radios (assert `radio.value` unchanged after the call). This is the end-to-end regression for the actual reported bug, exercising the real write path.
  - Red-proof (RT7), concrete mutations recorded: (a) remove `isFillableInput(el) &&` from a detector `isUsableField` → radio/checkbox detector tests + the fill-path write test go red; (b) the `sender.id` gate test goes red if the listener drops the `sender.id === chrome.runtime.id` check.

## Testing strategy

- Unit (vitest + jsdom) for C1/C2/C4 — detector returns over crafted DOM.
- Twin-parity guard for C3: either (a) a raw-text/AST assertion that both `.js` files contain the fillable-type check, red-proven by mutation, or (b) if the `.js` exposes a testable `-lib` twin, a shared parity test. **Preferred**: extract the fill-path detection to a `-lib.ts` twin so the `.js` becomes a thin loader (single source of truth, drift impossible) — but that is a larger refactor; the acceptable fallback is a mutation-proven parity guard.
- Full suite (`npx vitest run`) + `npm run build` in the extension package.

## Considerations & constraints

- **Scope contract**:
  - `SC1` — Unifying login-detector's blacklist with the identity/CC allowlist is OUT of scope (deliberate divergence per Technical approach; would touch a third detector and its tests).
  - (The former SC2 — single-source refactor — is now IN scope as C3, per the "本質的な対応" directive. The parity-guard fallback is abandoned in favor of deleting the twins.)
- **Risk**: over-narrow allowlist could drop a legitimate exotic identity field (e.g. a site using `type="search"` for a name box — admitted; `type="tel"` for phone — admitted). Members chosen to cover all current payload→field mappings.
- **Risk (C3)**: switching CC/Identity from `executeScript`-file-injection to bundled-listener + message-send changes the injection timing. LOGIN already relies on the bundled listener being present via `form-detector.ts`; CC/Identity will share that guarantee. The `executeScript` fallback is retained for pages where content-script messaging is blocked. Must verify via `npm run build` that the listeners land in the content-script bundle, and that the double-injection GUARD prevents duplicate listeners when both the manifest content script and a fallback `executeScript` run.

## User operation scenarios

1. **Reported 2FA chooser** — radio group with `id="Email"`/`id="MobileCode"`. Expected: no identity dropdown, no write target.
2. **Legitimate checkout identity form** — `name`, `address-line1`, `postal-code`, `tel`, `email` text inputs. Expected: unchanged detection + fill.
3. **Attribute-less inputs** — `<input name="fullName">` (no `type`). Expected: still detected (resolved `text`).
4. **Masked CVV** — `autocomplete="cc-csc" type="password"`. Expected: still detected by CC detector.
5. **Suggestion selected on field A, radio present on same page** — user picks an identity on a real text field; `performIdentityAutofill` runs. Expected: radios excluded from write targets (C3).

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Identity detector fillable-type gate                          | locked |
| C2  | CC detector fillable-type gate                                | locked |
| C3  | Root-cause fill-path unification (delete hand-written .js) — RT9 | locked |
| C4  | Regression tests (RT5/RT7/RT8)                                | locked |

C1/C2 are already implemented in the working tree. C3 is the root-cause remediation of the twin-drift gap this Phase-1 review surfaced — unify CC/Identity onto the LOGIN single-source pattern and delete the hand-written `.js` twins. C4 adds the end-to-end regression (fill path writes nothing into radios) plus the attribute-less-input assertion the review flagged as missing.

## Phase 3 Resolution (code review)

**Round 1** — 3 experts. Security: no findings (frame-scope preserved on primary + fallback, `sender.id` gate byte-identical, WAR surface reduced, all writes funnel through `detectXxxFields`). Functionality: 2 Minor. Testing: 1 Major + 1 Minor.

Actions:
- [Test-Major] CC/Identity `executeScript` fallback (catch path injecting `form-detector.js` frame-scoped) was untested. **Added** `inline-matches.test.ts` "fallback injects the bundled content script frame-scoped, never tab-wide" — mutation-proven RED: changing the fallback `target` from `executeTarget` to `{ tabId }` (tab-wide) fails the test (verified in a throwaway git worktree, real source untouched).
- [Test-Minor] "ignores checkbox/hidden/submit" test was vacuous w.r.t. the gate (form returns null via visibility + `<2` threshold regardless). **Split** into a mixed-form test (checkbox/submit + real text fields → `email`/`address` must be null, load-bearing) and a hidden-only visibility test.
- [Func-Minor] CC allowlist omits `month`/`date`: **accepted, no change**. `formatCombinedExpiry` only emits `MM/YY` strings which a native `type=month` input rejects, so that path was already non-functional; not a regression. Worst case: a site using a native month picker for cc-exp is not autofilled (already the case on main). Likelihood: low. Cost-to-fix: trivial but adds an untested path — deferred until a real month-picker target appears.
- [Func-Minor] / [Test-Minor] `cc-regex-parity.test.ts` deletion: **correct** — its sole purpose was `.js`↔`.ts` regex-drift guarding; the `.js` no longer exists, so the guard is obsolete (RT9 closed by single-source, not by a guard).

All 4 shipped fillable-type regression tests + the fallback test are mutation-proven RED (verified on gate-stripped detector copies / tab-wide fallback mutation, all in throwaway worktrees — real source never mutated). Full suite 917 pass; `npm run build` green; pre-PR aggregate gate 53/53 pass.

Round 1 fixes were test-only additions/refactors (no production-logic change) that strengthen — never weaken — the frame-scope assertions; no Round 2 required.

## Phase 3 Resolution — Round 2 (post-push High finding)

After push, a reviewer surfaced a **High** finding the Round-1 panel (security included) MISSED: making the CC/Identity listeners resident in all frames (all_frames:true) combined with the popup/context-menu path's tab-wide `chrome.tabs.sendMessage(tabId, payload)` (no frameId) delivered card number / CVV / name / address IN PLAINTEXT to every frame — including cross-origin third-party iframes. LOGIN is safe on that same broadcast because its payload carries `allowedHosts` and each frame self-verifies (`isFrameAllowedToFill`), but **CC/Identity entries are hostless by design** so no such per-frame gate exists. The Round-1 security expert wrongly concluded the `sender.id` gate mitigated this — `sender.id` only proves the message came from the extension, it says nothing about WHICH frames receive it.

**Fix (C5, added):** introduced `sendSensitiveFillMessage` = `chrome.tabs.sendMessage(tabId, payload, { frameId: frameId ?? 0 })` — scopes to the originating frame when known, else the TOP FRAME only, never tab-wide. Switched all 4 CC/Identity send sites (primary + fallback, both types) to it. LOGIN keeps `sendFillMessage` (tab-wide, safe via allowedHosts). No content-side over-correction (subframe fills with a known frameId still work). The `executeScript` fallback already scoped to `executeTarget` (top frame when frameId unknown).

**Known limitation (accepted, security-wins tradeoff per R43):** a popup/context-menu fill can no longer auto-fill a CC/Identity form that lives inside a subframe (no frameId → top-frame only). Since CC/Identity entries are hostless there is no way to distinguish a legitimate payment iframe from a hostile one, so delivering to a subframe on an untrusted signal is unacceptable. Content-driven fills (user focuses the subframe field) still work — the frameId is known. Worst case: user must focus the iframe field instead of using the popup for that one case. Likelihood: rare. This is the fail-safe default (security over functionality).

**Verification:** the changed "popup → top frame only" test is mutation-proven RED (reverting `sendSensitiveFillMessage` to tab-wide fails 3 tests — verified in a throwaway worktree, real source untouched). An independent security re-review confirmed the full R42 member-set (popup / context-menu / content-driven × primary-send / fallback-send / fallback-inject) is covered with no residual tab-wide path, LOGIN unaffected, no over-correction. Full suite 917 pass; build green.

**Process lesson recorded:** frame-delivery scope is a distinct security boundary from message-sender authenticity; a `sender.id`/origin-authenticity gate does NOT bound the recipient set. See feedback memory.

**Review disposition (Phase-1 Round 1):**
- Func F1 / Sec SEC-1,SEC-2 / Test F1 (all Critical/Major, converged): twin drift — resolved by C3's root-cause unification (delete `.js`), stronger than the originally-planned parity guard.
- Func F2 / Sec confirmations: attack confirmed end-to-end → C4 end-to-end write-path test.
- Test F1,F2,F3 (parity-guard adequacy): moot — parity guard abandoned; single-source deletion removes the drift surface entirely.
- Func F3 (wrong message constant in trace): corrected in C3 (uses `AUTOFILL_IDENTITY_FILL`/`AUTOFILL_CC_FILL`).
- Test F4 / Sec A-1 (attribute-less test missing): C4 acceptance now requires it.
- Test F6 (exotic-admitted-type positive test): C4 optional positive test.
- Func F4 (member-set complete, CC `month` exclusion non-regressive): accepted, no change.
