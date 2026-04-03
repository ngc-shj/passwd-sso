# Extension Token Bridge Architecture

This document describes how the browser extension authenticates with the
web application and maintains a secure session.

---

## Overview

The extension connects to the web app via a short-lived Bearer token
(15-minute TTL). The token is delivered from the web app to the extension
through a `postMessage` bridge — the web app's JavaScript sends the token
via `window.postMessage`, and an ISOLATED-world content script receives it
and forwards it to the background service worker.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser Tab (web app page)                                         │
│                                                                    │
│  ┌──────────────────────┐     window.postMessage      ┌──────────┐ │
│  │ Web App JS           │ ──────────────────────────▶  │ Content  │ │
│  │ (MAIN world)         │  {type, token, expiresAt}    │ Script   │ │
│  │                      │  targetOrigin: same-origin   │ (ISOLATED│ │
│  │ injectExtensionToken │                              │  world)  │ │
│  └──────────────────────┘                              └────┬─────┘ │
│                                                             │       │
└─────────────────────────────────────────────────────────────┼───────┘
                                                              │
                                          chrome.runtime.sendMessage
                                            {type: "SET_TOKEN"}
                                                              │
                                                              ▼
                                                   ┌──────────────────┐
                                                   │ Background       │
                                                   │ Service Worker   │
                                                   │                  │
                                                   │ • stores token   │
                                                   │ • schedules      │
                                                   │   refresh alarm  │
                                                   │ • persists to    │
                                                   │   encrypted      │
                                                   │   session storage│
                                                   └──────────────────┘
```

## Connection Flow

```
User                Extension Popup         Web App              API Server
 │                       │                    │                      │
 ├─ click "Connect" ────▶│                    │                      │
 │                       ├─ open tab ────────▶│                      │
 │                       │  ?ext_connect=1    │                      │
 │                       │                    │                      │
 ├─ login ──────────────────────────────────▶ │                      │
 │                       │                    │                      │
 │                       │                    ├─ POST /api/extension/token ─▶│
 │                       │                    │◀─ {token, expiresAt} ────────│
 │                       │                    │                      │
 │                       │         ◀──────────┤                      │
 │                       │  window.postMessage│                      │
 │                       │  (PASSWD_SSO_      │                      │
 │                       │   TOKEN_RELAY)     │                      │
 │                       │                    │                      │
 │               content script               │                      │
 │               validates:                   │                      │
 │               • event.source === window    │                      │
 │               • event.origin match         │                      │
 │               • event.data.type match      │                      │
 │                       │                    │                      │
 │               background receives          │                      │
 │               SET_TOKEN message             │                      │
 │                       │                    │                      │
 │               ┌───────┴───────┐            │                      │
 │               │ store token   │            │                      │
 │               │ encrypt &     │            │                      │
 │               │ persist to    │            │                      │
 │               │ session store │            │                      │
 │               │ schedule      │            │                      │
 │               │ refresh alarm │            │                      │
 │               └───────┬───────┘            │                      │
 │                       │                    │                      │
 │  "Connected" badge ◀──┤                    │                      │
 │                       │                    │  "Connected" UI      │
 │  ◀─────────────────────────────────────────┤                      │
```

## Token Lifecycle

| Phase | Mechanism | TTL |
|-------|-----------|-----|
| **Issue** | `POST /api/extension/token` (requires Auth.js session) | 15 min |
| **Delivery** | `window.postMessage` → content script → background | instant |
| **Storage** | Encrypted with ephemeral AES-256-GCM key in `chrome.storage.session` | until browser close |
| **Refresh** | `POST /api/extension/token/refresh` (Bearer + session) | 15 min (new token) |
| **Refresh trigger** | `ALARM_TOKEN_REFRESH` fires 2 min before expiry | — |
| **Revocation** | `DELETE /api/extension/token` or token expiry | — |
| **SW restart** | Ephemeral key lost → token unreadable → re-auth required | — |

## Session Storage Encryption

Sensitive fields (`token`, `vaultSecretKey`) are encrypted before persisting
to `chrome.storage.session`:

```
┌─────────────────────┐
│ In-memory            │
│ (service worker)     │
│                      │
│ ephemeralKey         │──── AES-256-GCM, non-extractable
│ (CryptoKey)          │     generated on SW startup
│                      │     lost on SW termination
└─────────┬───────────┘
          │ encrypt
          ▼
┌─────────────────────┐
│ chrome.storage       │
│ .session             │
│                      │
│ encryptedToken:      │ ← {ciphertext, iv, authTag} (hex)
│   {ct, iv, tag}      │
│ encryptedVaultKey:   │ ← {ciphertext, iv, authTag} (hex)
│   {ct, iv, tag}      │
│ expiresAt: number    │ ← plaintext (not sensitive)
│ userId: string       │ ← plaintext (not sensitive)
│ ecdhEncrypted:       │ ← already encrypted by vault key
│   {ct, iv, tag}      │
└──────────────────────┘
```

On service worker restart:
1. `hydrateFromSession()` loads encrypted blobs
2. Attempts decryption with ephemeral key — **key is gone** → returns `null`
3. Token cleared, vault locked → user must reconnect and re-enter passphrase

## Content Script Registration

The content script (`token-bridge.js`) is **dynamically registered** by the
background service worker using `chrome.scripting.registerContentScripts`:

- Registered for the configured server URL origin only (not all sites)
- Runs at `document_start` in ISOLATED world
- Persists across service worker restarts (`persistAcrossSessions: true`)
- File is included in `web_accessible_resources` for CRXJS bundling

## Validation Checks

The content script performs three checks before forwarding:

| Check | Purpose | Failure mode |
|-------|---------|-------------|
| `event.source === window` | Reject messages from child iframes | Silent drop |
| `event.origin === window.location.origin` | Reject cross-origin messages | Silent drop |
| `event.data.type === "PASSWD_SSO_TOKEN_RELAY"` | Reject unrelated postMessage traffic | Silent drop |

All rejections are silent (no error response) to prevent oracle attacks.

## Threat Model

The `postMessage` approach eliminates the 10-second DOM attribute exposure
of the old hidden-`<div>` injection. However, it does **not** mitigate
MAIN-world-level attackers (e.g., supply-chain-compromised npm packages)
who can call `window.addEventListener("message", ...)` to intercept the token.

This is a **defense-in-depth improvement** — the full mitigation would require
a one-time-code + PKCE exchange (tracked as a future enhancement).

| Attack vector | Old (DOM injection) | New (postMessage) |
|--------------|-------------------|------------------|
| DOM query (`getElementById`) | 10-sec window | Not applicable |
| MutationObserver | 10-sec window | Not applicable |
| postMessage listener | Not applicable | Single event cycle |
| MAIN-world event listener | Not applicable | Single event cycle |
| DevTools / memory forensics | DOM + memory | Memory only |

## File Map

| File | Role |
|------|------|
| `src/lib/inject-extension-token.ts` | Web app: dispatches `postMessage` with token |
| `src/lib/constants/extension.ts` | Shared constants: `TOKEN_BRIDGE_MSG_TYPE` |
| `extension/src/content/token-bridge.js` | Content script (ISOLATED): receives postMessage, forwards to background |
| `extension/src/content/token-bridge-lib.ts` | TypeScript version of content script (for tests) |
| `extension/src/lib/constants.ts` | Extension constants (mirrors web app constants) |
| `extension/src/lib/session-crypto.ts` | Ephemeral AES-256-GCM key for session encryption |
| `extension/src/lib/session-storage.ts` | Encrypted persist/load for `chrome.storage.session` |
| `extension/src/background/index.ts` | Background SW: token state, refresh, dynamic script registration |
