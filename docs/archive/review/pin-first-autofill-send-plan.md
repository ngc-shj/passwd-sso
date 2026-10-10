# Plan: pin the first autofill send to a known document (`#876`) + sender-gate extension-page messages

Revision 8 (after plan review rounds 1-6; C7 added at the user's request in revision 5), see `pin-first-autofill-send-review.md`).

## Project context

- Type: browser extension (MV3, CRXJS/Vite, TypeScript) inside the web app repo.
- Test infrastructure: unit (vitest + jsdom) + CI. The extension has no ESLint beyond the console gate (`node scripts/checks/lint-extension.mjs`); `tsc` (via `npm run build`) and vitest are its gates.
- Verification environment constraints:
  - **VE1**: real-browser behaviour (iframe login forms, popup fill, context menu, save banner) needs the installed extension and a vault entry. Manual, `blocked-deferred` to the user, on the test pages served over tailscale `:8443` (see memory `project_extension_manual_test_setup`).
  - **VE2**: the navigation race (a frame replaces its document between the check and the send) cannot be reproduced deterministically in a real browser. `verifiable-CI` only, through the chrome mocks in `extension/src/__tests__/`, extended to model `documentId` routing (Testing strategy).

## Problem

`performAutofillForEntry` (`extension/src/background/index.ts`) sends the decrypted payload once before any fallback. That first send is addressed by `frameId` (content and context-menu paths), by `frameId: 0` (popup and context-menu CC/Identity), or tab-wide (popup LOGIN). If the frame navigates between the request and the send, the new document's content script receives the payload:

- the content-side `isFrameAllowedToFill` (`extension/src/content/autofill-lib.ts`) returns `true` for any top frame without a host check;
- CC and Identity have no content-side origin gate at all.

The fallback (bundle injection, resends, direct `func`) is already pinned to a probed `documentId` and host-checked (D9, D12, D15 in `autofill-sequential-fill-deviation.md`). SC3 of `autofill-sequential-fill-plan.md` deferred the first send; this plan closes it.

Two more members of the same class, found while deriving the member set:

- **Save-banner push** (`tabs.onUpdated`, `PSSO_SHOW_SAVE_BANNER`): the tab host is checked against `pending.host` when the tab completes, then a `setTimeout(…, 500)` sends the just-submitted password to `{ frameId: 0 }` with no re-check. A navigation inside those 500 ms delivers it to an unchecked document, which shows the Save banner there.
- **Sender check** (user decision: in scope): `handleMessage` does not check the sender. The extension-page-only messages — `AUTOFILL`, `COPY_PASSWORD`, `GET_TOKEN` and the rest of the set in C5 — are accepted from any content script in any frame. `AUTOFILL` takes an arbitrary `tabId` and skips the sender-host check.

## Requirements

- **FR1.** Every delivery of a secret to a page goes to a document whose identity and origin were established before the delivery. The one exception is the popup LOGIN broadcast (FR3).
- **FR2.** A delivery bound to a document never reaches a different document. If that document is gone, the delivery fails; it is not re-targeted to whatever the frame now holds.
- **FR3.** The popup LOGIN fill keeps its tab-wide broadcast, so a login form inside an iframe (embedded SSO) still fills. Each frame self-verifies, and the top frame no longer passes unconditionally.
- **FR4.** The popup's explicit choice of a host-mismatched LOGIN (the confirmation sheet in `MatchList.tsx`) and of a hostless LOGIN keeps working, but only into a top document on the exact origin the popup showed the user.
- **FR5.** Extension-page-only messages are refused from any sender that is not an extension page, with no side effect.
- **FR6.** Inline-match lookups (`GET_*_MATCHES_FOR_URL`) decide on browser-set sender data, not on URLs the content script supplies.
- **NF1.** No new permission. `documentId` comes from `MessageSender.documentId` or from the existing `executeScript` probe (`probeDocument`).
- **NF2.** Unchanged: the fill sequencing (`fill-sequence-lib.ts`), the manifest-scope gate on bundle injection, and the CHECK_PENDING_SAVE pull. The pull answers the sending document through `sendResponse` after checking its frame host, so it is already bound to that document.

## Technical approach

`performAutofillForEntry`'s `frameId` / `enforceSenderHost` parameters are replaced by one discriminated request origin. Each path resolves its target document before the first send, and every delivery of the request (first send, bundle, resends, direct `func`) uses it:

| Path | Target document | Established by | Rule on the target |
|---|---|---|---|
| content (`AUTOFILL_FROM_CONTENT`) | `sender.documentId` | browser-set `MessageSender` (same document as `sender.url`) | unchanged: LOGIN entry hosts must match `sender.url`'s host |
| context menu | probe of `{ tabId, frameIds: [info.frameId] }` | `probeDocument`, before the first send | LOGIN: probed host ∈ entry hosts; CC/Identity: probed host = click host (as D15) |
| popup CC/Identity | probe of frame 0 | `probeDocument`, before the first send | `probed.origin === expectedOrigin` |
| popup LOGIN | none: tab-wide broadcast | each frame self-checks (C4) | top frame: host ∈ entry hosts, or `self.origin === expectedOrigin`; subframe: host ∈ entry hosts |
| popup LOGIN fallback | probe of frame 0 | `probeDocument` (already) | NEW: the same top-frame rule (today the popup fallback checks nothing) |
| save-banner push | probe of frame 0, inside the timer | `probeDocument` | probed host matches `pending.host` (the check that already runs at `complete`, moved to delivery time) |

### Files to update

- `extension/src/background/index.ts` — `performAutofillForEntry`; the three callers; `handleMessage` sender gate; the `onMessage` failsafe extracted into a function; the save-banner timer.
- `extension/src/background/context-menu.ts` — `ContextMenuDeps.performAutofill` signature and `handleContextMenuClick`'s call build the context-menu origin.
- `extension/src/content/autofill-lib.ts` — `isFrameAllowedToFill`.
- `extension/src/types/messages.ts` — `AutofillPayload.topFrameOrigin`; `expectedOrigin` on the three popup messages.
- `extension/src/lib/constants.ts` — `EXTENSION_PAGE_ONLY_MESSAGES`, `CONTENT_ALLOWED_MESSAGES`.
- `extension/src/popup/components/MatchList.tsx` — sends `expectedOrigin`.
- `extension/src/content/form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts` — stop sending `url`/`topUrl` (C7).
- Tests: `extension/src/__tests__/background.test.ts`, `context-menu.test.ts`, `content/autofill.test.ts`, `helpers/execute-script-mock.ts`, the `MatchList` popup test, and a new partition/AST test file.

## Contracts

### C1: request origin type and `performAutofillForEntry` signature

```ts
const AUTOFILL_REQUEST_KIND = { CONTENT: "content", CONTEXT_MENU: "contextMenu", POPUP: "popup" } as const;
type AutofillRequestOrigin =
  | { kind: typeof AUTOFILL_REQUEST_KIND.CONTENT; documentId: string; senderHost: string }
  | { kind: typeof AUTOFILL_REQUEST_KIND.CONTEXT_MENU; frameId: number; senderHost: string } // OnClickData.frameId ?? 0
  | { kind: typeof AUTOFILL_REQUEST_KIND.POPUP; expectedOrigin: string };
function performAutofillForEntry(
  entryId: string, tabId: number, origin: AutofillRequestOrigin,
  targetHint?: AutofillTargetHint, teamId?: string,
): Promise<{ ok: boolean; error?: string }>;
```

- `OnClickData.frameId` is optional. `handleContextMenuClick` passes `info.frameId ?? 0`: an absent frame id means the top frame, which is probed, and the click-host rule still applies (`resolveClickHost` already fails closed on an unresolvable host).
- Invariant (app-enforced, type-checked): there is no call shape without an origin. The old `undefined`-means-trusted-popup convention is gone, and tsc rejects a caller that omits the origin. There are four callers: the content handler, the popup handler, the `initContextMenu` wiring, and `ContextMenuDeps.performAutofill` in `context-menu.ts`.
- Control class: n/a (signature).

### C2: content path pins every delivery to `sender.documentId`

- The `AUTOFILL_FROM_CONTENT` handler reads `_sender.documentId`. When it is absent or empty, it responds `ORIGIN_MISMATCH` before any fetch or decrypt, like the existing unresolvable-`senderHost` branch.
- The first send uses `{ documentId }`.
- On a "no receiver" rejection, the fallback stays on that document:
  - it probes `{ tabId, documentIds: [documentId] }`, for the scope check and the origin;
  - it injects the bundle into that document only, and resends to it;
  - the LOGIN direct `func` targets `documentIds: [documentId]`.

  When the probe does not return that same documentId, the fill fails with `AUTOFILL_INJECT_FAILED`.
- **Intended change from D12.** D12 let the content path's fallback fill a new document on the same host, for example after a redirect from `/login` to `/login/step2`. C2 does not. The request came from the sender document's own dropdown, and a document the user never picked from must not receive the credential. The cost is that a page which replaces itself between the pick and the send gets `AUTOFILL_INJECT_FAILED`, and the user picks again. The context-menu path keeps D12's allowance: its probe runs before the first send (C3), so a same-host document that is current when the probe runs is the target.
- Control class: **enforceable boundary**. Adjudication authority: Chrome's message routing by `documentId`; the content script cannot choose the recipient.
- Acceptance: with a content origin, every `chrome.tabs.sendMessage` call carries `{ documentId: <sender's> }`, and every `executeScript` target is `{ tabId, documentIds: [<sender's>] }`, for LOGIN, CC and Identity.
- Consumer-flow walkthrough: the consumer is `performAutofillForEntry`. It reads `{ documentId }` to address the send, inject, resend and direct-`func` targets. It reads `{ senderHost }` for the LOGIN entry-host check and the CC/Identity origin check.

### C3: context-menu and popup CC/Identity pin before the first send

- Before the first send, the context-menu path probes `{ tabId, frameIds: [frameId] }`, and the popup CC/Identity path probes `{ tabId, frameIds: [0] }`. The table's rule applies to the probed origin. A probe failure returns `AUTOFILL_INJECT_FAILED`, and a rule mismatch returns `ORIGIN_MISMATCH`; either way, nothing is sent.
- Every delivery then goes to `probed.documentId`, including the fallback. The fallback reuses the same probe; it does not probe again.
- Control class: **enforceable boundary** for the delivery, since Chrome routes by `documentId`. The origin rule is a **fail-closed verification gate**, adjudicated by the browser-reported `self.origin` of the probed document. The probe→send interval cannot leak: the send is bound to the probed documentId, and a replaced document does not receive it.
- Acceptance: a probe whose origin fails the rule sends nothing. A send after a probe always carries `{ documentId: probed.documentId }`.

### C4: content-side frame gate — the top frame is checked

```ts
// autofill-lib.ts
function isFrameAllowedToFill(allowedHosts: string[] | undefined, topFrameOrigin: string | undefined): boolean;
// AutofillPayload (types/messages.ts) gains: topFrameOrigin?: string
```

- **Top frame.** It fills iff either:
  - its host (`extractHost(location.href)`, as today) `isHostMatch`es one of `allowedHosts`; or
  - `topFrameOrigin` is set and `self.origin === topFrameOrigin`. This is an exact origin match: scheme, host and port.
- **Subframe.** It fills iff its host matches `allowedHosts`, and `topFrameOrigin` is ignored.
- A null host with no origin match denies.
- Only the popup origin sets `topFrameOrigin` (= `expectedOrigin`). Content and context-menu payloads leave it unset, and their top-frame fills already match `allowedHosts`, which the background verified.
- Control class: **fail-closed verification gate** in the receiving document. Adjudication authority: the receiving document's own location and origin, read by the receiver. So a document that replaced the requester checks itself.
  - The payload reaches the content script's isolated world before the check. Page JS cannot read that world, so this ordering is the accepted residual for the broadcast (SC1).
- Ordering: the gate stays the first statement of `performAutofill`. No payload field is read, logged, or surfaced in an error before the gate returns `true`.
- Acceptance: each of these cases has both a deny side and an allow side.

  | Frame | Host | `allowedHosts` | `topFrameOrigin` | Result |
  |---|---|---|---|---|
  | top | `evil.example` | `bank.example` | none | no write |
  | top | `evil.example` | — | `https://evil.example` | writes |
  | top | `http://` origin | — | `https://` origin | no write |
  | top | `evil.bank.example` | `other.example` | `https://bank.example` | no write (exact origin, not `isHostMatch`) |
  | top | on the entry host | entry host | none | writes |
  | subframe | `evil.example` | `bank.example` | `https://evil.example` | no write |

### C5: popup message carries `expectedOrigin`; extension-page-only messages are sender-gated

- **`expectedOrigin` on the popup messages.**
  - `AUTOFILL` / `AUTOFILL_CREDIT_CARD` / `AUTOFILL_IDENTITY` gain a required `expectedOrigin: string`: `new URL(tabUrl).origin` for the tab `MatchList` rendered and the user confirmed. The popup shows no Fill when `tabHost` is null.
  - The background refuses an `expectedOrigin` that does not parse as an `http:`/`https:` origin, with `ORIGIN_MISMATCH` and before any fetch.
- **Sender gate.**
  - `handleMessage` refuses a message whose type is in `EXTENSION_PAGE_ONLY_MESSAGES` unless `typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""))`.
  - The predicate keys on `sender.url`, not on `sender.tab`, because the options page opens in a tab (`open_in_tab: true`).
  - The gate runs before `awaitHydrationBounded` and `registerActivity`.
  - A refused message is answered by the `onMessage` failsafe's response for its type. The failsafe switch is extracted into `respondWithFailure(message, sendResponse)` and called from both places. Its `default` branch already covers `CLEAR_TOKEN`, `LOCK_VAULT`, `RESET_DPOP_KEY` and `KEEPALIVE_PING` with `{ type, ok: false, error }`.
  - A refused message causes no side effect: no fetch, no decrypt, no `sendMessage`, no `executeScript`, no storage write, no lock, unlock or token change, and no activity registration.
- **Member set (R42)**, derived with:
  `for t in <every case EXT_MSG.* in background/index.ts>; do grep -rlw "$t" src public --exclude-dir=__tests__ --exclude-dir=background --exclude-dir=types --exclude=constants.ts; done`
  - Extension-page-only (sent only from `src/popup`, `src/options`, `public/offscreen.js`): `AUTOFILL`, `AUTOFILL_CREDIT_CARD`, `AUTOFILL_IDENTITY`, `CLEAR_TOKEN`, `COPY_PASSWORD`, `COPY_TOTP`, `FETCH_PASSWORDS`, `GET_STATUS`, `GET_TOKEN`, `KEEPALIVE_PING`, `LOCK_VAULT`, `RESET_DPOP_KEY`, `UNLOCK_VAULT` (13).
  - Content-allowed (sent from `src/content`): `AUTOFILL_FROM_CONTENT`, `CHECK_PENDING_SAVE`, `DISMISS_SAVE_PROMPT`, `GET_MATCHES_FOR_URL`, `GET_CC_MATCHES_FOR_URL`, `GET_IDENTITY_MATCHES_FOR_URL`, `LOGIN_DETECTED`, `PASSKEY_CHECK_DUPLICATE`, `PASSKEY_CREATE_CREDENTIAL`, `PASSKEY_GET_MATCHES`, `PASSKEY_SIGN_ASSERTION`, `SAVE_LOGIN`, `START_CONNECT`, `UPDATE_LOGIN` (14).
  - Both sets are exported from `extension/src/lib/constants.ts`, next to `EXT_MSG`. A test asserts that the union equals the set of `case EXT_MSG.*` labels in `handleMessage`, and that the two sets are disjoint, so a new message type cannot go unclassified. The labels are read with the TypeScript compiler API, not grep.
  - A second test parses every `.ts`/`.js` file under `extension/src/content` with the TypeScript compiler API. It collects `EXT_MSG.<name>` property accesses and string literals equal to an `EXT_MSG` value, and asserts that none of them is extension-page-only. Without it, a content script that starts sending an extension-page-only type fails closed at runtime with no build signal. `public/offscreen.js` is an extension page and is not scanned.
- Control class: **enforceable boundary** against content-script senders. Adjudication authority: the browser-set `MessageSender.url`, which a content script cannot forge. Page JS cannot reach `chrome.runtime.sendMessage` at all, because there is no `externally_connectable`. Another extension's page reports its own extension URL, so it fails the prefix check.
- Consumer-flow walkthrough: the consumer of `expectedOrigin` is `performAutofillForEntry`, via the popup origin. It reads `expectedOrigin` for:
  - the CC/Identity probe check (C3);
  - the LOGIN fallback's top-frame rule;
  - `topFrameOrigin` in the LOGIN payload (C4).

  The content consumer `performAutofill` reads `{ allowedHosts, topFrameOrigin }`.

### C6: the save-banner push is pinned at delivery time

- Inside the existing 500 ms timer, before the send, the handler:
  - probes `{ tabId, frameIds: [0] }`;
  - requires `isHostMatch(pending.host, extractHost(probed.origin))`, the same predicate the `complete` handler runs today;
  - requires the pending entry still to be the one this timer was scheduled for (`pendingSavePrompts.get(tabId) === pending`);
  - and sends with `{ documentId: probed.documentId }`.
- **When a check fails.**
  - A failed probe, or a pending entry that was replaced: no push. The entry stays, and the CHECK_PENDING_SAVE pull, which is host-checked against the sender document, remains the fallback.
  - A host mismatch: no push, and the entry is deleted, as the `complete` handler already does for a mismatch.
- The `complete`-time host check stays. It decides whether to schedule at all.
- Control class: **enforceable boundary** for the delivery (`documentId`); the host rule is a **fail-closed verification gate** on the probed origin.
- Acceptance:
  - Deny: the probe reports a host not matching `pending.host`, so no `sendMessage` call is made.
  - Allow: the probe reports a matching host, so exactly one send is made, carrying `{ documentId: probed.documentId }` and the password.

### C7: inline-match lookups use browser-set sender URLs

```ts
// background/index.ts
function resolveSenderMatchUrl(sender: chrome.runtime.MessageSender): string | null;
```

- **What it returns.** It reproduces the content script's `window.top?.location?.href ?? window.location.href`, which the three detectors compute today, from browser-set data:
  - `sender.frameId === 0` → `sender.url`;
  - a subframe whose `sender.origin` equals the origin of `sender.tab.url` → `sender.tab.url`. Reading `window.top.location.href` succeeds exactly when the top document is same-origin. `sender.tab.url` can be absent (no host permission on the top origin, or mid-navigation) or unparseable; either way it is a non-match and falls through to the next case;
  - otherwise → `sender.url`;
  - no `sender.url` → `null`. A content-script sender always has `url`, so this is an unknown sender and fails closed for every kind.
- **Null handling.** `resolveInlineMatches` and `updateBadgeForTab` keep their `string` parameters. When `resolveSenderMatchUrl` returns `null`, each of the three handlers answers with its existing catch-branch response (`entries: []`, `vaultLocked: false`, `suppressInline: false`) before calling `resolveInlineMatches`, and does not update the badge.
  - This also covers CC/Identity, which deliberately return entries on *hostless* pages. A hostless page still has a `sender.url`, so that behaviour is unchanged; only an unknown sender is refused.
- **Relation to `AUTOFILL_FROM_CONTENT`.** That handler binds secret release to the frame's own `sender.url`, and C7's same-origin case returns `sender.tab.url`. The two agree on the host whenever C7's case fires, because same origin implies same host. C7 keeps the top-URL fallback only for suggestion parity with today's content behaviour. A code comment at `resolveSenderMatchUrl` states this, so the two rationales are not "harmonised" later.
- **Handlers.** `GET_MATCHES_FOR_URL`, `GET_CC_MATCHES_FOR_URL` and `GET_IDENTITY_MATCHES_FOR_URL` call `resolveInlineMatches(kind, resolveSenderMatchUrl(_sender))` and no longer read `message.url` / `message.topUrl`. The LOGIN badge update uses the same URL.
- **Message types.** `url` and `topUrl` are removed from the three message types in `types/messages.ts`, and the three content detectors (`form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`) stop sending them. A field the background ignores must not stay in the contract.
- **Behaviour change.**
  - It applies only where the content-supplied value differed from the browser's. Under `document.domain` relaxation, a cross-origin-but-same-site top was readable from content and is not same-origin here, so the subframe now matches on its own URL.
  - `document.domain` setting is deprecated and origin-keyed by default in current Chrome, so this case is accepted.
- **Control class.** **Enforceable boundary** against a content sender choosing which host's entries it learns. Adjudication authority: the browser-set `MessageSender.url`, `origin`, `frameId` and `tab.url`.
- **Acceptance.** Each row has a paired deny case and allow case.

  | Sender | Message | Result |
  |---|---|---|
  | content sender on `https://evil.example/` (frame 0) | `url: "https://bank.example/"` | matches computed for `evil.example`; no bank entries |
  | same-origin subframe of a `bank.example` tab | — | bank entries |
  | cross-origin subframe on `widget.example` in a `bank.example` tab | — | matched on `widget.example` |
  | same-origin subframe of a `bank.example` tab | `url`/`topUrl: "https://other.example/"` | bank entries (message ignored) |
  | cross-origin subframe on `widget.example` | `topUrl: "https://bank.example/"` | matched on `widget.example`; no bank entries |
  | subframe whose `sender.tab` has no `url` | — | matched on `sender.url` |
  | sender without `url` | `url`/`topUrl: "https://bank.example/"` (spoofed, so the pre-C7 code would match it) | catch-branch empty response, no badge update; all three kinds |
- **Consumer-flow walkthrough.** `resolveInlineMatches` reads the returned string as `effectiveUrl`: for `isOwnAppPage`, for `extractHost` (LOGIN), and for the badge's `updateBadgeForTab(tabId, url)`. The content detectors read only the response (`entries`, `vaultLocked`, `disconnected`, `suppressInline`), which is unchanged.

### Forbidden patterns

- pattern: `chrome.tabs.sendMessage(tabId, payload, { frameId })` — reason: the first send must not be addressed by frame.
- pattern: `frameId: frameId ?? 0` — reason: CC/Identity must not go to frame 0 by id.
- pattern: `if (window.top === window.self) return true;` — reason: C4 removes the unconditional top-frame pass.
- pattern: `enforceSenderHost?: string | null` — reason: replaced by `AutofillRequestOrigin` (C1).
- pattern: `}, { frameId: 0 }).then(` — reason: the save-banner push must be addressed by `documentId` (C6).
- pattern: `message.topUrl ?? message.url` — reason: inline-match lookups use the sender (C7).

## Testing strategy

- **Mock support (prerequisite).** `extension/src/__tests__/helpers/execute-script-mock.ts` answers only by `frameId`, and `documentIdFor(frameId)` is fixed. It gains two knobs:
  - a per-call document override, so a frame can answer a later probe with a different `documentId` and origin, which simulates navigation;
  - support for `target.documentIds`: answer only for a known id, and resolve `[]` for a gone one, matching Chrome, which returns no result for a document that no longer exists;
  - a "frame gone / probe empty" override for `frameIds` targets, so a `{ tabId, frameIds: [0] }` probe can resolve `[]` (`probeDocument` then throws). C6's probe-failure row uses it.

  `chrome.tabs.sendMessage` in the background mock rejects `{ documentId }` for a gone document with Chrome's no-receiver error text. Where a test needs a sequence the helper cannot express, it uses explicit `mockResolvedValueOnce` chains, named in the test.
- **`extension/src/__tests__/background.test.ts`**, per origin kind and per entry type (LOGIN, CC, Identity):
  - Each send's options argument:
    - content → `{ documentId: sender's }`;
    - context menu and popup CC/Identity → `{ documentId: probed }`;
    - popup LOGIN → no options (broadcast), and the payload carries `topFrameOrigin`.
  - Navigation:
    - Deny: the probe returns an origin that fails the rule, so `sendMessage` is never called.
    - Allow: the probe returns a matching origin, so exactly one send goes to the probed documentId.
  - Content fallback:
    - The probe of `documentIds: [id]` finds the document gone, so there is no injection, no `func`, and the result is `AUTOFILL_INJECT_FAILED`.
    - The same outcome for a same-host new document. This pins the intended D12 change.
    - Paired allow: the original document answers the probe, so the bundle goes to it and the resend uses `{ documentId }`.
  - Content without `sender.documentId` → `ORIGIN_MISMATCH`, and no fetch is made.
  - Popup with a missing, empty, or non-http(s) `expectedOrigin` → `ORIGIN_MISMATCH`, and no fetch is made.
  - **Rewrite** the existing `"still fills a CREDIT_CARD on a navigated page, top-frame only (accepted residual)"` test. A context-menu CC fill whose probe reports a host other than the click host now sends nothing and returns `ORIGIN_MISMATCH`. Its paired allow case is a probe on the click host, which sends once with `{ documentId }`.
  - Sender gate, for every member of `EXTENSION_PAGE_ONLY_MESSAGES` (table-driven):
    - Deny: a content sender (`url: "https://evil.example/"`, `tab` set) gets the failsafe response. The mocked fetch, `sendMessage`, `executeScript` and storage are not called, and the lock, unlock and token state is unchanged.
    - Allow: the same message is processed when sent from `url: chrome-extension://<id>/src/popup/index.html`, and when sent from the options page with `tab` set. `KEEPALIVE_PING`'s allow row asserts no `sendResponse` call, which is today's no-op; its deny row gets the failsafe response.
    - Members of `CONTENT_ALLOWED_MESSAGES` from a content sender are not refused.
  - Save banner (C6), with fake timers: the deny case and the allow case from C6, a probe failure (no push; the entry is kept), and a replaced pending entry (no push).
- **Existing sender fixtures (member set derived with `grep -rlE "messageHandlers\[0\]|handleMessage\(" extension/src/__tests__`).**
  - The files that drive `handleMessage` with a URL-less default sender are `background.test.ts`, `background-commands.test.ts`, `background/totp-handlers.test.ts`, `background/inline-matches.test.ts` and `background/team-entries.test.ts`. In each, the default sender becomes an extension-page sender, generalising `background.test.ts`'s existing `popupSender`. Content-origin calls keep an explicit content sender.
  - Every existing allow-side `AUTOFILL_FROM_CONTENT` sender fixture gains `documentId: documentIdFor(<its frameId>)`, consistent with what the probe mock reports for that frame. This includes the shared `fillFromFrame7` helper. Deny-side fixtures keep failing for their original reason.
  - Run the full extension suite after these updates and before any new assertion is written, so that a fixture refused by the new gates surfaces as a failure rather than as lost coverage.
- **C7**:
  - `background/inline-matches.test.ts` and `background.test.ts` cover the C7 table through `handleMessage` with explicit senders.
  - Each existing test that passes `url`/`topUrl` in the message moves to a sender that reproduces the same *frame situation*, not just the same URL. The two topUrl-precedence tests in `background.test.ts` split:
    - `"suppresses inline matches using topUrl from iframe context"` (frame `about:blank`) becomes a same-origin subframe sender, with `frameId` ≠ 0 and `origin` = `tab.url`'s origin. It stays suppressed.
    - `"suppresses using topUrl even when frame url is external"` describes a cross-origin frame claiming the own-app top. That is the spoof C7 closes, so it is replaced by the cross-origin spoof row, with the expectation flipped: it is matched on the frame's own URL and not suppressed.
  - Every deny row carries a spoofed message `url`/`topUrl` that the pre-C7 code would have honoured, so each deny test fails when C7 is reverted (red-proven).
  - Every other member of `grep -rlE "GET_(CC_|IDENTITY_)?MATCHES_FOR_URL" extension/src/__tests__` in `background.test.ts` and `background/inline-matches.test.ts` moves to an explicit top-frame content sender, `{ frameId: 0, url: <its current message url>, origin, tab: { id, url } }`, so its effective URL is unchanged. Tests that assert only an empty or `false` result would otherwise stay green while exercising nothing:
    - `"does not suppress inline matches when scheme differs from serverUrl"`;
    - `"does not suppress when serverUrl is missing"`;
    - `"LOGIN returns no entry when urlHost does not match the page host"`;
    - `"LOGIN returns empty on a hostless (file://) page"`.

    Each migrated test is red-proven by changing its sender URL on a scratchpad copy.
  - New badge test: a `GET_MATCHES_FOR_URL` from a sender on a matching host calls `updateBadgeForTab(tab.id, <sender-derived url>)`. Paired deny: a sender without `url` whose message spoofs a matching `url` does not update the badge.
  - `content/form-detector-inline.test.ts` and `content/cc-identity-detector.test.ts` assert that the sent message no longer carries `url`/`topUrl`. Member set: `grep -rlE "GET_(CC_|IDENTITY_)?MATCHES_FOR_URL" extension/src/__tests__`.
- **`extension/src/__tests__/context-menu.test.ts`**: rewrite every existing exact-positional `performAutofill` assertion in the `handleContextMenuClick` and `click host binding (C5)` describe blocks to the new `(entryId, tabId, origin, targetHint, teamId)` shape. Each rewrite re-checks that the site's `teamId`, `frameId` and `senderHost` survive the reorder; do not edit them mechanically. Add a case with `info.frameId` absent → `frameId: 0`.
- **`extension/src/__tests__/content/autofill.test.ts`**:
  - Rewrite the existing `"always fills the top frame regardless of allowedHosts"` test: a top frame with neither condition met now does not write.
  - Add the C4 table, using the existing `inSubframe` helper for the subframe row.
- **Popup**: `MatchList` sends `expectedOrigin` on Fill and on the confirm-sheet path. The exact-shape assertion `toHaveBeenCalledWith({ type: "AUTOFILL", entryId: "pw-1", tabId: 1, teamId: "team-1" })` in `extension/src/__tests__/popup/MatchList.test.tsx` gains `expectedOrigin`.
- **New `extension/src/__tests__/message-sender-partition.test.ts`**: the C5 partition test and the content-sender AST test.
- **Red proofs.** Every new assertion is red-proven on a scratchpad copy with the fix reverted, one mutation per clause (memory `feedback_mutation_proof_on_throwaway_only`).
- **Gates**:
  - `cd extension && npx vitest run && npm run build`;
  - `node scripts/checks/lint-extension.mjs`;
  - `scripts/pre-pr.sh` before push.

## User operation scenarios

1. Inline dropdown pick on a login page → content origin → the fill reaches only the requesting document.
2. Popup Fill on `https://sso-host/` whose login form is in a cross-origin iframe on the entry's host → broadcast → the iframe fills. The top frame's origin equals `expectedOrigin`, so it also passes C4 and runs its own LOGIN detection, as it does today. VE1 manual.
3. Popup search → host-mismatched LOGIN → confirmation sheet → Fill → the top document on the origin the sheet showed fills. If the tab navigated to another origin meanwhile, nothing fills. VE1 manual.
4. Context menu on a login field in a subframe → probe of that frame → fills that document only. VE1 manual.
5. Popup card fill → probe of frame 0 → origin = popup origin → the card goes to that document only. VE1 manual.
6. Login submit → redirect to a page on the same host → Save banner appears (C6 allow side). VE1 manual.
7. A content script sends `COPY_PASSWORD` → refused, and no password is fetched.

## Considerations & constraints

### Scope contract

- **SC1:** the popup LOGIN broadcast residual. Under the broadcast, every frame's content script receives the LOGIN payload before C4 decides; page JS cannot read the isolated world, but the plaintext is in the renderer process of every frame, including site-isolated third-party ones, so a compromised renderer can read it. This is pre-existing (today's broadcast has the same exposure) and not widened by this plan. The user requires iframe delivery, so the broadcast stays. Removing the residual needs per-frame enumeration in the background, through the `webNavigation` permission or an all-frames `executeScript` probe whose reach depends on per-frame host permission. A follow-up issue only if the user wants it.
- **SC2:** `PSSO_TRIGGER_INLINE_SUGGESTIONS` sends carry no secret and are unchanged.
- **SC4:** `AUTOFILL_FROM_CONTENT` for CC/Identity has no host binding, because those entries are hostless by design. No host exists to bind to, and the background cannot verify a user gesture in the requesting frame. This is not a deferral but a property of the entry type; C2 makes sure the delivery reaches only the requesting document. (The `GET_*_MATCHES` half of the round-1 SC4 is now C7.)
- **SC3:** `extractHost`/`isHostMatch` compare hostnames only, across the codebase. C4 and C3's popup rule use an exact origin for the new popup pin, but the existing `allowedHosts` and sender-host rules keep hostname semantics. Changing those is out of scope.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `AutofillRequestOrigin` + signature | locked |
| C2 | content path pinned to `sender.documentId` | locked |
| C3 | context-menu / popup CC-Identity probe-then-pin | locked |
| C4 | content frame gate checks the top frame | locked |
| C5 | popup `expectedOrigin` + extension-page-only sender gate | locked |
| C6 | save-banner push pinned at delivery time | locked |
| C7 | inline-match lookups use browser-set sender URLs | locked |

## Implementation Checklist

Derived in Phase 2 Step 2-1 (impact analysis).

### Production
- `extension/src/lib/constants.ts`: `EXTENSION_PAGE_ONLY_MESSAGES` and `CONTENT_ALLOWED_MESSAGES` (C5).
- `extension/src/types/messages.ts`:
  - `expectedOrigin` on `AUTOFILL` / `AUTOFILL_CREDIT_CARD` / `AUTOFILL_IDENTITY`;
  - remove `url`/`topUrl` from `GET_*_MATCHES_FOR_URL`;
  - `AutofillPayload.topFrameOrigin`.
- `extension/src/background/index.ts`:
  - `AUTOFILL_REQUEST_KIND` / `AutofillRequestOrigin`;
  - `performAutofillForEntry` (C1-C3);
  - the three callers;
  - `respondWithFailure` extracted from the `onMessage` failsafe, and the sender gate (C5);
  - the save-banner timer (C6);
  - `resolveSenderMatchUrl` and the three `GET_*_MATCHES` handlers (C7).
- `extension/src/background/context-menu.ts`: `ContextMenuDeps.performAutofill` and `handleContextMenuClick` (C1, `info.frameId ?? 0`).
- `extension/src/content/autofill-lib.ts`: `isFrameAllowedToFill` (C4).
- `extension/src/popup/components/MatchList.tsx`: `expectedOrigin` (C5).
- `extension/src/content/form-detector-lib.ts`, `cc-form-detector-lib.ts`, `identity-form-detector-lib.ts`: stop sending `url`/`topUrl` (C7).

### Reuse, do not reimplement
- `probeDocument`, `ProbedDocument`, `injectContentBundleInto`, `resendUntilReceived` (`background/content-bundle.ts`).
- `extractHost` and `isHostMatch` (`lib/url-matching.ts`).
- The existing `onMessage` failsafe switch, which is extracted as is rather than rewritten.

### Tests — all test trees
`extension/src/__tests__` is the only tree that tests these symbols; the one co-located test, `lib/webauthn-rp-id.test.ts`, is unrelated.
- **C4 top-frame gate.** Every content test that calls `performAutofill` or dispatches `AUTOFILL_FILL` in the jsdom top frame (`http://localhost:3000/`) without `allowedHosts` would now be denied. The member set comes from `grep -rlE "performAutofill\(|AUTOFILL_FILL" extension/src/__tests__`:
  - `content/autofill.test.ts` (about 80 calls);
  - `content/autofill-react.test.tsx`;
  - `content/fill-listener-errors.test.ts`.

  Each such payload gains `allowedHosts: ["localhost"]`, the jsdom host. A test that exercises the deny side keeps its own value.
- The sender fixtures, the C2 `documentId` fixtures, the C7 sender migration, the context-menu positional assertions, the `MatchList` exact-shape assertion, and the mock helper are as listed in the Testing strategy.

### CI parity
The extension's CI gates are `npm test`, `npm run build` and `scripts/checks/lint-extension.mjs`. All three run in `scripts/pre-pr.sh`, so there is no gap.
