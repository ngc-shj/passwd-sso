# Plan: unify-direct-autofill (#878)

The LOGIN fill has a second implementation, `directAutofill` (`extension/src/background/direct-autofill.ts`). The background injects it with `chrome.scripting.executeScript({ func, args })` when two earlier attempts have both failed:
- the content-script message;
- injecting the content bundle and re-sending.

It duplicates the content-side `performAutofill`, but it lacks supersession, the payload-reference drop, the bounded root, OTP handling and dropdown suppression. A parity test keeps the two in step, so every fill-rule change has had to be written twice (most recently in #894).

## What the manual check settled (VE1, before building)

On `main`, the user ran this:
1. Opened an https card page and an https identity page.
2. Reloaded the extension, without reloading the pages.
3. Filled each page from the popup.

Both fills landed. Card and identity have no direct fallback, so inject-and-resend works on an orphaned tab as it is.

The header of `direct-autofill.ts` claimed the orphaned script's window guard keys block the re-injected bundle, and that claim does not hold. The likely reason is that Chrome gives the reloaded extension a fresh isolated world, so the orphan's keys are not visible.

So no guard change is needed. The plan-round-1 contract C1 (`claimWindowGuard`) is dropped.

## Product decision (user)

Removing the fallback would end LOGIN fill on documents outside the content-bundle scope (`https://*/*`, `http://localhost/*`). Two kinds of document are affected:
- page-DOM forms on plain `http://` (non-localhost) pages, filled through the popup, the context menu or the command;
- `about:blank`, `srcdoc` and `blob:` frames reached through the context menu.

The user first accepted losing both. The VE2 manual check then showed the popup contradicting itself on an http page: its warning ("filling an insecure page is risky") implies the fill works, and the fill then failed. The user's call: the popup lets the user copy a password onto that page, so refusing the fill there protects nothing.

**Revised decision:** plain `http://` pages keep the fill, through a fill-only script (C3). Frames with no host of their own (`about:blank`, `srcdoc`, `blob:`) stay unfilled. Card and identity fill reach http pages through the same script, for the same reason.

The browser's own HTTP-auth dialog was never fillable by either path. It is tracked separately in #905.

## Project context

- **Type:** `mixed` (browser extension). Only `extension/` changes.
- **Test infrastructure:** `unit tests only` (vitest + jsdom), plus CI.
- **Verification environment constraints:**
  - **VE1** (orphaned tab): `verified-manual` on main, as above.
  - **VE2** (the post-change build, scenarios below): `blocked-deferred` to the user's manual check before merge.

## Contract

### C2: the LOGIN fill has one implementation

**Background (`performAutofillForEntry`):**
- When the first send fails, inject-and-resend is the only fallback.
- If it fails too, check the vault epoch first. A lock returns the locked result; anything else returns `AUTOFILL_INJECT_FAILED`.
- That return comes before the TOTP auto-copy block, so a fill that never landed copies nothing (sec S1).

**Removed:**
- `injectDirectAutofill`, its `executeScript({ func: directAutofill, args })` call, and the unserializable-hint retry;
- `direct-autofill.ts` and `direct-autofill.test.ts`;
- `CARD_PATTERN_SOURCES`, `PatternSource`, `CardPatternSources` and `toSource` in `lib/cc-patterns.ts`, which lose their only consumer.

**Kept:** `LOGIN_AUTOCOMPLETE_TOKENS` (used by `login-field-eligibility.ts`), and the pattern arrays `cc-field-detection-lib.ts` uses.

**Comments that name the twin, to update:**
- `index.ts`;
- `field-query-lib.ts`;
- the `cc-patterns.ts` header;
- the test helpers (`deferred.ts`, `execute-script-mock.ts`, `layout-stub.ts`).

**Dead file:** `content/webauthn-inject.ts` has no manifest entry, import or registration, so delete it.

**Resend budget (func F3):** it stays at 10 × 50 ms. The card and identity fills already rely on it alone in production, and the orphaned-tab check passed within it. Moving to a readiness signal is out of scope (SC1).

### C3: plain http pages get a fill-only script

**Why not the manifest bundle:** its CRXJS loader starts the code with `import()`, and the bundle's `web_accessible_resources` match only `https://*/*` and `http://localhost/*`, so an http page refuses that import. Widening the resources would expose the extension's files (`token-bridge.js` among them) to every http page and network attacker.

**Mechanism:**
- `src/content/fill-listeners.ts` imports only the three fill listener modules (LOGIN, CC, Identity): no detectors, no inline UI, no WebAuthn bridge.
- `vite.fill.config.ts` builds it as one classic script (`iife`) at `FILL_LISTENERS_FILE`. `npm run build` runs it as a second pass. `executeScript({ files })` needs no web-accessible grant.
- `injectFillBundleInto` (the fill's only injector) sends the manifest bundle to an in-scope document, the fill-only script to a plain `http:` document with a host, and nothing to any other document.
- The keyboard-command re-injection (`injectContentBundle`) is unchanged and stays manifest-scope only.
- `check-dist-hygiene.mjs` fails the build when the fill-only script is missing, empty, or uses module syntax.

**Cost:** the extension package carries the fill code twice (about 35 kB). It is built from the same source, so the fill logic still has one implementation. The fill-only script cannot be exercised by unit tests end to end; VE2 scenario 4 covers it.

**Control class:** the direct fallback was a sink that bypassed the content side's checks. Removing it is a narrowing.

**Acceptance:**
- When inject-and-resend fails, nothing is written and the result is `AUTOFILL_INJECT_FAILED`.
- A lock during it gives `VAULT_LOCKED`.
- An entry with TOTP copies nothing when the fill fails, and copies once when it lands.

## Testing strategy

**Background allow-side tests (test T4, group A).** These are the tests that showed acceptance through the direct func: host and pinning acceptance, the hostless and host-mismatched popup cases, and the frame-scoped and top-frame-only fallbacks. They migrate to "lands through the resend":
- the first `sendMessage` rejects, then the next one resolves;
- expect `ok: true`, `injectionKinds()` equal to `["probe", "bundle"]`, and the resend pinned to the right document.

**Background failure tests (test T4, group B; T7).** These cases expect `AUTOFILL_INJECT_FAILED` with an exact `injectionKinds()`:
- every resend fails;
- the page is out of scope;
- the bundle injection rejects;
- a `blob:` document, whose origin the probe reports as its creator's, so only the URL-based fill injection refuses it;
- an `about:blank` frame with an inherited https origin (sec R2 F1). `isInBundleScope` stays URL-based and refuses it, so the expected kinds are exactly `["probe"]`, with the probe asserted as run, and there is no resend to that document. Making it land would widen the bundle's injection scope, which the product decision rules out.
- **The inherited-origin arm of `acceptsDocument`** keeps a positive control on the context-menu path (test R2-1), where it still decides the first send:
  - **allow:** an `about:blank` frame inheriting `https://example.com` gets the first `sendMessage` with its `documentId`, then ends `AUTOFILL_INJECT_FAILED`, not `ORIGIN_MISMATCH`;
  - **deny:** the same frame inheriting `https://evil.example` gets `ORIGIN_MISMATCH` and no `sendMessage`.

The A6 "released without a lock" control becomes `AUTOFILL_INJECT_FAILED`; its lock sibling stays `VAULT_LOCKED`. A TOTP pair is added: failed fill means no clipboard write, and a fill through the resend means one.

**Background deletions (test T4, group C):**
- the unserializable-retry and args tests;
- the `holdDirectInjection` helper.

**No secret in any injection (tests T5, T6).** This replaces the `directInjections() == []` assertions:
- no `executeScript` call carries the secret in its args;
- `injectionKinds()` never contains `func`, where the location probe is a func with no args.

Both are paired with a control that still sees the probe and the bundle.

**Content-only tests (test T8).** `direct-autofill-parity.test.ts` becomes a content-only test (`login-fill-targets.test.ts`). Every row keeps its literal expected targets, run through `performAutofill`. Its `directAutofill` half is dropped. The yield-race rows of `direct-autofill.test.ts` are each mapped to an existing content test, or moved there, before that file is deleted.

**Guard test (test T3).** The form-detector double-injection test in `form-detector-entry.test.ts` currently cannot fail. It becomes a real pair:
- after `vi.resetModules()`, a set key means init does not run again;
- an unset key means it does.

It is red-proved with the guard removed.

**Red-proof,** on a scratch copy:
- reintroduce a direct `executeScript` with args → the T5 tripwire goes red;
- move the TOTP copy before the failure return → the TOTP pair goes red;
- drop the epoch check → the lock test goes red.

**Full run:** `npx vitest run`, `npm run typecheck:test`, `npm run build`, `scripts/pre-pr.sh`.

## Manual scenarios (VE2, Chrome, https test pages on tailnet :10000)

1. **Login baseline:** fill from the popup, the context menu and the inline dropdown.
2. **Orphaned LOGIN:** reload the extension without reloading the page, then fill from the popup. The fill lands, now with no fallback.
3. **Orphaned dropdown:** in the same tab, after scenario 2's fill, focusing a field shows the dropdown again. Nothing re-injects the bundle on reload; the fill's injection is what brings the detector back, on main as well (func R2 N1).
4. **Plain http page:** a fill from the popup lands through the fill-only script. Focusing a field shows no inline dropdown (no detector is injected).

## Scope contract

- **SC1:** a readiness signal instead of the fixed resend budget.
- **SC2:** HTTP-auth dialog support, tracked in #905.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | (dropped; the manual check showed it unnecessary) | — |
| C2 | remove the LOGIN direct-autofill twin | locked |
| C3 | plain http pages get a fill-only classic script | locked (VE2) |
