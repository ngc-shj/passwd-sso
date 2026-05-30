# Plan Review: ext-inline-cc-identity-autofill

Date: 2026-05-31
Review round: 1

## Functionality (adopted)
- **F1 [Major]** — `form-detector-lib.ts` keeps `autofillSuppressUntil`/`currentContext` at module scope. CC/IDENTITY detectors must own their **own** suppression state, not share LOGIN's, or a CC fill suppresses the LOGIN dropdown. → C3/C4 specify per-detector state.
- **F2 [Major]** — calling `detectCreditCardFields(document)` on every `focusin` is O(N) DOM scan + wrong for multi-form pages. → C3 prescribes a `WeakSet` of detected fields built/refreshed by a MutationObserver (reuse the LOGIN `scanInputs`/`trackInput` pattern); focus handler does `WeakSet.has(target)`.
- **F4 [Major]** — `GET_MATCHES_FOR_URL` early-returns empty when `extractHost` is null (`file://`). For CC/IDENTITY (no host match) that wrongly returns zero. → C2: the `!tabHost` guard is LOGIN-only.
- **F3 [Minor]** — inline error handler maps `NO_PASSWORD` only; CC returns `NO_CARD_NUMBER`. → C6 adds CC/identity error mapping.
- **F5 [Minor]** — SW error-fallback switch needs cases for the two new message types. → C2.
- **F6 [Minor]** — `destroy()` calling `removeShadowHost()` tears down the shared dropdown for all detectors. → C5: entry point owns `removeShadowHost` once; detectors only `hideDropdown` + remove their own listeners.
- **F7 [Minor]** — `PSSO_VAULT_STATE_CHANGED`/`PSSO_TRIGGER_INLINE_SUGGESTIONS` handler is LOGIN-only; after unlock a focused CC field won't refresh. → C3/C4 add per-detector handlers.
- **R17/R22 [Adjacent]** — cc/identity detector libs duplicate `isElementVisible`/`isUsableField`; import the shared ones from `form-detector-lib` instead of adding a 3rd copy.

## Security (adopted)
- **S2 [Major]** — LOGIN bails out in cross-origin subframes (`isCrossOriginSubframe`). C3/C4 MUST replicate this explicitly (else a malicious iframe renders a deceptive CC dropdown). → explicit acceptance criterion.
- **S6 [Major]** — `chrome.tabs.sendMessage(tabId, AUTOFILL_CC_FILL, …)` has no `frameId` → broadcasts card data to all frames in the tab. The inline path makes the triggering frame deterministic (`_sender.frameId`). → new **C8**: capture `_sender.frameId`, target executeScript + sendMessage to that frame (also fixes the existing popup path).
- **S8 [Minor, RS3]** — `entryId`/`teamId` from `AUTOFILL_FROM_CONTENT` reach an authed API path unvalidated. → new **C9**: runtime format guard.
- **S1/S3/S4 [Clean]** — no secret in overview/dropdown; no fill without explicit trusted gesture (`isTrusted` + explicit select); gates uniform. **S5** (content-supplied `topUrl` for own-app gate) pre-existing, not a security boundary.
- **URL-independent design**: confirmed sound (matches popup + native autofill); the dropdown shows only non-secret fields; not host-gating CC is intentional. Documented.

## Testing (adopted)
- **T1 [Critical]** — no existing test locks LOGIN host-filtering; the C2 refactor could silently drop it. → add a regression test (matching host → entry returned; non-matching → empty) BEFORE refactor.
- **T2 [Critical]** — the "non-vacuous CC host" test needs the background fetch mock to include a CC entry (mock currently returns only LOGIN). → adjust harness so the test proves the host filter is actually absent for CC.
- **T3 [Major]** — new content tests need the file-level `// @vitest-environment jsdom` docblock (env default is `node`; `environmentMatchGlobs` is a whitelist). → note in plan.
- **T4 [Major, R19]** — making `entryType` a **required** `DropdownOptions` field breaks every existing `makeOptions()` caller. → C6 makes it **optional, default `"LOGIN"`** (keeps LOGIN call sites + tests unchanged).
- **T5 [Major]** — select→`AUTOFILL_FROM_CONTENT` path needs a test for CC/IDENTITY.
- **T6 [Major]** — assert `decryptOverviews` populates `username` from `cardholderName`/`fullName` for CC/IDENTITY on the inline path.
- **T7/T8 [Minor]** — both-forms-on-one-page; `destroy()` removes listeners. Plus an error-handler-teardown test ([Adjacent]).
- **R19** — `autofill-cc.test.ts` uses bare `"AUTOFILL_CC_FILL"`; update to `EXT_MSG.AUTOFILL_CC_FILL` after C1.

## Disposition (round 1)
All adopted into the plan revision (round 2). New contracts C8 (frame-targeted fill) and C9 (message-param validation) added. C6 `entryType` made optional. Testing strategy expanded with the regression-lock + non-vacuous + select-path + jsdom-docblock items.

## Round 2

All round-1 Critical/Major confirmed RESOLVED. New findings — all Minor refinements, incorporated:
- **F8/T12** — C8 popup fallback would silently narrow popup fills to frame 0 (regressing same-origin-subframe popup fills). Resolved: popup path (frameId undefined) keeps **current** behavior (no frameId), only the inline path targets `_sender.frameId`.
- **S9** — Round-2 suggested a strict UUIDv4 regex for C9. **OVERRIDDEN**: entry IDs in this repo are mixed CUID v1 + UUIDv4 ([[project_cuid_uuid_inconsistency]]); a UUIDv4-only guard would reject legacy CUID entries. C9 uses a bounded charset guard `/^[A-Za-z0-9_-]{1,64}$/` (defense-in-depth, not a format authority) covering both shapes — and a test asserts a CUID-shaped id is accepted.
- **T9** — T2 must set the CC mock entry's `urlHost` deliberately ≠ page URL (else vacuous). Specified.
- **T10** — S2 cross-origin no-op isn't naturally reproducible in jsdom; flagged as mock-only/limited (monkey-patch `window.top`).
- **T11** — C9 tests must cover `teamId` + the LOGIN path, not just `entryId`. Specified.

**Convergence**: round-1 Critical/Major resolved; round-2 only Minor refinements, all incorporated. All 9 contracts locked. Plan is final and ready for implementation **once #503 merges** (branch to be cut from updated main). Implementation deferred per the user's "one step before branching" instruction.
