# Manual Test Plan — Extension JKT Trust Path Rewrite

R35 Tier-2 (auth-flow / cryptographic-material change). Execute manually
against a fresh build before merging this PR. Plan reference:
[`extension-jkt-trust-path-plan.md`](./extension-jkt-trust-path-plan.md).

The flow under test is the SW-initiated bridge-code handshake (C2/C4/C5/C6/C7/C9):
the web app posts EXT_CONNECT_REQUEST → content script forwards to SW →
SW signs DPoP → SW POSTs `/api/extension/bridge-code` (credentialed) →
SW POSTs `/api/extension/token/exchange` (no credentials) → SW persists
the token in its own heap.

## Pre-conditions

Substitute `<test-user-email>` with a real local account; `<chrome-ext-id>`
with the 32-character ID of your locally-loaded chrome extension build.

- Local dev stack running: `npm run docker:up` brings up `app`, `db`,
  `jackson`, `redis`, `migrate`, `audit-outbox-worker`, `mailpit`.
- Web app reachable at `http://localhost:3000`.
- Chrome extension freshly built from `extension/` (`pnpm build` then
  load-unpacked from `extension/dist/`).
- Browser profile signed in as `<test-user-email>` with vault unlocked.
- `.env` has `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS=chrome-extension://<chrome-ext-id>`
  (or a comma-separated list including it).
- DPoP IDB key present in the SW: visit Options → "Reset extension key" if
  unsure — that regenerates the key and clears any persisted token.

## Steps (happy path)

1. From a signed-in tab, navigate to `http://localhost:3000/en/dashboard?ext_connect=1`.
2. The page replaces the URL to remove `ext_connect=1` and shows the
   "connecting" overlay.
3. Within ~2 seconds the overlay transitions to "connected" with the
   "Go to dashboard" button.
4. Open `chrome://extensions` → "Inspect views: service worker" for the
   extension. In the SW devtools, open Application → Storage → Session →
   `authState`. Confirm a token entry exists with `tokenCnfJkt` set to a
   43-character base64url string.
5. Query the DB:
   ```bash
   docker compose exec db psql -U passwd_user -d passwd_sso -c \
     "SELECT cnf_jkt FROM extension_bridge_codes ORDER BY created_at DESC LIMIT 1;"
   ```
   The `cnf_jkt` value MUST equal the `tokenCnfJkt` observed in step 4.
   (This proves the verifier-derived thumbprint is what got persisted —
   not anything the page or content script supplied.)
6. Confirm the corresponding `extension_tokens` row also carries the same
   thumbprint:
   ```bash
   docker compose exec db psql -U passwd_user -d passwd_sso -c \
     "SELECT cnf_jkt FROM extension_tokens ORDER BY created_at DESC LIMIT 1;"
   ```
7. Browse to a known logged-in site, observe the extension badge shows
   match count + autofill works. This verifies the issued token is
   functional end-to-end (token + DPoP both valid).

## Expected result

- `extension_bridge_codes.cnf_jkt` (step 5) ==
  `extension_tokens.cnf_jkt` (step 6) ==
  SW's `authState.tokenCnfJkt` (step 4). All three must be the SAME
  43-char base64url string.
- The web app's DevTools network panel MUST NOT show `/api/extension/bridge-code`
  or `/api/extension/token/exchange` requests originating from
  `http://localhost:3000` — the SW issues them with `Origin: chrome-extension://...`.
- The bridge-code response body in the SW devtools network panel contains
  `{ code, expiresAt }` but NO `cnfJkt` field anywhere in the wire payload.

## Rollback

1. `git revert <merge-commit>` on `main`.
2. Redeploy the server.
3. Existing PENDING `extension_bridge_codes` rows expire naturally within
   `BRIDGE_CODE_TTL_MS` (60s). No DB schema migration to undo.
4. Inform users to re-load the extension; new flow's "EXTENSION_ABSENT"
   error surfaces if the old server can't speak the new wire shape.

## Adversarial scenarios (Tier-2 required)

### A1 — Page-script can't bind a code to its own key

1. From the same signed-in tab's DevTools console, run:
   ```js
   window.postMessage({ type: "PASSWD_SSO_EXT_CONNECT_REQUEST", reqId: "x" }, "*");
   ```
2. Observe a new `extension_bridge_codes` row appears in the DB.
3. Read its `cnf_jkt`:
   ```bash
   docker compose exec db psql -U passwd_user -d passwd_sso -c \
     "SELECT cnf_jkt FROM extension_bridge_codes ORDER BY created_at DESC LIMIT 1;"
   ```
4. Read the SW's `tokenCnfJkt` from `chrome.storage.session` (SW devtools
   Application panel).

**Expected**: DB cnf_jkt == SW tokenCnfJkt. The page cannot influence the
bound key — the SW always signs with its IDB-resident DPoP key, and the
server derives `cnf_jkt` from `verifyDpopProof().jkt`, never from the
body. Confirms the body-spoofing gap is closed.

### A2 — Origin allowlist enforcement

1. Edit `.env`: change `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` to a
   different 32-char chrome extension ID (NOT the local build's ID).
2. Restart the dev server. Retry the connect flow.

**Expected**: bridge-code POST returns 403 with body `{ "error": "FORBIDDEN" }`.
The SW's startConnect returns `{ ok: false, errorCode: "GENERIC_FAILURE" }`;
the page shows the "connect failed — retry" UI. NO `extension_bridge_codes`
row is created (confirm via the SELECT in step 5 of happy path).

### A3 — Stolen-bridge-code with attacker DPoP

1. Run the happy path through step 5 to obtain a fresh `extension_bridge_codes.code_hash`.
   Retrieve the plaintext bridge code from the SW's startConnect call —
   set a breakpoint on the exchange fetch in token-handler.ts to read it
   before the exchange runs. (Alternatively, mint a code by running
   step 1-2 of the happy path, then leave the page open so the code
   stays PENDING.)
2. From a separate machine (or another extension with a different DPoP
   key), POST to the exchange endpoint with the stolen code:
   ```bash
   curl -X POST http://localhost:3000/api/extension/token/exchange \
     -H "Content-Type: application/json" \
     -H "DPoP: <attacker-signed-dpop-proof>" \
     -d '{"code":"<stolen-bridge-code>"}'
   ```
3. Observe the response.

**Expected**: 401 with `{ "error": "UNAUTHORIZED" }`. Most critically,
`SELECT used_at FROM extension_bridge_codes WHERE code_hash=<sha256(stolen)>`
MUST still be NULL (the code is NOT consumed). The legitimate caller
can then complete their exchange afterwards. This proves C5's SELECT-then-CAS
reorder closed the DoS-via-consumption window.

### A4 — Fail-closed on missing env var

1. Comment out the `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` line in `.env`
   entirely.
2. Restart the dev server. Retry the connect flow.

**Expected**: bridge-code POST returns 403. No row inserted into
`extension_bridge_codes`. Server logs warn about empty allowlist. This
proves the env-var-unset case is fail-closed (no implicit allow-all).

### A5 — Mid-flow browser restart

1. Start the connect flow (happy path step 1).
2. Set a breakpoint in token-handler.ts at the line between the
   bridge-code response handling and the exchange fetch.
3. When the breakpoint hits, the bridge code is issued but not yet
   exchanged. Quit the browser entirely (do not just close the tab).
4. Reopen the browser. The dashboard reloads with `?ext_connect=1` already
   removed from the URL.

**Expected**:
- The bridge code expires naturally within 60s (`BRIDGE_CODE_TTL_MS`)
  with `used_at` still NULL — visible in the DB.
- The user is in the IDLE state (no overlay) because `?ext_connect=1`
  was stripped on the first load.
- Manually navigating to `?ext_connect=1` again starts a fresh flow that
  succeeds. No partial-state corruption.
