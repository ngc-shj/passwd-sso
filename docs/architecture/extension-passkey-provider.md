# Extension Passkey Provider Architecture

This document describes how the passwd-sso browser extension intercepts
WebAuthn calls and provides passkey registration and authentication using
credentials stored in the E2E-encrypted vault.

---

## Overview

The extension operates across three worlds:

- **MAIN world** (`webauthn-interceptor.js`): Overrides `navigator.credentials.get/create()` before page JS runs
- **ISOLATED world** (`webauthn-bridge.ts`): Relays postMessage between MAIN world and background
- **Background SW** (`passkey-provider.ts`): Performs key generation, signing, and vault CRUD

```mermaid
flowchart TB
    subgraph Page["Browser Tab (MAIN world)"]
        PageJS["Page JavaScript<br/>navigator.credentials.get/create()"]
        Interceptor["webauthn-interceptor.js<br/>(injected at document_start)"]
        PageJS -- "overridden by" --> Interceptor
    end

    subgraph Isolated["Content Script (ISOLATED world)"]
        Bridge["webauthn-bridge.ts<br/>postMessage ↔ sendMessage relay"]
    end

    subgraph SW["Background Service Worker"]
        Provider["passkey-provider.ts<br/>key gen / signing / vault CRUD"]
        Cache["getCachedEntries()<br/>decrypted overviews"]
    end

    subgraph UI["Extension UI (Shadow DOM)"]
        Dropdown["passkey-dropdown.ts<br/>passkey selection modal"]
        Banner["passkey-save-banner.ts<br/>save / update / cancel banner"]
    end

    Interceptor -- "postMessage<br/>(WEBAUTHN_BRIDGE_MSG)" --> Bridge
    Bridge -- "chrome.runtime.sendMessage" --> Provider
    Provider -- "vault overviews" --> Cache
    Bridge -- "showPasskeyDropdown" --> Dropdown
    Bridge -- "showPasskeySaveBanner" --> Banner
    Bridge -- "postMessage<br/>(WEBAUTHN_BRIDGE_RESP)" --> Interceptor
```

---

## Authentication Flow (get)

```mermaid
sequenceDiagram
    participant Page as Page JS
    participant IX as Interceptor (MAIN)
    participant BR as Bridge (ISOLATED)
    participant SW as Background SW
    participant Vault as E2E Vault

    Page ->> IX: navigator.credentials.get({ allowCredentials })
    IX ->> BR: postMessage PASSKEY_GET_MATCHES { rpId }
    BR ->> SW: sendMessage (+ sender tab URL)
    SW ->> SW: isSenderAuthorizedForRpId(rpId, senderUrl)
    SW ->> Vault: getCachedEntries() → filter by rpId
    SW -->> BR: { entries, vaultLocked }
    BR -->> IX: postMessage WEBAUTHN_BRIDGE_RESP

    IX ->> IX: filter entries by allowCredentials
    Note over IX: empty after filter → origGet() (platform)

    IX ->> BR: postMessage PASSKEY_SELECT { entries }
    BR ->> BR: showPasskeyDropdown
    Note over BR: User selects entry

    IX ->> BR: postMessage PASSKEY_SIGN_ASSERTION { entryId, clientDataJSON }
    BR ->> SW: sendMessage (+ sender tab URL)
    SW ->> SW: validateClientDataJSON(origin, challenge, type)
    SW ->> Vault: GET /api/passwords/:id (full blob)
    SW ->> SW: assert aadVersion >= 1
    SW ->> SW: decryptData → privateKeyJwk, signCount
    SW ->> SW: isSenderAuthorizedForRpId(storedRpId, senderUrl)
    SW ->> SW: signCount += 1, sign assertion (P-256 ECDSA)
    SW ->> Vault: PUT /api/passwords/:id (updated signCount)
    Note over SW: ok:true returned even if PUT fails<br/>(RP validates counter independently)
    SW -->> BR: { ok, credentialId, authenticatorData, signature }
    BR -->> IX: postMessage WEBAUTHN_BRIDGE_RESP
    IX -->> Page: PublicKeyCredential (synthetic)
```

---

## Registration Flow (create)

```mermaid
sequenceDiagram
    participant Page as Page JS
    participant IX as Interceptor (MAIN)
    participant BR as Bridge (ISOLATED)
    participant SW as Background SW
    participant Vault as E2E Vault
    participant RP as RP Server

    Page ->> IX: navigator.credentials.create({ rp, user, challenge })
    IX ->> BR: postMessage PASSKEY_CONFIRM_CREATE { rpId, userName }
    BR ->> SW: sendMessage PASSKEY_CHECK_DUPLICATE (+ sender tab URL)
    SW ->> SW: isSenderAuthorizedForRpId(rpId, senderUrl)
    SW ->> Vault: getCachedEntries() → filter by rpId + userName

    alt vault locked or SW unreachable (2s timeout)
        BR -->> IX: { action: "platform" }
        IX -->> Page: origCreate() (platform authenticator)
    else existing entries found
        BR ->> BR: showPasskeySaveBanner (update/add options)
    else no existing entries
        BR ->> BR: showPasskeySaveBanner (save new)
    end

    Note over BR: User clicks "Save" or "Update"

    IX ->> BR: postMessage PASSKEY_CREATE_CREDENTIAL { rpId, userId, clientDataJSON, replaceEntryId? }
    BR ->> SW: sendMessage (+ sender tab URL)
    SW ->> SW: isSenderAuthorizedForRpId(rpId, senderUrl)
    SW ->> SW: validateClientDataJSON(origin, challenge, type)
    SW ->> SW: generatePasskeyKeypair() → P-256 key pair
    SW ->> SW: buildAttestationAuthData() → CBOR COSE key + authData
    SW ->> Vault: POST /api/passwords (new PASSKEY entry, E2E encrypted)
    Note over SW: ⚠ Vault saved here — before RP server confirms

    opt replaceEntryId provided
        SW ->> Vault: GET /api/passwords/:replaceEntryId
        SW ->> SW: verify entryType=PASSKEY, rpId, userName match
        SW ->> Vault: DELETE /api/passwords/:replaceEntryId
    end

    SW -->> BR: { ok, credentialId, attestationObject, clientDataJSON }
    BR -->> IX: postMessage WEBAUTHN_BRIDGE_RESP
    IX -->> Page: PublicKeyCredential (synthetic attestation)

    Page ->> RP: POST attestation to RP server
    RP -->> Page: OK or Error

    Note over SW,RP: ⚠ Extension cannot observe RP server result.<br/>If RP rejects attestation, vault entry persists as a<br/>"ghost entry". Ghost entries are filtered out during<br/>get() because the RP will not include their credential<br/>IDs in allowCredentials. User can delete manually.
```

---

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Cross-origin enumeration prevention | `isSenderAuthorizedForRpId()` — checks sender tab hostname matches rpId (domain suffix) |
| Origin binding | `validateClientDataJSON()` — verifies `origin` field matches sender tab origin |
| AAD downgrade prevention | `aadVersion < 1` → `INVALID_ENTRY` (PASSKEY entries always created with aadVersion=1) |
| Concurrent signing collision | `withSigningLock()` — per-credential mutex prevents counter race |
| Replay prevention | Sign counter incremented and persisted on every assertion |
| replaceEntryId safety | Verifies entryType=PASSKEY, rpId, and userName match before DELETE |
| Defense-in-depth | rpId re-validated post-decrypt against stored value in encrypted blob |

## Known Limitations

- **Ghost entries**: If the RP server rejects the attestation after vault save, the entry persists but is inert (filtered by `allowCredentials`). No fix without fetch interception or pending-entry state — deferred.
- **excludeCredentials not enforced**: `excludeCredentialIds` is forwarded but not checked against vault entries. Duplicate registrations are possible.
- **postMessage origin**: MAIN world origin check uses `window.location.origin` (only option available). ISOLATED world `event.origin` check is correct.
- **Google passkey page**: Google's passkey management page uses its own JS wrapper (`passkeys.js`) that may reject the synthetic credential or timeout before the extension responds.
