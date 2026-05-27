# Manual Test: ext-connect-user-activation-gate (C15-v2)

Date: 2026-05-28
Branch: `feat/ext-connect-user-activation-gate`
R35 tier: **Tier-2** (content script is extension-deployed; security control)

## Pre-conditions

- Dev environment running: `npm run dev` (web app at http://localhost:3000)
- Docker DB + Redis + Jackson up: `npm run docker:up`
- Extension built (`cd extension && npm run build`) and loaded unpacked in
  Chrome (`chrome://extensions` → Load unpacked → `extension/dist`)
- `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` in `.env` includes the unpacked
  extension's origin (already present for known IDs in `.env`)
- A test user account with vault initialized + signed in once before
  testing

## Test scenarios

### TC1 — Legitimate flow (canonical happy path)

**Steps**:
1. Open a fresh Chrome window. Visit any non-passwd-sso page to ensure no
   stale activation.
2. Click the extension toolbar icon → click **Connect**.
3. Sign in if prompted; complete vault unlock if prompted.
4. The page lands on `/<locale>/dashboard?ext_connect=1`.
5. The AWAITING_CLICK card is displayed: **拡張機能との接続を許可しますか?**
   / "Allow extension connection?" + Allow button.
6. Click the **拡張機能との接続を許可** / "Allow extension connection" button.

**Expected result**:
- CONNECTING state briefly visible, then CONNECTED ("接続が完了しました" /
  "Connection complete") within ~3 seconds.
- URL no longer contains `ext_connect=1` (replaced via `history.replaceState`).
- "ダッシュボードへ" / "Go to dashboard" button returns to the dashboard.

**Rollback**: revert the PR; the auto-fire flow resumes.

### TC2 — XSS autonomous fire (adversarial)

**Steps**:
1. Complete TC1 so the extension is connected and the dashboard is open.
2. Open Chrome DevTools → Console.
3. Paste and run:
   ```js
   window.postMessage(
     {type: "PASSWD_SSO_EXT_CONNECT_REQUEST", reqId: "xss-tc2"},
     location.origin,
   );
   ```
4. Do NOT click anything else for 10 seconds.

**Expected result**:
- No `PASSWD_SSO_EXT_CONNECT_READY` reply appears in the console (no
  message-event handler logs anything for `reqId: "xss-tc2"`).
- No new audit log entry for `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`
  in `audit_logs` for this user (verify via DB query if access is
  available; otherwise skip and rely on the absence of EXT_CONNECT_READY
  as the primary observable).

**Why this matters**: confirms the silent-drop semantics. Any
EXT_CONNECT_READY would indicate the gate is broken.

### TC3 — Programmatic `.click()` on Allow button (adversarial)

**Steps**:
1. Sign out, then re-open the extension popup → click Connect → reach the
   AWAITING_CLICK page (do NOT click Allow yet).
2. Open DevTools → Console.
3. Paste and run:
   ```js
   document.querySelector("button[data-c15-action='allow-connect']").click();
   ```
4. Observe behavior.

**Expected result** (one of):
- **(a)** The `connect()` runs (the click handler fires per React's
  synthetic-event behavior), `requestExtensionConnect()` posts a
  EXT_CONNECT_REQUEST, but the content-script silently drops it
  (programmatic `.click()` does NOT set `navigator.userActivation.isActive`
  per HTML User Activation v2). After 8 seconds, the page shows the
  EXTENSION_ABSENT failure state (the `requestExtensionConnect` timeout).
- **(b)** Some browsers may now disable programmatic `.click()` on buttons
  whose handlers require activation — record whichever path was observed.

**Pass condition**: connection does NOT complete successfully (no
"接続が完了しました" / "Connection complete" state). Either outcome is
acceptable; record which one for the PR review.

### TC4 — Documented 5-second race-window limitation (adversarial)

**Steps**:
1. Reach the AWAITING_CLICK page as in TC3.
2. Pre-stage the DevTools console with:
   ```js
   setTimeout(() => window.postMessage(
     {type: "PASSWD_SSO_EXT_CONNECT_REQUEST", reqId: "race-tc4"},
     location.origin,
   ), 1500);
   console.log("[TC4] queued");
   ```
3. Press Enter (the "queued" log confirms staging).
4. Immediately (within 1 second) click the Allow button.

**Expected result**:
- The legitimate Allow click completes the connection (CONNECTED state
  observed within ~3s).
- About 1500ms after the Allow click, a SECOND
  `PASSWD_SSO_EXT_CONNECT_READY` postMessage is dispatched for
  `reqId: "race-tc4"` — observable by adding the listener below before
  step 3:
  ```js
  window.addEventListener("message", e => {
    if (e.data?.type === "PASSWD_SSO_EXT_CONNECT_READY") {
      console.log("[TC4 reply]", performance.now(), e.data);
    }
  });
  ```
- Record whether the vault remains unlocked (i.e., no
  `tokenChanged → clearVault()` is triggered) or whether the user is
  forced to re-unlock. **Either outcome is acceptable per plan §S6**, but
  the actual behavior MUST be documented in the PR description so future
  reviewers know the residual damage profile.

**Why this matters**: pins the documented limitation that the gate cannot
distinguish a legitimate click from an XSS payload that races within the
transient activation window (~5 s).

### TC5 — Timeout-collapse confirmation (informational)

**Steps**:
1. From any dashboard page (extension connected or not), open DevTools.
2. Paste:
   ```js
   window.addEventListener("message", e => {
     if (e.data?.type === "PASSWD_SSO_EXT_CONNECT_READY") {
       console.log("[TC5 reply]", performance.now(), e.data);
     }
   });
   window.postMessage(
     {type: "PASSWD_SSO_EXT_CONNECT_REQUEST", reqId: "tc5"},
     location.origin,
   );
   ```
3. Wait 10 seconds.

**Expected result**:
- No `[TC5 reply]` log appears (silent drop because no activation).
- This is indistinguishable from "extension not installed" at the page
  level — the web app's `requestExtensionConnect` helper has an 8-second
  timeout that returns EXTENSION_ABSENT in both cases.

**Why this matters**: confirms the timeout-collapse property that closes
the oracle — XSS cannot distinguish "extension installed, my activation
is bad" from "extension absent."

## Adversarial scenarios summary

| ID | Attack | Expected gate behavior |
|----|--------|------------------------|
| TC2 | XSS fires postMessage without activation | Silent drop (no EXT_CONNECT_READY) |
| TC3 | XSS calls `.click()` programmatically | Silent drop at content script (programmatic .click does not set activation) |
| TC4 | XSS races a real click within 5s | **Documented limitation**: SW accepts. Damage limited to duplicate fetch + audit noise + possible vault relock |
| TC5 | XSS observes timing of silent drop | Closed via 8s page-side timeout collapsing all failure paths to EXTENSION_ABSENT |

## Out of scope

- SW-side `_sender.tab?.url` whitelisting on `START_CONNECT` — separate
  defense-in-depth hardening, tracked as future work. See plan §"Out of scope".
- Frame-ancestors enforcement — owned by `src/lib/proxy/security-headers.ts`,
  not subsumed by C15-v2.

## Rollback

If the gate breaks the legitimate flow for any user segment:
1. Revert the PR (single squash commit).
2. The previous auto-fire useEffect is restored; URL retention reverts to
   immediate-removal.
3. No DB migration to undo. No schema change. No server-side change.
4. Extension content script reverts on the next extension build/publish.
