# Plan: harden-extension-token-bridge

## Objective

Address the 5 security concerns identified in the static security review, prioritized by risk severity. The goal is to eliminate residual risks in the extension token bridge, vault secret key persistence, audit log durability, RLS bypass management, and HKDF salt documentation — while preserving existing UX and backward compatibility.

## Requirements

### Functional Requirements

1. Extension token delivery must not expose Bearer tokens in the DOM
2. Vault secret key must not persist as plaintext hex in `chrome.storage.session`
3. Audit log writes must have a durability guarantee beyond fire-and-forget
4. RLS bypass call sites must be categorized by purpose with enforceable constraints
5. HKDF zero-salt design decision must be formally documented with versioning strategy

### Non-Functional Requirements

- No breaking changes to existing extension ↔ web app authentication flow
- No user-facing UX regression (vault unlock speed, extension autofill latency)
- All changes must pass `npx vitest run` and `npx next build`
- Extension Manifest V3 compatibility must be maintained

## Technical Approach

### Concern 1: DOM-based Extension Token Injection (High Priority)

**Current state:**
- `src/lib/inject-extension-token.ts` creates a hidden `<div>` with `data-token` and `data-expires-at` attributes
- Content script (`extension/src/content/token-bridge-lib.ts`) reads via `MutationObserver` + custom event
- Element auto-removed after 10 seconds
- CSP is strong (`strict-dynamic` + nonce), mitigating XSS-based extraction

**Risk:** Any same-origin JS (supply chain compromise, compromised dependency) can read the token from DOM during the 10-second window. The leaked value is a valid Bearer token.

**Proposed fix: Replace DOM injection with `chrome.runtime.sendMessage` from an injected world script**

This approach leverages the existing content script infrastructure but eliminates DOM exposure:

1. Web app calls `POST /api/extension/token` as before
2. Instead of DOM injection, web app dispatches a `CustomEvent` with token data to the page
3. Content script (running in isolated world) cannot directly read page JS events — so we use a **relay script injected as `world: "MAIN"`** via `chrome.scripting.registerContentScripts`
4. The relay script listens for the CustomEvent on the page, then uses `window.postMessage` to the content script
5. Content script validates the message origin and forwards to background via `chrome.runtime.sendMessage`

**postMessage origin validation specification (Critical):**
The content script (ISOLATED world) must validate incoming `message` events as follows:
- `event.source === window` — ensures the message comes from the same frame, not a child iframe
- `event.origin === expectedOrigin` — where `expectedOrigin` is the web app's origin read from `extension/src/lib/constants.ts` (e.g., `https://app.example.com`). In dev mode, also allow `http://localhost:3000`
- `event.data.type === "PASSWD_SSO_TOKEN_RELAY"` — typed message discriminator to prevent collision with other postMessage traffic
- Reject any message failing any of these checks silently (no error response — prevents oracle)

**Manifest permissions (already present):**
- `"scripting"` permission: Already in `extension/manifest.config.ts` line 16
- `"optional_host_permissions"`: Already covers `"https://*/*"` and `"http://localhost/*"`
- For MAIN world content script registration via manifest (static), add to `content_scripts` array with `"world": "MAIN"`. Alternatively, use `chrome.scripting.registerContentScripts()` at runtime (already have `scripting` permission)

**Alternative considered and rejected:**
- `chrome.runtime.sendMessage` directly from web page: Requires `"externally_connectable"` manifest entry, which exposes a messaging channel to any page matching the pattern. This is a larger attack surface than the current DOM approach.
- One-time code + PKCE exchange: Significant complexity increase. The extension would need to initiate an OAuth-like flow with its own redirect. Deferred to a future phase.

**Threat model clarification (review round 1 fix — S-01, round 2 fix — S-05):**
The CustomEvent `detail` is readable by **all JS in the MAIN world**, not just the relay script. This means a supply-chain-compromised dependency could `addEventListener` for the event and read the token. The same MAIN-world attacker can also intercept the `window.postMessage` call from the relay script, since `postMessage` on the same window is readable by all MAIN-world listeners before the isolated-world content script receives it. Both hops (CustomEvent → postMessage) are vulnerable to the **same threat actor class** as the current DOM injection. The improvement is narrower than originally stated:
- Token **no longer persists in the DOM** (no `data-*` attribute readable at any time by `document.getElementById`)
- Token exposure is reduced from a **10-second DOM window** to a **single synchronous event dispatch** (microseconds)
- The attack requires pre-registering a listener for the exact event name, vs. simply polling the DOM

This is a **defense-in-depth improvement**, not a complete mitigation against MAIN-world-level attackers. Full mitigation requires a nonce-based exchange (deferred to future phase with one-time code + PKCE).

**Why this is better than DOM injection:**
- Token never appears as a DOM attribute readable by `document.getElementById` at arbitrary times
- Token exposure is reduced from 10-second DOM persistence to a single synchronous event dispatch
- The relay script runs in MAIN world but immediately forwards via `postMessage` — no persistent storage
- Content script validates origin before forwarding
- Attack requires pre-planted event listener (proactive) vs. DOM polling (reactive, easier)

**Files to modify:**
- `src/lib/inject-extension-token.ts` — Replace DOM injection with CustomEvent dispatch
- `src/lib/constants/extension.ts` — Add new event name constant, remove `TOKEN_ELEMENT_ID` export
- `src/lib/constants/index.ts` — Update re-export (line 38)
- `extension/src/content/token-bridge-lib.ts` — Replace MutationObserver with postMessage listener + origin validation
- `extension/src/content/token-bridge.js` — Update plain JS version to match
- `extension/src/lib/constants.ts` — Mirror new constant, remove `TOKEN_ELEMENT_ID`
- `extension/manifest.config.ts` — Add MAIN world content script entry (or use runtime registration)
- Tests (all TOKEN_ELEMENT_ID references):
  - `extension/src/__tests__/content/token-bridge-js-sync.test.ts` — Rewrite for postMessage flow
  - `extension/src/__tests__/content/token-bridge.test.ts` — Rewrite for postMessage flow
  - `src/lib/inject-extension-token.test.ts` — Rewrite for CustomEvent dispatch
- **Regression test**: Assert `document.getElementById('passwd-sso-ext-token')` returns `null` after token delivery (verify DOM element is never created)

**Relay script build & deployment (review round 1 fix — F-03):**
- Relay script source: `extension/src/content/token-bridge-relay.ts` (TypeScript, compiled by CRXJS/Vite)
- Plain JS fallback: `extension/src/content/token-bridge-relay.js` (hand-synced, for `web_accessible_resources` if CRXJS cannot handle MAIN world scripts)
- Register as MAIN world content script in `extension/manifest.config.ts` under `content_scripts` with `"world": "MAIN"` and `matches` matching the web app origin
- **Remove** old `token-bridge.js` from `web_accessible_resources` — it is no longer needed as the relay script replaces its function
- Sync test: `extension/src/__tests__/content/token-bridge-relay-js-sync.test.ts` — verifies that the relay script's `.js` version contains the same constant values as the `.ts` version. Specifically: the CustomEvent name constant and the `PASSWD_SSO_TOKEN_RELAY` message type discriminator must match `extension/src/lib/constants.ts` definitions

### Concern 2: `vaultSecretKey` in `chrome.storage.session` (High Priority)

**Current state:**
- After vault unlock, `currentVaultSecretKeyHex` (hex string of 256-bit secret key) is persisted to `chrome.storage.session` via `persistState()`
- On service worker restart, `hydrateFromSession()` reads it back and re-derives `encryptionKey`
- `TRUSTED_CONTEXTS` access level is set (limits to extension contexts only)
- `clearVault()` zeros in-memory `ecdhPrivateKeyBytes` but not the hex string

**Risk:** The vault secret key — the root of all encryption — sits as a plaintext hex string in Chrome's session storage. While `chrome.storage.session` is not persistent across browser restarts and `TRUSTED_CONTEXTS` limits access, the key is recoverable by any code running in the extension's trusted context, and potentially extractable via memory forensics or browser debugging.

**Proposed fix: Encrypt `vaultSecretKey` before persisting, using a session-ephemeral wrapping key**

1. On extension startup (service worker init), generate an ephemeral AES-256-GCM wrapping key via `crypto.subtle.generateKey()` with `extractable: false`
2. Store the `CryptoKey` handle in an in-memory module variable (lost on SW termination — this is acceptable because SW restart triggers re-hydration from storage)
3. Before persisting to `chrome.storage.session`, encrypt **both `vaultSecretKeyHex` and `token`** (Bearer token) with the ephemeral key → store `{ ciphertext, iv, authTag }` instead of plaintext for each (review round 1 fix — S-02: Bearer token has higher immediate attack value than vault key, so must also be encrypted)
4. On `hydrateFromSession()`, decrypt using the in-memory ephemeral key
5. If the ephemeral key is lost (SW was terminated and restarted), the encrypted blobs are unreadable → token is cleared, vault is locked, user must re-authenticate and re-enter passphrase

**Trade-off:** This means service worker restart = vault re-lock. Currently, SW restart preserves vault unlock state. This is a UX regression.

**Mitigation for UX regression:**
- Chrome Manifest V3 keeps service workers alive while the extension popup is open and during active alarm handling
- The existing `ALARM_TOKEN_REFRESH` (fires every ~13 minutes) keeps the SW alive
- In practice, SW termination only happens after extended inactivity — at which point auto-lock would have triggered anyway (default auto-lock is configurable)
- **Keepalive heartbeat (review round 1 fix — F-04)**: Chrome MV3 `chrome.alarms` API has a minimum interval of 1 minute, so a 25-second alarm is silently clamped. Instead, use an **offscreen document** (`chrome.offscreen.createDocument()` with reason `"WORKERS"`) that sends a periodic `chrome.runtime.sendMessage` ping every 25 seconds. The offscreen document is created when vault is unlocked and closed on vault lock or token clear. This keeps the service worker alive within Chrome's 30-second idle timeout. Requires `"offscreen"` permission in manifest (add to permissions array)
- Add a user-facing setting: "High security mode" (default on) vs "Convenience mode" (plaintext session persistence, current behavior) — **deferred to future PR** to keep this change focused

**Additional fix: Zero `currentVaultSecretKeyHex` on `clearVault()`:**
Currently `clearVault()` sets `currentVaultSecretKeyHex = null` but does not zero the string content. Since JS strings are immutable, explicit zeroing is impossible. However, we should:
- Ensure the hex string variable is reassigned to `null` as early as possible (already done)
- Consider storing the secret key as `Uint8Array` instead of hex string in memory, so it can be `.fill(0)` zeroed (defense-in-depth)

**Hydration sequence (review round 2 fix — N-01):**
`ecdhEncrypted` continues to use its existing wrapping scheme (wrapped under a key derived from `vaultSecretKey`). The ephemeral wrapping key only covers `token` and `vaultSecretKey`. `hydrateFromSession()` must follow this exact order:
1. Attempt ephemeral-key decryption of `token` → if fail, clear session (force re-auth)
2. Attempt ephemeral-key decryption of `vaultSecretKey` → if fail, lock vault (token may still be valid)
3. Use decrypted `vaultSecretKey` to unwrap `ecdhEncrypted` → if fail, ECDH features unavailable (silent)

**Error path specification for `session-crypto.ts` (review round 2 fix — T-08):**
- `decryptField(ephemeralKey, encryptedBlob)` returns `string | null`
- On success: returns decrypted plaintext string
- On failure (key lost, blob corrupted, `DOMException` from `crypto.subtle.decrypt`): catches all exceptions, returns `null`
- Callers check for `null` to decide lock/clear behavior — no exceptions propagate

**Files to modify:**
- `extension/src/lib/session-storage.ts` — Change both `vaultSecretKey` and `token` field types to `{ ciphertext: string; iv: string; authTag: string }` when encrypted, add encrypt/decrypt wrappers. Add backward-compat: if `loadSession()` encounters old plaintext format (string instead of encrypted object), return `null` (force re-auth). **All existing tests (9 cases) that use plaintext `token: "tok-1"` must be rewritten** to use the encrypted blob format (review round 2 fix — T-04a)
- `extension/src/lib/session-crypto.ts` — **New file**: ephemeral key generation (`generateEphemeralKey()`), `encryptField(key, plaintext) → EncryptedBlob`, `decryptField(key, blob) → string | null` (catches all crypto exceptions, returns null on failure)
- `extension/src/background/index.ts` — Update `persistState()` to encrypt both token and vaultSecretKey; `hydrateFromSession()` to follow the 3-step sequence above; change `currentVaultSecretKeyHex` from `string` to `Uint8Array` for zeroing; replace alarm-based keepalive with offscreen document; **add `chrome.offscreen.hasDocument()` guard before `createDocument()`** to prevent duplicate creation errors on rapid lock/unlock cycles (review round 2 fix — F-05)
- `extension/src/background/offscreen-keepalive.ts` — **New file**: offscreen document that sends periodic ping messages
- `extension/src/offscreen.html` — **New file**: minimal offscreen document HTML
- `extension/manifest.config.ts` — Add `"offscreen"` to permissions
- Tests:
  - `extension/src/__tests__/lib/session-storage.test.ts` — Update for encrypted blob format; add backward-compat tests (old plaintext → null, correct encrypted → pass, malformed → null)
  - `extension/src/__tests__/lib/session-crypto.test.ts` — **New**: ephemeral key encrypt/decrypt round-trip, key-loss → null return
  - `extension/src/__tests__/background.test.ts` — Update mock session state expectations for encrypted format; test offscreen document creation on vault unlock and close on vault lock

### Concern 3: Audit Log Durability (High Priority)

**Current state:**
- `logAudit()` in `src/lib/audit.ts` is async non-blocking: `void (async () => { ... })().catch(err => logger.error(...))`
- DB write failure is silently caught — the HTTP response has already been sent
- Dual-write to stdout via pino (for Fluent Bit forwarding) has its own try/catch that also silently swallows
- `logAuditBatch()` follows the same pattern

**Risk:** Under DB pressure, network partition, or Prisma connection pool exhaustion, audit entries are silently lost. For a security product, this creates gaps in the audit trail that may violate compliance requirements.

**Proposed fix: Add a lightweight retry queue with dead-letter logging**

Rather than a full transactional outbox (which would require schema changes and a background worker), implement:

1. **In-memory retry buffer** (bounded, e.g., 100 entries max) in `src/lib/audit-retry.ts`
2. On `logAudit()` DB write failure, push the entry to the retry buffer instead of silently dropping
3. **Piggyback flush (review round 1 fix — F-01, round 2 fix — F-06)**: Instead of `setInterval` (which doesn't persist across serverless invocations in Next.js App Router), flush is triggered by the next `logAudit()` call. On each `logAudit()` invocation, **fire-and-forget** drain of up to 10 buffered entries: `void drainBuffer().catch(...)`. The drain runs in parallel with the new entry's DB write — no sequential blocking, no route handler latency impact. This ensures retry occurs proportionally to system activity — high traffic = fast retry, low traffic = slow retry (acceptable because low traffic = low audit urgency)
4. If an entry fails 3 times, write it to a **dead-letter log** (structured JSON via pino to a separate log file/stream) and emit a metric/alert
5. On graceful shutdown (`process.on('beforeExit')`, if applicable), attempt to flush remaining buffer entries
6. **Webhook dispatch on retry (review round 1 fix — S-03)**: Retry path performs **DB write only**, without webhook dispatch. Rationale: the original `logAudit()` call already attempted webhook dispatch (which may have succeeded even if DB write failed). Duplicate dispatch is worse than missing dispatch for retry entries. If webhook dispatch also failed, the dead-letter log captures the entry for manual reprocessing

**Why not transactional outbox:**
- Requires new DB table, migration, and a background worker
- Overkill for current scale — the in-memory buffer handles transient failures
- Transactional outbox can be added later if compliance requirements mandate it

**Note on existing retry patterns:** `src/lib/webhook-dispatcher.ts` has `deliverWithRetry()` (exponential backoff, 3 retries at 1s/5s/25s) but it is webhook-specific (takes URL/payload/signature). The audit retry needs a different pattern (DB write retry with buffering), so a dedicated module is justified rather than forcing reuse of the webhook retry.

**Scope limitation:** This addresses transient DB failures. For true durability guarantees (process crash during retry), a durable queue (Redis, SQS) or transactional outbox is needed — documented as a future enhancement.

**Files to modify:**
- `src/lib/audit-retry.ts` — **New file**: retry buffer (bounded FIFO queue, max 100 entries — when full, **drop oldest** entry to dead-letter and enqueue new one; exponential backoff 1s/5s/25s, max 3 retries per entry) (review round 2 fix — T-09: explicitly drop-oldest, not drop-newest)
- `src/lib/audit.ts` — Integrate retry on DB write failure in both `logAudit()` and `logAuditBatch()`
- `src/lib/audit-logger.ts` — Add dead-letter log destination (separate pino child logger)
- Tests: `src/__tests__/lib/audit-retry.test.ts` (new), update `src/__tests__/lib/audit.test.ts`

### Concern 4: RLS Bypass Categorization (Medium Priority)

**Current state:**
- `withBypassRls()` in `src/lib/tenant-rls.ts` is a single generic function
- 139 call sites across 55 files
- No systematic categorization of why bypass is needed
- CI guard exists but doesn't distinguish bypass purposes

**Risk:** A single bypass function for all purposes means a code review can't quickly assess whether a specific bypass is justified. An accidental bypass in the wrong context could leak data across tenants.

**Proposed fix: Create purpose-typed bypass wrappers**

1. Define bypass purpose categories as a union type:
   - `"auth_flow"` — Auth.js callbacks with no tenant context
   - `"cross_tenant_lookup"` — Emergency access, share links, delegation
   - `"system_maintenance"` — Purge history, key rotation, DCR cleanup
   - `"audit_write"` — Audit log tenant resolution
   - `"webhook_dispatch"` — Webhook delivery across tenants
   - `"token_lifecycle"` — Token creation/revocation
2. Add a `purpose` parameter to `withBypassRls()` that is logged (not enforced at runtime initially)
3. Add `SET_CONFIG('app.bypass_purpose', ..., true)` alongside the existing bypass flag — **must be transaction-local** (third arg `true`, matching existing `app.bypass_rls` and `app.tenant_id` pattern). Session-scoped (`false`) is prohibited to prevent connection pool leakage across requests (review round 1 fix — S-04)
4. **Extend existing `scripts/check-bypass-rls.mjs`** (review round 2 fix — T-07a) to also verify that every `withBypassRls` call includes a valid `BypassPurpose` argument. This avoids creating a duplicate CI check. The `purpose` parameter is also TypeScript-required (3rd arg), so `npx next build` catches missing arguments at compile time — the CI check provides an additional grep-level guard for completeness
5. **Future phase**: Enforce purpose-based restrictions (e.g., `auth_flow` bypass cannot write to `PasswordEntry`)

**Signature change impact:**
- 139 call sites across 55 source files must add `purpose` argument
- **79 test files** mock `withBypassRls` via `vi.mock("@/lib/tenant-rls")`. The mock factory must accept the new `purpose` parameter. Since most mocks use `mockImplementation((_, fn) => fn())` pattern, adding a third parameter is backward-compatible if `purpose` is the last argument. However, any mock that uses positional argument destructuring will need updating
- `src/lib/tenant-rls.test.ts` has direct unit tests for `withBypassRls` that must verify purpose logging

**Files to modify:**
- `src/lib/tenant-rls.ts` — Add `BypassPurpose` type, add `purpose` parameter (3rd arg, required), log purpose via `SET_CONFIG`
- All 55 source files with `withBypassRls` calls — Add purpose argument (mechanical change, categorize each call)
- 79 test files mocking `withBypassRls` — Update mock signatures if needed (most should be compatible)
- `.github/workflows/` or `scripts/` — Add CI check for missing purpose
- Tests: Update `src/lib/tenant-rls.test.ts`

### Concern 5: HKDF Zero-Salt Documentation (Low Priority)

**Current state:**
- `src/lib/crypto-client.ts` lines 213-218 and 247: `salt: new ArrayBuffer(32)` with inline comment explaining RFC 5869 §3.1 rationale
- No external documentation or threat model document
- No versioning mechanism for future salt changes

**Risk:** Not a vulnerability, but a recurring audit finding. Lack of external documentation means every new reviewer will question the same decision.

**Proposed fix: Document in security whitepaper and add crypto version header**

1. Add `docs/security/crypto-design.md` documenting:
   - Key hierarchy (passphrase → PBKDF2 → wrapping key → secret key → HKDF → enc/auth keys)
   - HKDF zero-salt rationale with RFC 5869 §3.1 citation
   - Domain separation via `info` parameter
   - Future migration path if salt is added
2. Add `aadVersion` field (already exists as `aadVersion` in encrypted blobs) documentation
3. Ensure `HKDF_ENC_INFO` version suffix (`-v1`) is documented as the migration hook

**Files to modify:**
- `docs/security/crypto-design.md` — **New file**: cryptographic design document
- `src/lib/crypto-client.ts` — Add reference comment pointing to the design doc

## Implementation Steps

**Implementation order: Concern 4 before Concern 3** (review round 1 fix — F-02: `audit-retry.ts` needs the updated `withBypassRls` signature with `purpose` parameter)

1. **[Concern 5]** Create `docs/security/crypto-design.md` — documentation only, no code risk
2. **[Concern 4]** Add `BypassPurpose` type and update `withBypassRls()` signature
3. **[Concern 4]** Mechanically update all 139 call sites with appropriate purpose
4. **[Concern 4]** Extend `scripts/check-bypass-rls.mjs` to verify purpose argument presence
5. **[Concern 3]** Implement `src/lib/audit-retry.ts` retry buffer with piggyback flush
6. **[Concern 3]** Integrate retry buffer into `logAudit()` and `logAuditBatch()` — use `purpose: "audit_write"` for retry `withBypassRls` calls
7. **[Concern 2]** Implement `extension/src/lib/session-crypto.ts` ephemeral wrapping key
8. **[Concern 2]** Update session persistence to encrypt both token and vaultSecretKey
9. **[Concern 2]** Update background script hydration, clearVault, and offscreen keepalive
10. **[Concern 1]** Create MAIN world relay script (`token-bridge-relay.ts/.js`)
11. **[Concern 1]** Replace DOM injection with CustomEvent dispatch in web app
12. **[Concern 1]** Update content script token bridge to use postMessage + origin validation
13. **[Concern 1]** Update extension manifest: add MAIN world script, remove old `token-bridge.js` from WAR, add `offscreen` permission
14. Run `npx vitest run` and `npx next build`
15. Add new files to `vitest.config.ts` coverage include

## Testing Strategy

### Unit Tests

- **Concern 1 — Token bridge**:
  - `inject-extension-token.test.ts`: CustomEvent dispatch with correct type/detail, no DOM element created
  - `token-bridge.test.ts`: postMessage listener receives relay message → `chrome.runtime.sendMessage` called
  - `token-bridge.test.ts` **negative cases (review round 1 fix — T-02)**: `event.source !== window` → sendMessage NOT called; `event.origin` mismatch → NOT called; `event.data.type` wrong → NOT called. Also verify no error response is sent on invalid messages (oracle prevention, review round 2 fix — T-02a)
  - `token-bridge-relay.test.ts` **(new, review round 1 fix — T-01)**: CustomEvent dispatch → `window.postMessage` called with correct type/detail
  - `token-bridge-relay-js-sync.test.ts` **(new, review round 1 fix — T-01)**: constant values in .js match .ts
  - **Regression**: Assert `document.getElementById('passwd-sso-ext-token')` returns `null`
- **Concern 2 — Session crypto**:
  - `session-crypto.test.ts`: ephemeral key encrypt/decrypt round-trip, key-loss → null return
  - `session-storage.test.ts` **(full rewrite required — review round 2 fix — T-04a)**: All existing 9 test cases that use plaintext `token: "tok-1"` and `vaultSecretKey: "a1b2"` must be updated to use encrypted blob format. Add backward-compat tests: old plaintext format → `loadSession()` returns `null`; correct encrypted → pass; type mismatch in encrypted fields → null
  - `background.test.ts`: UNLOCK_VAULT → offscreen document created; LOCK_VAULT → offscreen document closed. **Mock updates required (review round 2 fix — T-05a)**: add `chrome.offscreen.Reason.WORKERS` to mock (currently only has `CLIPBOARD`); add `chrome.offscreen.closeDocument: vi.fn()` mock; add `chrome.offscreen.hasDocument: vi.fn()` mock
- **Concern 3 — Audit retry**:
  - `audit-retry.test.ts`: enqueue on failure, piggyback dequeue on next logAudit, dead-letter after 3 retries, bounded buffer overflow (101st entry → oldest dropped to dead-letter, new entry enqueued)
  - `audit-retry.test.ts` **piggyback flush (review round 1 fix — T-03)**: mock DB → first logAudit fails → entry buffered → second logAudit succeeds → both new entry and buffered entry written (drain is fire-and-forget, verify via eventual assertion)
  - `audit.test.ts` **(explicit update — review round 2 fix — T-03a)**: Update existing "does not throw when prisma.create rejects" test to additionally verify entry is pushed to retry buffer (not silently lost). This requires importing and spying on the buffer's `enqueue` function
- **Concern 4 — RLS bypass**:
  - `tenant-rls.test.ts`: `withBypassRls` sets `app.bypass_purpose` config with transaction-local scope
  - CI check: extend `scripts/check-bypass-rls.mjs` to verify purpose argument **(review round 2 fix — T-07a)** — reuse existing script infrastructure rather than creating a new grep script. TypeScript compilation (`npx next build`) catches missing arguments at compile time; the CI check is an additional grep-level guard

### Integration Tests

- **Concern 1**: E2E test (manual) — extension connects to web app, token is delivered without DOM element appearing
- **Concern 3**: Simulate DB write failure, verify retry and eventual dead-letter

### Regression Tests

- Extension autofill still works after token bridge changes
- Vault unlock/lock cycle works after session crypto changes
- Audit logs still appear in DB under normal conditions

### Coverage Configuration (review round 1 fix — T-06, round 2 clarification)

Add new files to `vitest.config.ts` `coverage.include`:
- `src/lib/audit-retry.ts`
- Updated `src/lib/audit-logger.ts`
- `src/lib/tenant-rls.ts` (if not already included — new `BypassPurpose` logic)
Extension-side: `extension/vitest.config.ts` currently has no `coverage` section. Adding coverage configuration for extension is **out of scope** for this PR (low priority, tracked as future improvement)

## Considerations & Constraints

### Out of Scope

- Full OAuth PKCE flow for extension authentication (future phase)
- Transactional outbox for audit logs (future phase, requires schema migration)
- User-facing "security mode" toggle for extension (future phase)
- Runtime enforcement of RLS bypass purpose restrictions (future phase)

### Known Risks

1. **Concern 1 (token bridge)**: The MAIN world relay script approach requires careful origin validation. A bug in origin checking could open a new attack vector.
2. **Concern 2 (session crypto)**: Service worker termination now causes vault re-lock. This is a deliberate UX trade-off.
3. **Concern 3 (audit retry)**: In-memory buffer is lost on process restart. This is accepted for current scale.
4. **Concern 4 (RLS bypass)**: Updating 139 call sites is a large mechanical change with risk of merge conflicts.

### Backward Compatibility

- Extension manifest version remains V3
- No changes to token format or API endpoints
- Existing vault data is not affected (no re-encryption needed)
- RLS bypass behavior is unchanged at runtime (purpose is metadata only)

## User Operation Scenarios

### Scenario 1: Extension First-Time Connection
1. User clicks extension icon → opens web app login page with `?ext_connect=1`
2. User logs in via Google/passkey/magic link
3. Web app calls `POST /api/extension/token`, receives Bearer token
4. **New flow**: Web app dispatches CustomEvent with token data
5. MAIN world relay script catches event, posts message to content script
6. Content script validates origin, sends to background via `chrome.runtime.sendMessage`
7. Background stores token, schedules refresh alarm
8. User sees "Connected" badge on extension icon

### Scenario 2: Service Worker Restart (after Concern 2 fix)
1. Chrome terminates idle service worker (offscreen document also closed)
2. Alarm fires (token refresh or vault lock)
3. Service worker restarts, calls `hydrateFromSession()`
4. Ephemeral wrapping key is gone → encrypted `token` and `vaultSecretKey` cannot be decrypted
5. Both token and vault key are cleared → user must re-authenticate and re-enter passphrase
6. Extension shows disconnected badge ("!" icon)
7. User clicks extension → opens web app login flow → full re-connection

### Scenario 3: Transient DB Failure During Audit
1. User performs a password CRUD operation
2. Route handler responds 200 (audit is async)
3. `logAudit()` DB write fails (connection pool exhausted)
4. Entry pushed to retry buffer (DB write params only, no webhook dispatch on retry)
5. Next `logAudit()` call (from any request) triggers piggyback flush → buffered entry retried
6. If retry succeeds → entry written to DB (webhook NOT re-dispatched)
7. If retry fails 3 times → dead-letter log emits structured JSON → alerting picks it up

### Scenario 4: Reviewing RLS Bypass in PR
1. Developer adds new `withBypassRls(prisma, () => ..., "cross_tenant_lookup")` call
2. CI check verifies purpose parameter is present and is a valid `BypassPurpose`
3. Code reviewer can quickly filter: "is cross_tenant_lookup justified here?"
4. DB query: `SELECT * FROM pg_settings WHERE name = 'app.bypass_purpose'` shows audit trail
