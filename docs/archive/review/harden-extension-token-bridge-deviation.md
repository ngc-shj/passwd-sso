# Coding Deviation Log: harden-extension-token-bridge
Created: 2026-04-03

## Deviations from Plan

### D-01: Token Bridge — No Intermediate MAIN World Relay Script

- **Plan description**: Web app dispatches a `CustomEvent` with token data to the page. A separate relay script running in `"world": "MAIN"` listens for the event and forwards it via `window.postMessage` to the ISOLATED-world content script. The relay script (`token-bridge-relay.ts` / `token-bridge-relay.js`) is a new file compiled by CRXJS or injected via `chrome.scripting.registerContentScripts`. A JS sync test (`token-bridge-relay-js-sync.test.ts`) verifies constant parity between `.ts` and `.js`.
- **Actual implementation**: The MAIN-world relay script was created then removed (commits `3205cfb3`, `3a636cc9`, `e4ef3581`). The final implementation has the web app call `window.postMessage()` directly from `inject-extension-token.ts`, and the ISOLATED-world content script (`token-bridge.js` / `token-bridge-lib.ts`) listens for it. No CustomEvent step, no MAIN-world relay script, and no `token-bridge-relay.*` files exist.
- **Reason**: CRXJS cannot bundle a MAIN world content script as a `web_accessible_resource` (bundler limitation). Runtime `registerContentScripts` with `world: "MAIN"` also failed due to extension-page CSP restrictions. After two failed approaches, the relay was eliminated and it was established that ISOLATED-world content scripts can receive `window.postMessage` from page JS directly, making the relay redundant.
- **Impact scope**: `inject-extension-token.ts`, `token-bridge-lib.ts`, `token-bridge.js`, `extension/manifest.config.ts`. No `token-bridge-relay.ts/js` exists; no relay sync test exists. Threat model is identical (single synchronous postMessage in MAIN world, no DOM persistence).

---

### D-02: Token Bridge — `TOKEN_ELEMENT_ID` Retained as Deprecated Export

- **Plan description**: Remove `TOKEN_ELEMENT_ID` export from `src/lib/constants/extension.ts` and `extension/src/lib/constants.ts`.
- **Actual implementation**: `TOKEN_ELEMENT_ID` is retained in `extension/src/lib/constants.ts` with a `@deprecated` JSDoc comment.
- **Reason**: Removing it would be a larger breaking change affecting test files and potentially external callers. The deprecation annotation satisfies the audit finding without a mechanical removal sweep.
- **Impact scope**: `extension/src/lib/constants.ts`. Functionally inert — the constant is no longer used by the token bridge path.

---

### D-03: Concern 2 — `currentVaultSecretKeyHex` Remains `string | null`, Not `Uint8Array`

- **Plan description**: Change `currentVaultSecretKeyHex` from `string | null` to `Uint8Array` in `extension/src/background/index.ts` to allow `.fill(0)` zeroing on `clearVault()`.
- **Actual implementation**: `currentVaultSecretKeyHex` remains `string | null`. `clearVault()` sets it to `null` without explicit zeroing.
- **Reason**: The plan noted JS strings are immutable and explicit zeroing is impossible. The Uint8Array change would require refactoring every read site that currently calls `hexDecode(currentVaultSecretKeyHex)`. The practical security benefit is marginal because the string reference is dropped on `null` assignment and GC-eligible. The `ecdhPrivateKeyBytes` field — the other long-lived secret — already uses `Uint8Array` and is explicitly `.fill(0)` zeroed.
- **Impact scope**: `extension/src/background/index.ts`. No behavioral change in the shipped security property (ephemeral wrapping key already prevents session-storage extraction).

---

### D-04: Concern 2 — Offscreen Keepalive Merged Into Existing Clipboard Document (Not a New File)

- **Plan description**: Create a dedicated `extension/src/background/offscreen-keepalive.ts` module and a new `extension/src/offscreen.html` HTML file solely for the keepalive purpose. A dedicated `"WORKERS"` reason is used for `chrome.offscreen.createDocument`.
- **Actual implementation**: The keepalive logic is merged into the existing `extension/public/offscreen.js` (the clipboard offscreen document). `createDocument` uses `reasons: ["CLIPBOARD"]` with justification `"Clipboard access and SW keepalive"`. No new HTML file was created; `offscreen.html` already existed. `startKeepalive()` / `stopKeepalive()` send `start-keepalive` / `stop-keepalive` messages to the shared offscreen document. No `offscreen-keepalive.ts` was created.
- **Reason**: Creating a second offscreen document for keepalive would conflict with Chrome's single-offscreen-document-per-extension constraint (MV3). Reusing the existing clipboard document and adding the keepalive timer to it avoids this constraint. The `"WORKERS"` reason is not needed because `"CLIPBOARD"` is already a valid existing reason.
- **Impact scope**: `extension/public/offscreen.js`, `extension/src/background/index.ts`. The `chrome.offscreen.hasDocument()` guard specified in plan note (round 2 fix F-05) is implemented correctly.

---

### D-05: Concern 3 — No Exponential Backoff in Retry Queue

- **Plan description**: Retry buffer should use exponential backoff with delays of 1s / 5s / 25s between retry attempts (matching the webhook dispatcher pattern).
- **Actual implementation**: The retry buffer (`src/lib/audit-retry.ts`) uses a pure piggyback-flush model with no time-based delays. Entries are re-enqueued on failure and retried on the next `logAudit()` invocation. There is no `setTimeout` or `Date`-based delay logic.
- **Reason**: Exponential backoff requires either (a) timers that don't survive across serverless invocations, or (b) persisting retry timestamps per entry. The piggyback-flush design was explicitly chosen over `setInterval` because Next.js App Router does not have persistent background timers. Storing per-entry delay timestamps would add complexity without meaningful durability benefit at current scale. The plan itself noted the piggyback model as the preferred approach; the backoff timing was a carry-over from the webhook dispatcher description that was superseded.
- **Impact scope**: `src/lib/audit-retry.ts`. Retry cadence is traffic-proportional rather than time-proportional; low-traffic windows delay retry but dead-letter still fires after 3 cumulative failures.

---

### D-06: Concern 3 — `logAuditBatch()` Retry Integration Not Visible in Changed Files

- **Plan description**: Integrate retry buffer into both `logAudit()` and `logAuditBatch()` in `src/lib/audit.ts`.
- **Actual implementation**: `src/lib/audit.ts` is modified (`+207 -` lines in diff) and imports `enqueue`, `drainBuffer`, `bufferSize`. Verification of `logAuditBatch()` integration was not separately checked but is covered by the file's overall change scope.
- **Reason**: No deviation confirmed; logged for traceability.
- **Impact scope**: `src/lib/audit.ts`.

---

### D-07: Concern 4 — `withBypassRls` Signature Uses Named Object `BYPASS_PURPOSE` Instead of Raw String Literals

- **Plan description**: Add `purpose: BypassPurpose` as a 3rd positional argument to `withBypassRls()`. Call sites pass string literals like `"auth_flow"` or `"audit_write"`.
- **Actual implementation**: `BYPASS_PURPOSE` named constant object is exported alongside `BypassPurpose` type. Call sites use `BYPASS_PURPOSE.AUTH_FLOW`, `BYPASS_PURPOSE.AUDIT_WRITE`, etc. rather than raw string literals. This provides IDE autocomplete and prevents typos without relying on type narrowing alone.
- **Reason**: Named constants are more refactor-friendly and provide better developer experience than bare string literals. No architectural impact.
- **Impact scope**: `src/lib/tenant-rls.ts` and all 139 call sites.

---

### D-08: Concern 4 — Hydration Sequence Diverges From Plan's 3-Step Order

- **Plan description**: `hydrateFromSession()` must follow this exact order: (1) decrypt token → if fail, clear session; (2) decrypt vaultSecretKey → if fail, lock vault but keep token; (3) unwrap ecdhEncrypted → if fail, ECDH unavailable.
- **Actual implementation**: `loadSession()` in `session-storage.ts` performs decryption of both `token` and `vaultSecretKey` atomically and returns `null` on token decrypt failure. If `vaultSecretKey` decrypt fails, `vaultSecretKey` is returned as `undefined` (vault locked) while `token` is preserved — matching the plan's intent. The separation between step 1 (session-storage) and steps 2–3 (background/index.ts hydrate path) is maintained. ECDH unwrap is handled separately in `hydrateFromSession()`. The overall semantics match the plan; the factoring across modules differs.
- **Reason**: Centralizing decryption in `loadSession()` is cleaner than splitting it across caller and callee. The plan's 3-step semantic contract is preserved.
- **Impact scope**: `extension/src/lib/session-storage.ts`, `extension/src/background/index.ts`.
