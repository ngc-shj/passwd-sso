# Plan: ext-connect-user-activation-gate (C15-v2)

Date: 2026-05-27
Branch: `feat/ext-connect-user-activation-gate`

## Project context

- Type: **web app + browser extension** (Next.js 16 + Chrome MV3 extension)
- Test infrastructure: **unit + integration + CI** (vitest both sides, GitHub Actions)
- Predecessors:
  - PR #491: DPoP sender-constrained tokens (RFC 9449)
  - PR #492: SW-initiated bridge-code + cnf_jkt trust path
  - PR #495 (C14): EXTENSION_BRIDGE_CODE_ISSUE_FAILURE audit emission
  - C15 v1 (naive `isActive` gate on useEffect): **rejected**
    — see `docs/archive/review/c15-user-activation-validation.md`
  - C15-v2 prototype (`prototype/click-driven-ext-connect`): UX-validated by
    end user (違和感ない after wording change to "拡張機能との接続を許可"),
    empirical confirmation `isActive: true, hasBeenActive: true` at click.

## Objective

Close the residual XSS-on-page-load auto-fire of `PASSWD_SSO_EXT_CONNECT_REQUEST`
by combining:

1. **Web-app side**: replace the `?ext_connect=1` auto-firing useEffect with an
   explicit click-driven confirmation step ("拡張機能との接続を許可"). The user
   must click before `window.postMessage(EXT_CONNECT_REQUEST, ...)` fires.
2. **Content-script side**: gate the `EXT_CONNECT_REQUEST` handler on
   `navigator.userActivation.isActive`. Drop silently (no `EXT_CONNECT_READY`
   response) when activation is false — oracle prevention.

Together these enforce: any `EXT_CONNECT_REQUEST` that the SW processes was
the direct consequence of a real user gesture within the past 5 seconds.
Programmatic `.click()` and synthesized `MouseEvent` do NOT set user
activation per the HTML User Activation v2 spec — so XSS in the host page
cannot forge it.

## Requirements

### Functional

- The legitimate `?ext_connect=1` flow ends with the extension connected,
  same as today. Cost: one additional click on a confirmation card.
- Non-`?ext_connect=1` dashboard pages are unchanged.
- The content-script gate applies to `EXT_CONNECT_REQUEST` messages
  regardless of whether the page is on `/dashboard?ext_connect=1` or any
  other dashboard route — XSS could fire from anywhere, so the gate must
  protect everywhere.
- The drop on activation failure is **silent** (no `EXT_CONNECT_READY`
  reply) — preventing an XSS oracle that could distinguish "extension
  installed but I lack activation" from "extension absent."

### Non-functional

- No new audit emission introduced by this PR (the drop happens entirely
  in the extension content script; the server is never reached). The
  existing C14 `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` audit still fires
  if XSS ever bypasses the gate and reaches the server.
- No change to the server-side bridge-code route, no DB migration, no
  enum addition, no schema change.
- No change to `extension/manifest.json` permissions.

## Technical approach

### Content-script gate (the actual security mechanism)

`extension/src/content/token-bridge-lib.ts` (and the parallel
`extension/src/content/token-bridge.js` per
`project_extension_parallel_impl` memory):

```ts
// Pseudo — body in implementation phase
async function handleConnectRequestMessage(event: MessageEvent): Promise<boolean> {
  const { reqId } = (event.data ?? {}) as { reqId?: unknown };
  if (typeof reqId !== "string" || reqId.length === 0) return false;

  // C15-v2 gate: require fresh user activation in the host page. Silent
  // drop — no postReady — so XSS cannot distinguish "no activation" from
  // "extension absent." Real users always have activation because the
  // legitimate flow only sends EXT_CONNECT_REQUEST from an onClick handler.
  if (!navigator.userActivation?.isActive) return false;

  if (!isContextValid()) { /* unchanged */ }
  // ... unchanged
}
```

Property: when the API is unavailable (`navigator.userActivation` is
undefined on a very old browser), the check fails-closed (`undefined?.isActive`
is `undefined` → falsy → drop). The extension targets Chrome MV3 where the
API has been stable since Chrome 88 (Jan 2021) — older browsers cannot run
the extension at all, so fail-closed is safe.

### Web-app click-driven flow (provides activation for the legitimate path)

`src/components/extension/auto-extension-connect.tsx`:

- New `CONNECT_STATUS.AWAITING_CLICK` state.
- `useEffect` on `?ext_connect=1` sets status to `AWAITING_CLICK` instead of
  auto-firing `connect()`.
- New `handleConnectClick` callback removes `?ext_connect=1` from URL and
  calls `connect()`. The click guarantees `userActivation.isActive === true`
  at the postMessage moment.
- New i18n labels: `awaitingClickTitle`, `awaitingClickDescription`,
  `awaitingClickAction` ("拡張機能との接続を許可" / "Allow extension connection")
  — already drafted on the prototype branch.

`src/lib/constants/integrations/connect-status.ts`: add
`AWAITING_CLICK: "awaiting_click"`.

### Tests

- **New**: `extension/src/__tests__/content/token-bridge-user-activation.test.ts`
  — explicitly tests the new gate (accept when `isActive: true`, silent drop
  when `isActive: false`, drop when `navigator.userActivation` is undefined).
  Mock `navigator.userActivation` in `beforeEach`.
- **Update**: existing `token-bridge.test.ts` tests must inject
  `navigator.userActivation = { isActive: true }` in `beforeEach` so the
  existing happy-path tests don't regress.
- **Rewrite**: `src/components/extension/auto-extension-connect.test.tsx`
  with click-driven assertions. Restore the file structure from git history
  (commit `c0a459d8^` has the original) but insert a `userEvent.click(...)`
  step where the old tests assumed auto-fire.
- **No new** server-side test (no server change).

### Manual test artifact (R35)

`docs/archive/review/ext-connect-user-activation-gate-manual-test.md` — Tier-1
(content script is extension-deployed). Required sections per R35: Pre-conditions
/ Steps / Expected result / Rollback. Manual test scenarios:

- **TC1**: legitimate flow (extension popup Connect → sign-in → Allow click)
  → SW receives START_CONNECT → bridge-code issued → extension connected.
- **TC2**: XSS simulation (run `window.postMessage(EXT_CONNECT_REQUEST, ...)`
  from DevTools console without user gesture) → silent drop, no
  EXT_CONNECT_READY response observed.
- **TC3**: programmatic `.click()` on the Allow button via DevTools console
  → activation NOT set → postMessage either does not fire (web-side guarded
  via the click handler being attached to a real onClick) OR fires but is
  dropped by content-script gate. Verify by observing absence of audit row.
- **TC4**: rapid-fire test — user clicks Allow, then within 5 seconds XSS
  fires another postMessage with a fake reqId → activation is still true
  → SW processes the duplicate. Documented limitation.

## Contracts

### C1 — Content-script gate (locked)

- File: `extension/src/content/token-bridge-lib.ts` AND the parallel JS twin
  `extension/src/content/token-bridge.js`. **Both files must be edited
  symmetrically** per memory `project_extension_parallel_impl` — the `.js`
  file is the production artifact, `-lib.ts` is test-only. Divergence
  silently disables the gate in production.
- In `handleConnectRequestMessage`, after the `reqId` validation and BEFORE
  the `isContextValid()` check:
  - `.ts` version: `if (!navigator.userActivation?.isActive) return false;`
  - `.js` version: `if (!navigator.userActivation || !navigator.userActivation.isActive) return;`
    (returns void — matches the file's existing return discipline since the
    .js handler does not propagate boolean to the listener)
- The drop is silent — no `postReady(...)` call. The early return matches
  the existing "ignore-unknown-type" oracle-prevention pattern.
- **Invariants**:
  - The gate fires AFTER `reqId` shape validation (so malformed payloads are
    still rejected cheaply).
  - The gate fires BEFORE `isContextValid()`. **Rationale is oracle
    prevention, not performance**: `isContextValid()` failure path emits
    `postReady(reqId, false, "EXTENSION_ABSENT")` — if it ran first, an
    XSS could observe the EXTENSION_ABSENT reply and learn the extension's
    presence without needing activation. Placing the gate before
    isContextValid keeps the silent-drop semantics intact.
  - **No `postReady` on activation failure**. Any code path that adds a
    `postReady` between `reqId` validation and the SW call would re-open
    the oracle.
  - `navigator.userActivation` is checked with optional chaining
    (`?.isActive`) so undefined-API environments fail-closed.
  - **Only `isActive` matters, NOT `hasBeenActive`.** Sticky activation
    (`hasBeenActive: true, isActive: false`) is post-expiry state — XSS
    can race after activation expires and observe `hasBeenActive: true`
    indefinitely. A regression that switches `isActive` → `hasBeenActive`
    silently defeats the gate.
- **Sync test extension** (token-bridge-js-sync.test.ts): the existing
  parallel-impl sync test currently only checks for three message-type
  string literals. It MUST gain an assertion that `token-bridge.js`
  contains the literal `navigator.userActivation` to guard against the
  RT4 vacuous-test pattern (gate exists in `.ts` only, production `.js`
  silently lacks it, all unit tests still green).
- **Acceptance**: unit tests cover (a) accept when isActive=true,
  (b) silent drop when isActive=false, (c) silent drop when
  navigator.userActivation is undefined, (d) silent drop when
  navigator.userActivation is `{}` (no isActive property),
  (e) silent drop when navigator.userActivation is
  `{ isActive: false, hasBeenActive: true }` (pins isActive-not-hasBeenActive
  invariant), (f) gate fires after reqId validation,
  (g) gate fires before isContextValid (verified by stubbing
  chrome.runtime to undefined AND isActive=false → no postReady),
  (h) gate is pathname-independent (set window.location to a non-/dashboard
  path, gate still fires).
- **Forbidden patterns** (grep, applied to token-bridge-lib.ts and
  token-bridge.js):
  - No `postReady(...)` between the reqId-validation line and the SW
    round-trip call site. Structural rule: the only statements between
    `if (typeof reqId ...)` and `chrome.runtime.sendMessage` are the
    activation gate and the `isContextValid()` branch.
  - No `console.log` / `console.warn` describing the activation drop
    (would create an oracle via the page's `console` interception).

### C2 — Web app click-driven flow (locked)

- `src/lib/constants/integrations/connect-status.ts`: extend `CONNECT_STATUS`
  with `AWAITING_CLICK: "awaiting_click"`.
- `src/components/extension/auto-extension-connect.tsx`:
  - `useEffect` on `?ext_connect=1`: sets `status` to
    `CONNECT_STATUS.AWAITING_CLICK`. Does NOT remove the URL param yet
    (so reload reproduces the prompt; param removed on click).
  - `useEffect` dependency array: empty `[]` (one-shot per mount).
    `didRunRef` still guards against React StrictMode double-invoke.
  - New `handleConnectClick` callback:
    1. Remove `?ext_connect=1` from URL via `history.replaceState`.
    2. Call `connect()` (existing function, unchanged).
  - New UI branch for `AWAITING_CLICK`:
    - Icon: `<KeyRound />` (reused from header)
    - Title: `t("awaitingClickTitle")`
    - Description: `t("awaitingClickDescription")`
    - **Single button** (no "Go to dashboard" subnav — per UX feedback)
      labelled `t("awaitingClickAction")`
- **Invariants**:
  - The click handler MUST be attached to `onClick={handleConnectClick}`
    (a React synthetic-event onClick), NOT a `setTimeout` or other indirect
    trigger. Programmatic `.click()` is acceptable in tests (we mock
    `navigator.userActivation`), but in production the only path to
    `handleConnectClick` is a real user gesture.
  - The URL param removal happens INSIDE `handleConnectClick` (not in
    `useEffect`) so reload of the awaiting-click page reproduces the prompt
    rather than auto-firing.
  - The Allow button MUST carry `data-c15-action="allow-connect"` attribute
    so the C5 manual test snippet (`document.querySelector("button[data-c15-action]")`)
    is stable across i18n / icon changes.
  - `useEffect` dependency array is `[]`. `setStatus` from useState is
    stable; if the project's lint enforces `react-hooks/exhaustive-deps`
    and flags this, add `// eslint-disable-next-line react-hooks/exhaustive-deps`
    with a one-line reason ("setStatus is stable").
  - `ExtConnectBanner` (`src/components/extension/ext-connect-banner.tsx`)
    also reads `?ext_connect=1` and renders an inline "connecting" banner.
    Under the new URL-retention model, the banner co-renders with the
    AWAITING_CLICK overlay. The overlay (z-50, `fixed inset-0`) visually
    masks the banner, but the banner DOM remains. **Verify**: banner has
    no `aria-live` region — if it does, the duplicate announcement would
    be a real a11y bug to fix in this PR. If it doesn't (visual-only),
    document the behavior as accepted.
- **Acceptance**: component tests cover (a) `?ext_connect=1` →
  AWAITING_CLICK state, no postMessage yet, (b) click → CONNECTING →
  CONNECTED, (c) reload of AWAITING_CLICK page re-prompts (URL still has
  `?ext_connect=1` until click).
- **Forbidden patterns** (grep on auto-extension-connect.tsx):
  - `console\.log\(.*C15-v2` — reason: prototype instrumentation; must be
    absent in production code.
  - `connect\(\)` call inside a `useEffect` body — reason: the only place
    that calls connect() is `handleConnectClick`.

### C3 — i18n parity (locked)

- `messages/en/Extension.json` and `messages/ja/Extension.json` each gain
  three new keys: `awaitingClickTitle`, `awaitingClickDescription`,
  `awaitingClickAction`.
- ja translations are user-approved (from prototype):
  - title: `拡張機能との接続を許可しますか?`
  - description: `意図しない自動操作を防ぐため、下のボタンで接続を許可してください。`
  - action: `拡張機能との接続を許可`
- en translations:
  - title: `Allow extension connection?`
  - description: `To prevent unintended automated actions, allow the connection using the button below.`
  - action: `Allow extension connection`
- **Invariant**: en + ja key sets are identical (enforced by the existing
  i18n parity tests).
- **Acceptance**: `i18n-key-parity.test.ts` (or whatever the project's
  i18n parity test is called) passes without modification.

### C4 — Test coverage (locked)

**Mock pattern for `navigator.userActivation` (mandatory)**:
```ts
let originalUserActivationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  originalUserActivationDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype, "userActivation"
  );
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive: true, hasBeenActive: true },
    configurable: true, writable: true,
  });
});
afterEach(() => {
  delete (navigator as Navigator & { userActivation?: unknown }).userActivation;
  if (originalUserActivationDescriptor) {
    Object.defineProperty(Navigator.prototype, "userActivation",
      originalUserActivationDescriptor);
  }
});
```
Do NOT use `vi.stubGlobal("navigator", ...)` — it overwrites the whole
`navigator` object and loses prototype accessors (userAgent, language, etc.)
that other code under test may read. Pattern reference:
`extension/src/__tests__/content/autofill-identity.test.ts`.

**NEW** `extension/src/__tests__/content/token-bridge-user-activation.test.ts`:
- `it("processes EXT_CONNECT_REQUEST when navigator.userActivation.isActive is true")`
- `it("silently drops when isActive is false (no EXT_CONNECT_READY emitted)")`
- `it("silently drops when navigator.userActivation is undefined")`
- `it("silently drops when navigator.userActivation is {} (no isActive property)")`
- `it("silently drops when navigator.userActivation is { isActive:false, hasBeenActive:true } (sticky-only)")`
   — pins the "isActive not hasBeenActive" invariant
- `it("activation check fires after reqId validation")`
- `it("activation check fires before isContextValid (no EXTENSION_ABSENT reply on activation-fail)")`
- `it("applies gate regardless of host page URL (XSS could fire from any dashboard route)")`

**NEW** sync-test addition in
`extension/src/__tests__/content/token-bridge-js-sync.test.ts`:
- `it("token-bridge.js contains the navigator.userActivation gate")` —
   read the .js file as raw text, assert `/navigator\.userActivation/.test(file)`.
   Closes the RT4 vacuous-test gap where the gate could exist only in `.ts`.

**UPDATE** existing `extension/src/__tests__/content/token-bridge.test.ts`:
- Add the `Object.defineProperty(navigator, "userActivation", ...)` from
  the mandatory pattern above in beforeEach (with cleanup in afterEach).
  Default value `{ isActive: true }` so happy-path tests pass unchanged.

**REWRITE** `src/components/extension/auto-extension-connect.test.tsx`:
- The file still exists on `main` (was deleted only on the prototype branch).
  **Modify in place**, do NOT restore from git history.
- Per-test transformation rules (mechanical-click-insert is INSUFFICIENT;
  follow these explicitly):
  1. Tests that originally observed mount-time auto-fire MUST first assert
     AWAITING_CLICK state + no `mockRequestExtensionConnect` call, then
     `userEvent.click` the Allow button, then await final state.
  2. Tests that asserted `replaceStateSpy` was called (URL cleanup) MUST
     verify the call happens AFTER the click, not on mount.
  3. The "Go to dashboard" subnav button no longer exists on the
     AWAITING_CLICK state (per UX feedback) — drop any test that clicks it
     from this state. Tests that click it from CONNECTED state are unchanged.
- **NEW** tests for the click-driven invariants:
  - `it("?ext_connect=1 shows AWAITING_CLICK prompt with no postMessage yet")`
  - `it("does NOT call requestExtensionConnect on mount (click is the only trigger)")`
    — render with `?ext_connect=1`, flush microtasks + a tick, assert
    `mockRequestExtensionConnect` not called. Closes the RT4 "test the lock
    but not the door" pattern.
  - `it("keeps ?ext_connect=1 in URL while AWAITING_CLICK (reload re-prompts)")`
    — assert `replaceStateSpy` NOT called and `window.location.search`
    still contains the param.
  - `it("removes ?ext_connect=1 only after the user clicks Allow")` —
    click then assert `replaceStateSpy` called exactly once with the param
    removed.
  - `it("S3: re-rendering with ?ext_connect=1 retained shows the prompt again")`
    — unmount + remount with same searchParams, assert AWAITING_CLICK appears.
- `getByRole("button", { name: ... })` not `getByText` for button queries.
- DO NOT drop `await waitFor(...)` blocks even though click is synchronous —
  `userEvent.click` is async and the subsequent setState is batched.

**i18n parity test**: the project does NOT currently enforce
`Object.keys(en) === Object.keys(ja)` for `Extension.json`. Add a small
parity assertion in C4:
- File: `src/__tests__/i18n/extension-parity.test.ts` (new) or fold into
  an existing keys-coverage test if one exists.
- `it("Extension.json en and ja have matching key sets")` — import both
  JSON files, assert `Object.keys(en).sort()` equals `Object.keys(ja).sort()`.

**NO** new server-side test (no server change).

### C5 — Manual test artifact (locked, R35-mandatory)

- File: `docs/archive/review/ext-connect-user-activation-gate-manual-test.md`.
- Sections required by R35 Tier-2: Pre-conditions, Steps, Expected result,
  Rollback, **Adversarial scenarios**.
- Each adversarial scenario MUST specify (a) a copy-pasteable DevTools
  snippet, (b) the precise observable to record (no "absence of audit
  row" — that requires DB access; instead observe browser-side signals).
- Adversarial scenarios:
  - **TC2 (XSS autonomous fire)**: paste
    `window.postMessage({type:"PASSWD_SSO_EXT_CONNECT_REQUEST", reqId:"xss-1"}, location.origin)`
    in DevTools console without any preceding click. **Observable**: no
    `[PASSWD_SSO_EXT_CONNECT_READY]` postMessage observed in DevTools
    "Sources → Event Listener Breakpoints → message" (or the page's
    response handler). Pass: no reply within 5 seconds.
  - **TC3 (programmatic .click)**: paste
    `document.querySelector("button[data-c15-action]")?.click()` in
    DevTools console. (Note: C2 implementation MUST add the
    `data-c15-action` attribute to the Allow button to make this snippet
    work.) **Observable**: either no `connect()` runs (handler-level
    drop) OR connect() runs and the content-script silently drops
    (no EXT_CONNECT_READY response).
  - **TC4 (5-second race)**: pre-stage a DevTools console with:
    ```js
    setTimeout(() => window.postMessage(
      {type:"PASSWD_SSO_EXT_CONNECT_REQUEST", reqId:"race-1"},
      location.origin
    ), 1500);
    ```
    Press Enter to queue, then within 1 second click the Allow button.
    **Observable**: the legitimate connect succeeds AND a second
    EXT_CONNECT_READY arrives ~1500ms later for `reqId:"race-1"`.
    This is the **documented limitation** (5s transient activation
    window allows race). Pass condition: legitimate vault state survives
    (vault still unlocked) — i.e., the race causes audit noise + rate-limit
    consumption but no user-visible vault relock. If the user IS forced to
    re-unlock, that's the worst-case documented residual; either outcome
    is acceptable per plan §S6 but the manual test must record which one.
  - **TC5 (timeout collapse)**: paste a DevTools listener:
    ```js
    window.addEventListener("message", e => {
      if (e.data?.type === "PASSWD_SSO_EXT_CONNECT_READY")
        console.log("[reply]", performance.now(), e.data);
    });
    ```
    Then fire `window.postMessage` from TC2. **Observable**: no `[reply]`
    log within 10 seconds. Confirms silent-drop (no EXT_CONNECT_READY).
    Distinguishes from "extension not installed" only because the
    web-app's `requestExtensionConnect` 8-second timeout coerces both
    cases to the same EXTENSION_ABSENT result on the page side.

## Consumer-flow walkthrough

This change affects two consumers:

- **Consumer A** (`AutoExtensionConnect` component): reads
  `CONNECT_STATUS.AWAITING_CLICK` in its render branch. After C2 lands the
  type union includes the new value; the exhaustive-switch (if any) must
  handle it. **Verified**: the component does NOT use an exhaustive switch
  — it uses `if (status === X)` chained checks. Missing a branch produces
  "render nothing" (safe fallback). No additional consumer guard needed.
- **Consumer B** (content script's `handlePostMessage`): the new gate
  in `handleConnectRequestMessage` returns `false` on activation failure.
  The outer `handlePostMessage` propagates the boolean. No web-app consumer
  reads this return value (it's used only by tests). **Verified**: grep for
  `handlePostMessage` callers shows only the test file + the
  `startPostMessageListener` wrapper which discards the return value via
  `void`. Safe.

## Testing strategy

1. **Web-app vitest**: rewritten component tests cover click-driven flow.
2. **Extension vitest**: new content-script test for the gate; existing
   tests extended with the activation stub.
3. **`scripts/pre-pr.sh`**: full gate including next build, lint, all
   vitest runs, static checks.
4. **Manual test artifact**: documented per R35; tester runs each scenario
   on a fresh Chrome with the production-built extension.

## Considerations & constraints

- **5-second race window**: after a legitimate click, transient activation
  persists for ~5 seconds. XSS that fires within that window passes the
  gate. This is a documented limitation — the gate raises the bar for
  autonomous XSS (which is the common case), not for XSS that races a
  user click. Mitigations beyond this PR's scope:
  - Server-side: rate-limit and per-user limit on bridge-code route
    (already in place, PR #491+#492).
  - Forensic: C14 audit emission ensures the abnormal flow is observable.
  - Token binding: DPoP cnf_jkt (PR #491) ensures the issued token cannot
    be exfiltrated even if XSS succeeds.

- **Reload behaviour**: C2 keeps `?ext_connect=1` in the URL until the
  user clicks. Reload re-prompts. This matches the user's mental model
  ("I came here to connect; let me do that again if I reload").

- **Browser support**: `navigator.userActivation` is Chrome 88+ (Jan 2021),
  Edge 88+, Firefox 134+ (Jan 2025), Safari TP. The extension targets
  Chrome MV3 only; non-Chromium browsers are out of scope. Fail-closed
  on undefined API is safe-by-design.

- **Test-hygiene check**: the prototype branch used `describe.skip` which
  is forbidden by `scripts/checks/check-test-hygiene.sh`. This plan
  REWRITES the test file (not skips). The new file passes the check.

- **Out of scope**:
  - SW-side `pendingConnect` flag (Option C from prior discussion) — alternative
    design considered, not adopted.
  - Extension popup → SW direct fetch (Option A) — significant
    architectural change, out of C15's scope.
  - Modifying the C14 audit emission — server-side is untouched.
  - **SW-side sender check for `START_CONNECT`**: the SW
    (`extension/src/background/index.ts`) currently trusts any extension-internal
    sender of `START_CONNECT`. The C15-v2 gate is enforced only in the
    token-bridge content script. The C15 threat model is host-page XSS,
    which cannot reach the SW except through token-bridge (chrome's
    isolated-world boundary), so the gate is sufficient for the stated
    threat. Defense-in-depth via `_sender.tab?.url` whitelisting in the
    SW handler is a separate hardening opportunity — track as future work,
    not blocking for C15-v2.
  - **Frame-ancestors / clickjacking**: the user activation gate accepts
    clicks inside an iframed dashboard. Frame-ancestors enforcement is an
    orthogonal control owned by `src/lib/proxy/security-headers.ts`.
    C15-v2 does not subsume that control; verify the dashboard's
    frame-ancestors is restrictive enough at review time but no change
    required in this PR.

- **5-second transient activation window — observable damage profile**:
  the user activation duration is **implementation-defined** per the HTML
  spec (https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation
  §"User activation processing"); Chromium/Firefox/Safari all use ~5s but
  no normative number exists. Within that window, an XSS that races a
  legitimate user click can:
  - cause a duplicate bridge-code fetch (consumes per-user 10/15min +
    per-IP 60/min rate-limit budgets)
  - if the token rotation triggers `tokenChanged` in the SW, force
    `clearVault()` → user-visible vault relock prompt
  - generate a C14 `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` audit row if
    the second call hits any failure path
  - NOT exfiltrate the token (DPoP cnf_jkt binds it to the SW's IDB key,
    which is not reachable from MAIN-world XSS).

  TC4 in C5 must record whether the legitimate vault survives the race
  or is force-relocked — either outcome is acceptable but the actual
  behavior must be documented.

- **Anti-deferral**: every contract listed above is in this PR's acceptance.
  No "we'll fix in next PR" entries.

## User operation scenarios

- **S1 (canonical)**: user clicks extension popup Connect → signs in →
  lands on `/dashboard?ext_connect=1` → sees "拡張機能との接続を許可しますか?"
  card → clicks "拡張機能との接続を許可" button → connection completes →
  dashboard shows.
- **S2 (already-signed-in)**: user with active session clicks extension
  popup Connect → tab opens at `/dashboard?ext_connect=1` (no sign-in
  step) → vault unlock (if locked) → Allow click → connection completes.
- **S3 (reload before click)**: user lands on AWAITING_CLICK page → reloads
  → sees the prompt again → clicks → connection completes.
- **S4 (close without clicking)**: user lands on AWAITING_CLICK page →
  closes tab. No side effects on server, no audit row.
- **S5 (XSS attempt — page-load auto-fire)**: XSS payload runs on dashboard
  load → fires `postMessage(EXT_CONNECT_REQUEST, ...)` → activation is
  false (no preceding gesture) → content-script silently drops → no
  EXT_CONNECT_READY → no audit row → attacker observes no oracle signal.
- **S6 (XSS attempt — race after user gesture)**: documented limitation —
  XSS that fires within 5s of any user gesture passes the gate. Defense:
  C14 audit + DPoP cnf_jkt + rate-limit.

## Go/No-Go Gate

| ID  | Subject                                       | Status |
|-----|-----------------------------------------------|--------|
| C1  | Content-script userActivation gate            | locked |
| C2  | Web-app click-driven flow + AWAITING_CLICK    | locked |
| C3  | i18n parity (en + ja, 3 new keys)             | locked |
| C4  | Test coverage (content script + component)    | locked |
| C5  | Manual test artifact (R35 Tier-2)             | locked |
