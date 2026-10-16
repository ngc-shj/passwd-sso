# Plan: http-auth-dialog (#905)

Chrome shows its own dialog for a `401` with `WWW-Authenticate: Basic|Digest` (routers, NAS, intranet tools). The dialog is browser UI, not page DOM, so the content bundle cannot fill it. `chrome.webRequest.onAuthRequired` with `asyncBlocking` can answer it. In MV3 that needs the `webRequestAuthProvider` permission, and the request URL must be within the extension's host permissions.

## Project context
- **Type:** `mixed` (browser extension). Only `extension/` changes.
- **Test infrastructure:** `unit tests only` (vitest + jsdom), plus CI.
- **Verification environment constraints:**
  - **VE1:** a real Chrome answering a real challenge.
    - `blocked-deferred` to the user's manual check.
    - Server: go-httpbin (`docker run -p 8080:8080 mccutchen/go-httpbin`), which serves `/basic-auth/u/p` and `/digest-auth/auth/u/p`.
    - http at `http://<tailnet-ip>:8080`; https through `tailscale serve --https=10000`, never 8443.
  - **VE2:** the permission mechanics, checked BEFORE implementation; it gates C1.
    - **Observables:**
      - (a) chrome://extensions shows no warning that a permission cannot be optional;
      - (b) `chrome.permissions.request({ permissions: ["webRequest", "webRequestAuthProvider"], origins: [...] })` from the popup resolves `true`;
      - (c) `chrome.webRequest.onAuthRequired` becomes available in the running service worker without a restart;
      - (d) the popup is still open after the permission prompt, or is not.
    - (a) runs locally with Playwright Chromium (`--load-extension`); (b)–(d) need a person and go to the user.

## User decisions
- **Consent:**
  - The user registers a site once from the popup. That binds a LOGIN entry to the origin and grants that origin's host permission plus the optional API permissions.
  - After that, every challenge from the origin opens a small confirmation window naming the site, the entry and the scheme. Only "Send" answers it.
  - Chrome caches accepted credentials, so this normally happens about once per site per browser session.
  - The confirmation replaces silent answering. Silent answering could not tell who triggered a challenge: a redirect keeps `initiator` unchanged, and on http the address does not identify the server (sec R1 F1, F3).
- **http:** a challenge from an `http://` origin is answered only when the bound entry has a saved URL for exactly that origin (same idea as #878 C4). Registration and every confirmation warn that the password can reach whoever answers at that address on the current network, unencrypted if the scheme is Basic.

## Contracts

### C1: permissions stay optional
- `manifest.config.ts`:
  - gains `optional_permissions: ["webRequest", "webRequestAuthProvider"]`;
  - `optional_host_permissions` gains `"http://*/*"`;
  - the required `permissions` and `content_scripts.matches` do not change, so install and update prompts stay as they are.
- **Chrome version floor (func F3):** `asyncBlocking` on `onAuthRequired` in MV3 needs a recent Chrome. Set `minimum_chrome_version` to the version VE2 confirms, and record it.
- **Forbidden pattern:** `webRequest` in the required `permissions` array. Reason: it would change the install/update prompt.

### C2: binding store (`lib/http-auth-bindings.ts`)
- **Location:** in `lib/`, because the options page imports it.
- **Type:** `HttpAuthBinding = { origin: string; entryId: string; teamId?: string }`.
  - `origin` is a normalized `URL.origin`: scheme, lowercased host, port omitted when it is the default.
- **Functions:** `normalizeOrigin(url)`, `listBindings`, `getBinding(origin)`, `setBinding` (replaces any binding for the same origin), `removeBinding`.
- **Storage:** one `chrome.storage.local` key, validated on read; a malformed record is dropped. It holds no secret.
- **Tampering (sec F6):** a content script can write `storage.local`. A forged binding still needs (1) the origin's host permission, which C4 rule 4 checks with `permissions.contains`, (2) a confirmation click (C4), and (3) an entry whose saved-URL origin matches (C4 rule 9). That is accepted; `storage.local` stays readable by content scripts, which use it for settings.

### C3: registration
- **Popup:**
  - **Where the action appears:** a LOGIN entry row whose saved URL origin equals the tab's origin. The popup only has `urlHost`, so the action shows when the host matches exactly, and the SW then decides on the exact origin (func F1).
  - **Clicking the action:**
    1. Opens an in-popup dialog in the style of `FillMismatchDialog`, never `window.confirm`. It names the origin, and shows the http warning when the origin is `http:`.
    2. On confirm, writes a pending intent `{ origin, entryId, teamId }` to `storage.session`.
    3. Then calls `chrome.permissions.request(...)` as the first call of that click handler, with no `await` before it (the user gesture).
    4. On grant, sends `HTTP_AUTH_REGISTER`.
  - **If the popup closes during the permission prompt (func F6):** the SW completes the pending intent in `permissions.onAdded`. Registration is idempotent.
- **SW (`HTTP_AUTH_REGISTER`, and the `onAdded` completion):**
  - **Accepted only when:**
    - the message comes from an extension page (`EXTENSION_PAGE_ONLY_MESSAGES`);
    - the vault is unlocked;
    - the origin is `http:` or `https:` with a host;
    - `permissions.contains` covers that origin;
    - the decrypted entry is a LOGIN with a non-empty username and password, and has a saved URL (the blob `url` or a `url`-type custom field) whose normalized origin equals the origin.
  - **Then** `setBinding`.
  - **On any failure (func F1):** roll back the permissions through C5's `releasePermissions`, so no permission is left without a binding.
  - **Errors:** `HTTP_AUTH_ENTRY_MISMATCH` and `HTTP_AUTH_PERMISSION_DENIED`, mapped in `ERROR_KEY_MAP`, with both locales.
- **Consumers:**
  - the popup reads `{ ok, error }`;
  - C4 reads `{ origin, entryId, teamId }` to fetch and decrypt the entry;
  - the options page (C5) reads `origin`.

### C4: answering a challenge (`background/http-auth.ts`)
- **Seam (test M1):**
  - `initHttpAuth(deps)` takes `getVault()`, `awaitHydrationBounded`, `currentVaultEpoch`/`isVaultEpochCurrent`, `fetchAndDecryptEntry` and `openPrompt`.
  - `handleAuthRequired(details, callback): Promise<void>` returns its own work (test M2). Chrome ignores the return under `asyncBlocking`.
- **Callback:** guarded to fire exactly once. A late result after the deadline is dropped.
- **Answer `{}` (Chrome's own dialog) unless every rule holds.** Never `cancel`.
  1. `isProxy` is false.
  2. `scheme` is `basic` or `digest`.
  3. `tabId >= 0`, `frameType === "outermost_frame"`, and `documentLifecycle` is `"active"` or undefined (sec F2, F8). A subframe or prerender never gets credentials.
  4. `normalizeOrigin(details.url)` has a binding, `details.challenger` (normalized: default port, IPv6 brackets) equals it, and `permissions.contains` covers it.
  5. This `requestId` has not been answered yet. A re-raised challenge after wrong credentials falls to Chrome's dialog. The set is bounded (LRU of 256), and a SW restart resets it, which is accepted.
  6. The vault is unlocked after `awaitHydrationBounded`. A challenge can wake the SW mid-hydration (test M3).
  7. The user clicks "Send" in the confirmation window:
     - it names the origin, the entry title, the scheme, and the tab's top-level URL;
     - it carries the http/Basic warning;
     - "Cancel", closing the window, or a 60 s timeout give `{}`;
     - concurrent challenges from one origin share one window, and each gets its own answer.
  8. The epoch is unchanged from the challenge through the decrypt.
  9. The decrypted entry still satisfies C3's checks.
- **Deadline (func F2):** the fetch and decrypt after "Send" are bounded (10 s); past it, `{}`. Any thrown error gives `{}`.
- **Activity (sec F9):** answering never calls `registerActivity()`. A challenge must not keep the vault unlocked.
- **What rule 7 does not cover (sec F5):** once Chrome accepts the credentials, it caches them for that protection space and may send them on later requests. Rule 7 decides only whether the extension releases the credential.
- **Control class:** fail-closed verification gate plus an explicit user decision per challenge.
- **Adjudication authority:** Chrome's `details` (url, challenger, frameType, documentLifecycle), `chrome.permissions.contains`, and the user's click.
- **Forbidden pattern:** `cancel: true` in `background/http-auth.ts`. Reason: it blocks the user's own manual login.

### C5: revocation and permission bookkeeping
- **`releasePermissions(origin)`:** removes `origin/*` only when nothing else needs it:
  - no other binding is covered by that pattern (patterns without a port match any port);
  - it is not the configured server's origin (func F5, sec F7).
  
  It removes `webRequest` / `webRequestAuthProvider` only when no binding remains.
- **Options page:**
  - **Lists bindings by origin.** Each shows the entry title when unlocked, or "locked" otherwise.
  - **Flags** a binding whose entry is gone, and one whose permission was removed outside the extension (`permissions.contains`).
  - **Remove** calls `removeBinding`, then `releasePermissions`.

### C6: listener lifecycle
- **When it registers:**
  - at SW start, synchronously at top level, when `chrome.webRequest?.onAuthRequired` exists;
  - in `permissions.onAdded`.
- **When it unregisters:** in `permissions.onRemoved`.
- **Safety:**
  - every `addListener` / `removeListener` call is wrapped in try/catch, and a failure is logged through `warnBackground`;
  - a throw there must not abort the rest of the SW's start (func F3);
  - registration is idempotent (`hasListener`);
  - the `chrome.permissions.onAdded` / `onRemoved` calls are guarded, so background test suites whose mock lacks them still load (test m6).

### C7: shared entry access (func F4)
- **`fetchAndDecryptEntry(entryId, teamId, epoch)`:** extracted from `performAutofillForEntry`, covering both the personal and team paths, with their AAD and epoch checks.
- **`savedUrlOrigins(blob)`:** extracted beside the existing `entryHttpHosts` logic, returning normalized origins from `url` and `url`-type custom fields.
- **Callers:** autofill, C3 and C4. The autofill tests must stay green with no expectation changes.

## VE2 result (user's Chrome 154, probe extension, 2026-10-16)
- **Optional grant works.** `permissions.request({ permissions: ["webRequest", "webRequestAuthProvider"], origins: ["https://httpbin.org/*"] })` was granted. Challenges from that origin were then delivered to `onAuthRequired` with `asyncBlocking`.
- **The API became available after the grant.** Chrome restarted the SW right after the grant (15:15:32), and registration at SW start then succeeded. `onAdded` must still register idempotently.
- **The SW wakes on a challenge.** After the SW was stopped, a challenge woke it (`SW start` and `onAuthRequired` in the same second). The top-level registration path works.
- **`details` matched the plan:** `challenger.port` is the number `443`, `initiator` is `undefined` for an address-bar navigation, and `frameType` is `outermost_frame`.
- **The popup most likely closes on the permission prompt.** The request that showed a prompt logged no result. The one that resolved `true` (15:16:07) needed no prompt. The probe's log can drop lines when writes race, so this is not conclusive. Either way, the C3 pending intent completed in `onAdded` is required.
- **Not observed:** (a) the Errors list, and (e) `contains` for an unrelated https origin. Both are checked again in VE1 on the real build.

## Round 2 amendments (these override the contract text above where they differ)

- **C4 rule 3 (sec R2 N1):** additionally `details.type === "main_frame"`. Only a top-level navigation is answered; an `<img>`, `fetch` or `sub_frame` from any page gets `{}`. After one answered navigation, Chrome's auth cache covers the site's subresources.
- **Incognito (N14):** a challenge from an incognito tab is not answered.
- **C4 rule 5 (N10, T11):** a `requestId` is recorded at first receipt. Any terminal decision (Send, Cancel, close, timeout, error) ends it, so a re-raised challenge, including Chrome's own retry after Cancel, gets `{}` with no new window.
- **C4 rule 7, the prompt (T1, N2, N3, N5, N6, N7, N13):**
  - **Module:** `background/http-auth-prompt.ts` owns the prompt:
    - `openPrompt(req): Promise<"send" | "cancel">`;
    - window creation (`chrome.windows.create({ type: "popup" })`, placed relative to the tab's window);
    - the 60 s timeout, which also closes the window;
    - `windows.onRemoved` mapped to `"cancel"`;
    - routing of `HTTP_AUTH_PROMPT_DECIDE` by an unguessable prompt id.
  - **Decisions:** an unknown, settled or stale id is ignored. A second `DECIDE` is dropped.
  - **Tests:** this module is tested against a `chrome.windows` mock; `http-auth.ts` is tested through the seam.
  - **One prompt per `(origin, tabId)`.** With `main_frame` only, that is one navigation.
  - **Abort:** `tabs.onRemoved`, and `webRequest.onErrorOccurred` for the requestId, settle it as `"cancel"`.
  - **The window shows:**
    - `details.url`;
    - `details.initiator`, labelled "triggered by", or "address bar / bookmark" when undefined;
    - the entry title and username, from the cached overview, never a full decrypt;
    - `details.scheme`;
    - the http warning, which covers Digest too (an offline-crackable hash).
    
    It does not show `details.realm` (server-controlled text). It does not show `tab.url`, which the extension cannot read without host access.
  - **Input protection:**
    - "Send" is disabled for 800 ms after the window becomes visible and focused, and again after each refocus;
    - "Send" is never autofocused or the default button;
    - Enter and Escape mean Cancel;
    - a click counts only while `document.hasFocus()`.
  - **The page is not web-accessible.** It is not in `web_accessible_resources`, so no site can frame it.
- **After "Send" (N9):** rules 4 and 9 run again (`getBinding` still maps to the same entry, and `permissions.contains`) before the full fetch and decrypt. The full decrypt happens only after Send. A test asserts `fetchAndDecryptEntry` is not called before `DECIDE`.
- **Activity (N4, T2):** `HTTP_AUTH_PROMPT_GET` and `HTTP_AUTH_PROMPT_DECIDE` are excluded from `registerActivity()`, as `KEEPALIVE_PING` is. This is tested at `handleMessage` level, observing `alarms.create(ALARM_VAULT_LOCK)`, with a `GET_STATUS` control.
- **C5 (N8):** `releasePermissions` keeps a pattern that *covers* the server origin. Coverage, not equality: `http://localhost/*` covers `http://localhost:3001`. Every `permissions.remove` is wrapped in try/catch and logged (N11).
- **C3 pending intent (N12, T9, T12):**
  - **Shape:** one `storage.session` slot `{ nonce, origin, entryId, teamId, expiresAt }` with a 2-minute TTL.
  - **Order in the click handler:** the `set` is fired un-awaited, then `permissions.request` is called.
  - **Clearing:** a `false` grant or a throw clears the slot.
  - **Completion:** `onAdded` completes the intent only when it is fresh, `added.origins` includes its pattern, and the API permissions are present. Completion clears the slot.
  - **Idempotent:** the popup path and the `onAdded` path may both run. A second completion is a no-op that keeps the binding and the permissions.
- **C2 tampering (N11):** content-script `matches` may already grant host access to every https origin, so for https the defence rests on the click and rule 9, not on `permissions.contains`. VE2 adds observable (e): `permissions.contains({ origins: ["https://unrelated.example/*"] })` before any grant.
- **C7 (T3):** before the extraction, characterization tests at the AUTOFILL message level are committed and run green against the inline code. They cover:
  - `decryptData` args per field (BLOB vs OVERVIEW AAD; `undefined` AAD for `aadVersion` 0);
  - `INVALID_ENTRY` with no plaintext in the error;
  - the server `body.error` passthrough;
  - `VAULT_LOCKED` on a lock during the personal fetch.
  
  `entryHttpHosts` is left as it is (host-based). `savedUrlOrigins` is a new origin-based helper.
- **Error gate (T4):** `error-messages.test.ts` scans `fetchAndDecryptEntry` and the register helper. `HTTP_AUTH_REGISTER` joins `POPUP_INVOKED_HANDLERS`. The minimum member count includes the moved codes.
- **Manifest (T8):** a test imports `manifest.config.ts` (`defineManifest` is the identity) and asserts all of these:
  - the required `permissions`;
  - the optional permissions;
  - `minimum_chrome_version`;
  - unchanged `content_scripts.matches` and `web_accessible_resources`;
  - that the auth-prompt page is not web-accessible.
  
  `check-dist-hygiene.mjs` checks that `dist/` contains the auth-prompt page.
- **Build (N15):** the page is added through `build.rollupOptions.input` in `vite.config.ts`.
- **VE2 (T6):**
  - (a) is read from `chrome.runtime.getManifest()` and `chrome.permissions.getAll()` in the SW, plus the Errors list;
  - (c) is `typeof chrome.webRequest?.onAuthRequired` in SW devtools, before and after the grant, with no restart;
  - the version floor comes from Chrome's docs, and VE2 confirms it.
- **Manual (T5, T7, T15):**
  - each scenario starts with Chrome's auth cache cleared (quit Chrome, or clear "Passwords and other sign-in data"), and the first server response for the path must be a 401;
  - the observables are the status lines (200 vs 401) in the go-httpbin log, or DevTools Network;
  - scenario 6's embedding page is served by `python3 -m http.server` on another port, and it asserts only "no confirmation window, no 200";
  - scenario 8 runs on scenario 1's http binding, with a control that the server-origin permission stays.
- **Tests added (T13, T14):**
  - a self-test for the static `cancel` check (`{cancel: true}`, `{cancel}`, `["cancel"]`);
  - one shared entry predicate for C3 and rule 9, tested by a table;
  - table tests for `normalizeOrigin` and `savedUrlOrigins`;
  - jsdom tests of the prompt page (rendering, warning on and off, input protection, Send and Cancel post `DECIDE`);
  - popup action visibility (exact-host LOGIN vs non-LOGIN or host mismatch);
  - the options flags, each with a control;
  - module state reset per test (`initHttpAuth` resets it).
- **SC1 last-answer time:** dropped. A local log without a server audit adds UI for little value. The server-side audit follow-up covers it.

## Files
- `manifest.config.ts`
- `vite.config.ts`: the confirmation page as an extra input.
- New: `lib/http-auth-bindings.ts`, `background/http-auth.ts`, `background/http-auth-prompt.ts`, `src/auth-prompt/*` (the confirmation page).
- `background/index.ts`:
  - wiring;
  - the C7 extraction;
  - the `HTTP_AUTH_REGISTER` and `HTTP_AUTH_PROMPT_GET` / `HTTP_AUTH_PROMPT_DECIDE` cases, all in `EXTENSION_PAGE_ONLY_MESSAGES`.
- `lib/constants.ts` (`EXT_MSG`), `types/messages.ts`, `lib/error-messages.ts`.
- `src/messages/{en,ja}.json`.
- `popup/components/MatchList.tsx` plus a dialog component.
- `options/App.tsx`.
- The chrome mocks of the background suites, which need `webRequest` / `permissions` events where used, and a key-aware `storage.local`.

## Scope contract
- **SC1, audit:** existing extension fills record no audit event, and `GET /api/passwords/[id]` logs none (`grep -n logAudit src/app/api/passwords/\[id\]/route.ts` shows update and delete only). Server-side audit for every fill kind is a follow-up issue.
- **SC2:** proxy authentication, and NTLM/Negotiate. Never answered.
- **SC3:** registering from a page whose host matches no entry.

## Testing strategy
- **C4, through the `handleAuthRequired` seam:**
  - Each rule 1–9 gets a deny test paired with an allow control that differs on one axis. Every test awaits the handler's promise, then asserts the callback was called once with exactly `{}` or `{ authCredentials }`. Exactly-once is red-proved by adding a second callback call.
  - **Rule 3:** `sub_frame`; `fenced_frame`; `prerender`.
  - **Rule 4:**
    - allow controls on default ports (`https://h` with challenger port 443, `http://h` with 80);
    - deny when only the port, or only the host, differs;
    - deny when `permissions.contains` is false;
    - IPv6.
  - **Rule 5:** the repeat `requestId`.
  - **Rule 6:** hold hydration, then release it unlocked (answered); hydration ends locked, or hangs past the bound (`{}`).
  - **Rule 7:** Send; Cancel; window closed; timeout (fake timers); two concurrent challenges sharing one window.
  - **Rule 8:** a lock during the decrypt (`holdDecrypt`).
  - **Rule 9:** an https-saved entry on an http challenge.
  - **Deadline:** a hung fetch.
  - **Activity:** `registerActivity` is not called.
- **C3:**
  - **SW handler:** rejects a non-extension sender, a locked vault, a non-LOGIN entry, an empty username or password, an origin mismatch, and a malformed origin; allows a `url`-type custom-field match. Each failure rolls back the permissions.
  - **Popup:**
    - `permissions.request` is called synchronously inside the confirm click, before any mock resolves;
    - a `false` grant sends nothing and shows `HTTP_AUTH_PERMISSION_DENIED`;
    - http shows the warning, https does not.
  - **`onAdded`:** completes a pending intent.
- **C2 / C5:**
  - malformed records are dropped;
  - `setBinding` replaces an existing binding;
  - `releasePermissions` keeps a pattern another binding needs or the server origin needs, and keeps the API permissions while any binding remains, each with a control.
- **C6:**
  - importing the module with no `chrome.webRequest` does not throw;
  - `onAdded` for an unrelated permission does not register;
  - a second registration is a no-op;
  - `onRemoved` with the namespace gone does not throw;
  - an `addListener` throw does not abort the SW's start.
- **C1:** a test asserts the exact required `permissions`, `optional_permissions` and `optional_host_permissions` of the built manifest config.
- **Static:** the `cancel` forbidden pattern is checked with a small AST test over `background/http-auth.ts`.
- **Errors:** `error-messages.test.ts` scans the new sources, or the three codes get a direct en/ja mapping test.
- **Red-proof (scratch copy):** each C4 rule, the C3 checks and rollback, C6's top-level registration, and the manifest assertion.
- **Full run:** `npx vitest run` with its exit code checked, `npm run typecheck:test`, `npm run build`, `scripts/pre-pr.sh`.

## Manual scenarios (VE1, blocked-deferred to the user)
1. **http Basic** (`http://<tailnet-ip>:8080/basic-auth/u/p`, with an entry saved with that URL):
   - before registration, Chrome's dialog shows;
   - registration shows the warning and a permission prompt naming that site;
   - reload: the confirmation window shows, "Send" loads the page, and the server log shows an `Authorization` header.
2. **https Digest** through `:10000` (the entry URL carries `:10000`): the same flow, with no cleartext warning.
3. **Cancel:** the confirmation's "Cancel" gives Chrome's dialog.
4. **Wrong password:** one answer, then Chrome's dialog, with no loop.
5. **Service worker stopped:** stop the SW in chrome://serviceworker-internals, then reload the bound page. The confirmation still shows. This is C6's top-level path.
6. **Cross-site frame:** a page on another origin embeds the bound URL in an `<iframe>`. No confirmation, Chrome's dialog shows, and no `Authorization` header is sent. Positive control: scenario 1 in the same session.
7. **Locked vault:** lock the vault, then reload. Chrome's dialog shows, with no confirmation. Run it right after scenario 1.
8. **Revoke:** remove the binding in options, then reload. Chrome's dialog shows, and the site permission is gone from chrome://extensions.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| VE2 | optional permissions, wake-up, details shape confirmed in Chrome 154 | done |
| C1 | optional permissions only; version floor | locked |
| C2 | binding store with normalized origins | locked |
| C3 | popup registration, pending intent, rollback | locked |
| C4 | per-challenge confirmation under rules 1–9, else `{}` | locked |
| C5 | reference-counted permission release; options management | locked |
| C6 | guarded listener registration at start / on grant | locked |
| C7 | shared entry fetch/decrypt and saved-origin helpers | locked |

## Plan-review exit
Round 2 left no open finding against the consent model, which the user decided. Its findings were mechanism-level and are folded into the Round 2 amendments. Per the saturation rule (two rounds, no open Critical/Major), the remaining detail is settled by building it: Phase 2 implements against the amended contracts, and Phase 3 reviews the code.

## Implementation Checklist
- **Batch A (C7, first):**
  - characterization tests at the AUTOFILL message level in `src/__tests__/background.test.ts`, green against the inline code;
  - extract `fetchAndDecryptEntry` and `savedUrlOrigins` in `background/index.ts`;
  - `src/__tests__/error-messages.test.ts`: scan the extracted helper; raise the member floor.
- **Batch B (C1, C2, C5):**
  - `manifest.config.ts`;
  - `lib/http-auth-bindings.ts` (`normalizeOrigin`; the store; `releasePermissions` with coverage-based retention of the server origin and of other bindings);
  - `options/App.tsx` section;
  - `scripts/check-dist-hygiene.mjs` (auth-prompt page present);
  - a manifest assertion test.
- **Batch C (C3, C4, C6, prompt):**
  - `background/http-auth.ts` (`initHttpAuth`, `handleAuthRequired`, listener lifecycle);
  - `background/http-auth-prompt.ts`;
  - `src/auth-prompt/{index.html,main.tsx,App.tsx}`;
  - `vite.config.ts` `build.rollupOptions.input`;
  - `background/index.ts`:
    - wiring: guarded top-level registration and `permissions.onAdded` / `onRemoved`;
    - the `HTTP_AUTH_REGISTER`, `HTTP_AUTH_PROMPT_GET` and `HTTP_AUTH_PROMPT_DECIDE` cases;
    - the exclusion of the last two from `registerActivity()` (index.ts, the activity call in `handleMessage`);
  - `lib/constants.ts` (`EXT_MSG`, `EXTENSION_PAGE_ONLY_MESSAGES`);
  - `types/messages.ts`;
  - `lib/error-messages.ts`;
  - `src/messages/{en,ja}.json`;
  - `popup/components/MatchList.tsx` plus `HttpAuthRegisterDialog.tsx`.
- **Test mocks that import `background/index.ts`** (add `webRequest` / `permissions.onAdded` / `onRemoved` / a key-aware `storage.local` where needed): `background.test.ts`, `background-commands.test.ts`, `background/{totp-handlers,inline-matches,team-entries}.test.ts`, `options/App.test.tsx`.
- **Reuse:**
  - `swFetch` / `decryptData` / `buildPersonalEntryAAD` / `fetchAndDecryptTeamBlob` (index.ts);
  - `isVaultEpochCurrent` / `assertVaultEpoch` (`vault-epoch.ts`);
  - `awaitHydrationBounded`;
  - `isExtensionPageSender`;
  - `getCachedEntries` (overview for the prompt);
  - `warnBackground`;
  - the `FillMismatchDialog` dialog pattern;
  - `extractHost` / `isHostMatch` (`lib/url-matching.ts`).
- **CI parity:** the extension job runs `npm ci`, the tests, `typecheck:test` and the build. `scripts/pre-pr.sh` runs the same set. No gap.
