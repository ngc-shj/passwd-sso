# Plan: Inline in-page autofill suggestions for CREDIT_CARD and IDENTITY

Date: 2026-05-31
Intended branch: `feature/ext-inline-cc-identity-autofill` (to be cut from **main after #503 merges** — needs the 3-field AAD fix so CC/IDENTITY entries decrypt at all)
Status: PLAN ONLY — implementation deferred until #503 is merged.

## Project context

- **Type**: browser extension (`extension/`) feature addition. Touches content scripts, background service worker, dropdown UI, i18n, manifest web-accessible resources (already present), and tests.
- **Test infrastructure**: unit + integration (Vitest, `cd extension && npm test`). Parallel `.js` (production content scripts) + `-lib.ts` (testable logic) files — see project memory [[project_extension_parallel_impl]].
- **Depends on**: `#503` (3-field AAD) merged — without it CC/IDENTITY overviews don't decrypt, so there is nothing to suggest.

## Objective

Credit-card and identity entries currently appear only in the extension **popup** ("Other entries") and fill via the manual popup button. There is **no in-page inline suggestion**: focusing a `cc-number` (or address/name) field on a web form shows nothing. Wire the existing-but-unused CC/IDENTITY detection + fill infrastructure into the same inline pipeline that LOGIN already uses, so focusing a card/identity field shows a suggestion dropdown and selecting an entry fills the form.

### What already exists (do NOT rebuild)
- Detection libs: `cc-form-detector-lib.ts` (`detectCreditCardFields`), `identity-form-detector-lib.ts` (`detectIdentityFields`).
- Fill libs + content listeners: `autofill-cc.js` (`AUTOFILL_CC_FILL` → `performCreditCardAutofill`), `autofill-identity.js` (`AUTOFILL_IDENTITY_FILL` → `performIdentityAutofill`); both are web-accessible resources already injected on demand by `performAutofillForEntry` (`background/index.ts`).
- The fill dispatch: `performAutofillForEntry` already branches on `entryType` and sends `AUTOFILL_CC_FILL` / `AUTOFILL_IDENTITY_FILL` (injecting the right content script first). **So the select→fill half is done.**
- Dropdown UI: `content/ui/suggestion-dropdown.ts` (`showDropdown`), currently LOGIN-specific (icons + header label).
- Popup already lists CC/IDENTITY and fills them — confirms decryption + `AUTOFILL_FROM_CONTENT` dispatch work end-to-end.

### What is missing (the wiring)
1. No `initCreditCardDetector()` / `initIdentityDetector()` — nothing registers focus listeners on card/identity fields.
2. `form-detector.ts` entry point only inits LOGIN.
3. Background `GET_MATCHES_FOR_URL` (`index.ts:~2140`) returns LOGIN-only.
4. Dropdown UI is hard-coded to LOGIN (icons, header).

## Requirements

### Functional
1. Focusing a field that `detectCreditCardFields` identifies as part of a CC form shows an inline dropdown listing the user's CREDIT_CARD entries; selecting one fills the card fields via the existing `AUTOFILL_CC_FILL` path.
2. Same for IDENTITY via `detectIdentityFields` → `AUTOFILL_IDENTITY_FILL`.
3. CC/IDENTITY matches are **URL-independent** (cards/identities are not site-specific — they have no `urlHost`). Unlike LOGIN, they are NOT host-filtered: all of the user's CC (resp. IDENTITY) entries are offered on any page presenting a matching form. This mirrors native browser autofill and the popup's "Other entries" behavior.
4. The same gates as LOGIN apply: only when inline suggestions are enabled (`cachedEnableInlineSuggestions`), the vault is unlocked, and the page is not the passwd-sso app's own page; disconnected/locked states surface the same dropdown messages.
5. The LOGIN inline path is unchanged (no regression).

### Non-functional
6. No duplication of the background match/gate logic — LOGIN, CC, IDENTITY share one helper that differs only by entry-type filter + whether host-matching applies.
7. New user-facing strings added to BOTH `messages/en.json` and `messages/ja.json` (content-script header labels). Japanese per existing content-script tone; no internal jargon ([[feedback_no_internal_jargon_in_user_strings]]).

## Technical approach

- Add `initCreditCardDetector()` / `initIdentityDetector()` to the respective `-lib.ts` files, mirroring `initFormDetector()` (focus listener + suppression window + dropdown). The focus trigger fires when the focused input is one of the fields returned by `detectCreditCardFields(document)` / `detectIdentityFields(document)`.
- `form-detector.ts` initializes all three detectors and tears them down together on context-invalidation.
- Background: extract the existing `GET_MATCHES_FOR_URL` body into a shared `resolveInlineMatches(kind, effectiveUrl)` helper; LOGIN keeps host-matching, CC/IDENTITY return all entries of that type. Add `GET_CC_MATCHES_FOR_URL` / `GET_IDENTITY_MATCHES_FOR_URL` message handlers that call the helper (the URL is still needed for the own-app/disconnected gates).
- Dropdown: parametrize `showDropdown` with an `entryType` (drives icon + header label); the per-entry display uses `title` (+ `username`/cardholder) from the already-decrypted overview. Card numbers are NOT in the overview, so nothing sensitive beyond what the popup shows is rendered.
- Select → reuse existing `AUTOFILL_FROM_CONTENT` (it dispatches by entryType). No new fill path.

## Contracts

### C1 — Message constants
- **File**: `extension/src/lib/constants.ts` — add to `EXT_MSG`: `GET_CC_MATCHES_FOR_URL`, `GET_IDENTITY_MATCHES_FOR_URL`. Also promote the currently-hardcoded `"AUTOFILL_CC_FILL"` / `"AUTOFILL_IDENTITY_FILL"` strings to `EXT_MSG` constants and reference them from both background and the `.js`/`-lib.ts` listeners (R2: stop hardcoding the literal in 2+ places).
- **Acceptance**: no new bare message-string literals; all via `EXT_MSG`.

### C2 — Background shared match helper + new handlers
- **File**: `extension/src/background/index.ts`
- Extract `GET_MATCHES_FOR_URL`'s gate+filter body into `async function resolveInlineMatches(kind: "login" | "credit_card" | "identity", effectiveUrl, senderTabId?)` returning the same response shape `{ entries, vaultLocked, suppressInline, disconnected? }`. LOGIN branch keeps `entryType === LOGIN` + host match; CC/IDENTITY branches filter `entryType === CREDIT_CARD`/`IDENTITY` with **no** host match.
- `GET_MATCHES_FOR_URL` delegates to `resolveInlineMatches("login", …)` (behavior identical to today — verify byte-for-byte in tests). New `GET_CC_MATCHES_FOR_URL` / `GET_IDENTITY_MATCHES_FOR_URL` delegate with their kind.
- **Invariant**: all gates (`cachedEnableInlineSuggestions`, `isOwnAppPage`, `!currentToken` → disconnected, `!encryptionKey` → vaultLocked) are applied identically across all three kinds. The badge-update side effect and the in-process cache population stay on the LOGIN path only (badge counts logins).
- **F4 — `!tabHost` guard is LOGIN-only**: the current handler early-returns empty when `extractHost(effectiveUrl)` is null (e.g. `file://`). For LOGIN that's fine (no host = no match). For CC/IDENTITY (no host matching at all) the helper MUST skip that guard and still return all type-matching entries.
- **F5 — SW error-fallback**: the catch/error path that currently emits a graceful empty response for `GET_MATCHES_FOR_URL` must add equivalent cases for `GET_CC_MATCHES_FOR_URL` / `GET_IDENTITY_MATCHES_FOR_URL`, so the content script always gets a response (no dangling `lastError`).
- **Consumer-flow walkthrough**: the content dropdown reads `{ entries: DecryptedEntry[], vaultLocked, disconnected, suppressInline }`; each entry needs `{ id, title, username, teamId? }` for display and `id`/`teamId` for the subsequent `AUTOFILL_FROM_CONTENT`. `decryptOverviews` (`index.ts:~1003`) populates `username = overview.username ?? cardholderName ?? fullName ?? ""` — so CC shows the cardholder, IDENTITY the full name. ✅
- **Acceptance**: LOGIN response byte-identical to today (locked by the T1 regression test); CC/IDENTITY return all type-matching entries regardless of host incl. on hostless pages; gates identical; error path covers the new types.

### C3 — CC detector init (mirrors LOGIN, with the gotchas made explicit)
- **File**: `extension/src/content/cc-form-detector-lib.ts` — `export function initCreditCardDetector(): { destroy: () => void }`. Required behaviors (NOT just "mirror initFormDetector" — these are the parts that bite):
  - **S2 cross-origin guard (mandatory)**: if `window.top !== window.self` and `window.top.location` is inaccessible (cross-origin subframe), return a no-op `{ destroy: () => {} }` immediately — same as `initFormDetector`. Prevents a malicious iframe rendering a deceptive card dropdown.
  - **F2 field-membership via WeakSet (mandatory, not per-focus DOM scan)**: maintain a `WeakSet<HTMLElement>` of detected CC fields, (re)built by a `MutationObserver` + initial scan using `detectCreditCardFields` — reuse the LOGIN `scanInputs`/`trackInput`/observer pattern. The `focusin` handler does an O(1) `ccFields.has(target)` check, NOT `detectCreditCardFields(document)` per event.
  - **F1 own suppression state**: the post-fill suppression window (`autofillSuppressUntil`) is a **detector-local** variable, not shared with the LOGIN module's globals. A CC fill must not suppress the LOGIN dropdown and vice-versa.
  - **F7 vault-state re-trigger**: register a runtime-message handler for `PSSO_VAULT_STATE_CHANGED` / `PSSO_TRIGGER_INLINE_SUGGESTIONS` that re-evaluates the active element against `ccFields` (so a focused CC field gets a dropdown right after unlock).
  - **R17/R22 helper reuse**: import `isUsableInput` / visibility helpers from `form-detector-lib.ts` rather than re-defining `isElementVisible`/`isUsableField` (no 3rd copy).
  - Flow: focus a CC field → send `GET_CC_MATCHES_FOR_URL {url, topUrl}` → `showDropdown({entryType: "CREDIT_CARD", …})` → onSelect sends `AUTOFILL_FROM_CONTENT {entryId, teamId}`.
- **Acceptance**: focusing a `cc-number`/expiry/cvv field triggers exactly one match request (O(1) per focus); non-CC fields do not; cross-origin subframe = no-op; CC fill does not suppress LOGIN; post-unlock refresh works.

### C4 — IDENTITY detector init
- **File**: `extension/src/content/identity-form-detector-lib.ts` — `export function initIdentityDetector(): { destroy: () => void }`. Identical shape and **all** the C3 mandatory behaviors (cross-origin guard, WeakSet via `detectIdentityFields`, detector-local suppression, vault-state handler, helper reuse), via `GET_IDENTITY_MATCHES_FOR_URL` → dropdown (entryType IDENTITY).
- **Acceptance**: focusing an identity field (name/address/postal/phone/email) triggers one match request; all C3 acceptance points hold.

### C5 — Entry-point wiring
- **File**: `extension/src/content/form-detector.ts` — call `initCreditCardDetector()` and `initIdentityDetector()` alongside the existing inits; collect all `destroy()` fns and call them together in the context-invalidation `error` handler. Keep the single-injection guard.
- **F6 shadow-host ownership**: each detector's `destroy()` only removes its own listeners + `hideDropdown()`; the shared `removeShadowHost()` is called **once** by the entry-point teardown (not per-detector), so tearing down one detector doesn't destroy the shared dropdown DOM for the others.
- **Acceptance**: all three detectors active on page load; all torn down once on extension reload without double-removing the shadow host.

### C6 — Dropdown UI parametrization + inline error mapping
- **File**: `extension/src/content/ui/suggestion-dropdown.ts` — add **optional** `entryType?: "LOGIN" | "CREDIT_CARD" | "IDENTITY"` to `DropdownOptions`, **defaulting to `"LOGIN"`** (T4: keeps every existing `showDropdown`/`makeOptions` caller and test compiling unchanged). The type selects icon + `headerLabel`. CC shows title + cardholder; IDENTITY shows title + name. No card number / no secret rendered.
- **F3 inline error mapping**: the content-side `onSelect` error handler (in `form-detector-lib.ts` / the new detectors) currently maps `NO_PASSWORD`; add mappings for `NO_CARD_NUMBER` (CC) and the identity-equivalent error so a failed CC/identity fill shows a meaningful message, not the generic fallback.
- **Acceptance**: LOGIN dropdown + existing tests unchanged (no required-field break); CC/IDENTITY render their own header + icon; CC fill failure shows a CC-specific message.

### C7 — i18n
- **Files**: `messages/en.json`, `messages/ja.json` — add `contentScript.creditCards` and `contentScript.identities` header labels (and any "no matches" variants if the existing one is login-worded). ja uses content-script tone, no internal tokens.
- **Acceptance**: both locales have the keys; `npm run` i18n/key-coverage check (if any) passes.

### C8 — Frame-targeted fill (security hardening, S6/S7)
- **File**: `extension/src/background/index.ts` (`AUTOFILL_FROM_CONTENT` handler + `performAutofillForEntry`)
- Today the CC/IDENTITY fill does `chrome.tabs.sendMessage(tabId, AUTOFILL_CC_FILL, …)` with **no `frameId`**, broadcasting card data to every frame in the tab. Add an optional `frameId?: number` param to `performAutofillForEntry`. The `AUTOFILL_FROM_CONTENT` handler captures `_sender.frameId` and passes it; the SW then targets `chrome.tabs.sendMessage(tabId, msg, { frameId })` (and `executeScript` `target: { tabId, frameIds: [frameId] }`).
- **F8/T12 popup fallback (do NOT regress)**: the popup / context-menu callers have no originating frame (`frameId` undefined). In that case keep the **current** behavior — omit `frameIds`/`frameId` entirely (tab-wide), do **not** substitute `0`, which would break popup fills on same-origin subframe forms. So: frameId known (inline) → target that frame; frameId undefined (popup) → unchanged. The security win (no tab-wide card broadcast) applies to the inline path, which is the one this PR introduces.
- **Frame-detached edge case**: if the target frame is gone before the fill, `executeScript`/`sendMessage` throws "No frame with id N"; the existing catch returns `AUTOFILL_INJECT_FAILED` — keep that graceful path.
- **Invariant**: on the inline path, card/identity plaintext is delivered only to the frame that requested the fill, never broadcast tab-wide.
- **Acceptance**: an inline CC fill reaches only the originating `frameId`; popup-initiated fill behaves exactly as today (no frameId narrowing).

### C9 — Validate content-supplied identifiers (RS3, S8)
- **File**: `extension/src/background/index.ts` (`AUTOFILL_FROM_CONTENT` and the `GET_*_MATCHES_FOR_URL` handlers)
- `entryId`/`teamId` arrive from a content-script message as `unknown` at runtime and flow into an authenticated API path. Add a guard for BOTH ids: `typeof === "string"` + a charset/length bound `/^[A-Za-z0-9_-]{1,64}$/`; reject otherwise. Applies equally to the existing LOGIN `AUTOFILL_FROM_CONTENT` path (pre-existing gap in a touched file → fix here).
- **Do NOT use a UUIDv4-strict regex** (a Round-2 suggestion): `PasswordEntry` ids in this repo are **mixed CUID v1 and UUIDv4** (see [[project_cuid_uuid_inconsistency]]), so a UUIDv4-only guard would reject legacy CUID entries and break real fills. This guard is defense-in-depth against oversized/injection input (the id is also URL-encoded into the API path), not a format authority — a permissive-but-bounded charset is the correct choice and covers both id shapes.
- **Acceptance**: malformed/oversized `entryId` AND `teamId` are rejected before any `swFetch`, on both the inline and LOGIN paths; a legitimate CUID-shaped id is accepted.

### Forbidden patterns
- pattern: `"AUTOFILL_CC_FILL"` / `"AUTOFILL_IDENTITY_FILL"` as bare string literals OUTSIDE `constants.ts` — reason: C1 centralizes them.
- pattern: a CC/IDENTITY match path that calls `isHostMatch` — reason: cards/identities are URL-independent (R: don't blindly copy the LOGIN host filter).
- pattern: duplicated gate logic (`cachedEnableInlineSuggestions` / `isOwnAppPage`) in the new handlers instead of the shared `resolveInlineMatches` helper.

## Testing strategy

All new content-script tests MUST carry the file-level `// @vitest-environment jsdom` docblock (T3 — the extension's default env is `node`; `environmentMatchGlobs` is a per-file whitelist, not a directory glob).

- **T1 (Critical) — LOGIN host-filter regression lock (write BEFORE the C2 refactor)**: send `GET_MATCHES_FOR_URL` for an external URL with the fetch mock returning a LOGIN entry whose `urlHost` matches → assert it's returned; a non-matching host → assert empty. This is the test that catches the refactor accidentally dropping `isHostMatch` / the `entryType===LOGIN` guard (currently no test locks this).
- **T2 (Critical) — non-vacuous CC host test**: extend the background fetch mock to include a CC entry (mock currently returns only LOGIN). The CC entry's `urlHost` MUST be set to a value **deliberately different** from the test page URL (T9 — otherwise the test passes under both a host-filtered and non-filtered implementation and is vacuous); assert `GET_CC_MATCHES_FOR_URL` returns it despite the mismatch. Same for IDENTITY.
- **Background gates**: `resolveInlineMatches` respects every gate (disabled / own-app / disconnected / locked) for all three kinds; CC/IDENTITY handlers return the right type; error-fallback path responds for the new message types (F5); hostless (`file://`) page still returns CC entries (F4).
- **T6 — overview field mapping**: assert `decryptOverviews` yields `username = cardholderName` (CC) / `fullName` (IDENTITY) so the dropdown shows a usable label.
- **C3/C4 detector tests** (jsdom): focusing a detected field issues exactly one match request; an unrelated field issues none; `destroy()` removes listeners (T8); WeakSet membership updates when the observer sees a new CC form. **T10 — the cross-origin-subframe no-op (S2) is NOT naturally reproducible in jsdom** (`window.top === window.self` always; no cross-origin frame model): test it by monkey-patching `window.top` with a `location` getter that throws (document this in the test), or verify by inspection — flag as a mock-only/limited test, not a clean jsdom case.
- **T5 — select→fill path**: simulate selecting a CC dropdown item → assert `chrome.runtime.sendMessage` called with `{ type: AUTOFILL_FROM_CONTENT, entryId }`.
- **C8 — frame targeting**: assert the inline fill `sendMessage`/`executeScript` carry the originating `frameId`; assert the popup path sends with **no** `frameId` (unchanged behavior, T12) — not `frameIds: [0]`.
- **C9 — validation**: malformed/oversized `entryId` AND `teamId` are rejected before `swFetch`, on both the inline AND the LOGIN `AUTOFILL_FROM_CONTENT` paths (T11); a CUID-shaped id is accepted (guards against an over-strict regex).
- **Dropdown**: renders CC/IDENTITY header + icon; LOGIN unchanged; `entryType` optional default keeps existing `makeOptions` callers compiling (T4).
- **T7 — both-forms-on-one-page**: login field → `GET_MATCHES_FOR_URL`; CC field → `GET_CC_MATCHES_FOR_URL`; no cross-trigger. Plus an entry-point error-handler teardown test.
- **R19** — update `autofill-cc.test.ts` (and identity) to use `EXT_MSG.AUTOFILL_CC_FILL` after C1 centralizes the constant.
- Both suites + extension build green; manual: load built extension, focus the Apple checkout `cc-number` field, confirm the card dropdown appears and fills only that frame.

## Considerations & constraints

- **Security/privacy — URL-independent suggestions (Major design point for review)**: CC/IDENTITY dropdowns appear on *any* site's matching form, not host-bound like LOGIN, because cards/identities are not tied to a domain. This matches native browser autofill, Bitwarden, and the existing popup. The dropdown renders only non-secret overview fields (title, cardholder/name) — the card number/CVV are revealed only on explicit user selection. A malicious/phishing form could solicit a card the same way it could today via the popup; inline does not increase the trust surface beyond explicit user action. Document this; do not host-gate CC (would break the feature). **Two hard requirements keep the inline surface no worse than the popup**: (a) the cross-origin-subframe no-op guard (C3/C4, S2) so an embedded attacker frame can't render a deceptive dropdown; (b) frame-targeted fill (C8, S6) so decrypted card data is delivered only to the originating frame, never broadcast tab-wide. Fill always requires an explicit, `isTrusted` user selection — no fill on focus.
- **Autofill suppression**: reuse the LOGIN post-fill suppression window so the dropdown doesn't re-open from fill-induced focus events.
- iOS / app: out of scope (extension-only feature).
- Inline suggestion master toggle (`cachedEnableInlineSuggestions`) governs all three kinds uniformly.

## User operation scenarios

1. Apple checkout (`secure9.store.apple.com`): focus "クレジット / デビットカード番号" (`autocomplete="cc-number"`) → dropdown lists "オリコ Mastercard" → select → number/expiry/cvv filled by `autofill-cc.js`.
2. A shipping-address form: focus a name/address field → identity dropdown → select → fields filled.
3. Vault locked: focusing a CC field shows the "unlock" dropdown message (same as LOGIN).
4. Inline suggestions disabled in settings: no dropdown for any type.
5. A page with both a login form and a CC form: login fields show login suggestions (host-matched), CC fields show card suggestions (all cards) — no cross-contamination.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Message constants (+ centralize CC/IDENTITY fill message strings) | locked |
| C2 | Background shared `resolveInlineMatches` + CC/IDENTITY handlers (no host filter) | locked |
| C3 | `initCreditCardDetector` | locked |
| C4 | `initIdentityDetector` | locked |
| C5 | `form-detector.ts` entry-point wiring + teardown | locked |
| C6 | Dropdown UI parametrized by entryType (optional, default LOGIN) + inline error mapping | locked |
| C7 | i18n header labels (en + ja) | locked |
| C8 | Frame-targeted fill (no tab-wide card broadcast; fixes popup path too) | locked |
| C9 | Validate content-supplied entryId/teamId before authed fetch | locked |
