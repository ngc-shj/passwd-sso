# Plan: Extension Passkey Provider

## Objective

Add a passkey provider to the passwd-sso browser extension. When a website calls `navigator.credentials.get()` or `navigator.credentials.create()`, the extension intercepts the call, offers matching passkeys stored in passwd-sso, and performs cryptographic signing using stored private keys — all client-side with E2E encryption.

## Requirements

### Functional
- Intercept `navigator.credentials.get()` on websites and show matching passkeys by rpId
- Intercept `navigator.credentials.create()` and offer to save new passkeys in the vault
- Generate P-256 key pairs, perform ECDSA signing, build WebAuthn attestation/assertion responses
- Store private key material inside E2E-encrypted `encryptedBlob` (never plaintext on server)
- Preserve passkey provider fields when editing entries in the web app
- User can dismiss extension UI and fall through to platform authenticator
- i18n support for extension UI (en/ja)

### Non-Functional
- No new npm dependencies (minimal CBOR encoder, Web Crypto API)
- No DB migration (new fields live inside encrypted blob)
- Transparent passthrough for pages that don't use WebAuthn
- Service worker handles all crypto (private keys never leave SW context)

## Technical Approach

### Architecture
- **MAIN world**: `webauthn-interceptor.js` overrides `navigator.credentials.get/create()`
- **ISOLATED world**: `webauthn-bridge.ts` relays postMessage between MAIN and background
- **Background SW**: `passkey-provider.ts` handles key generation, signing, entry CRUD
- **UI**: Shadow DOM modal (passkey-dropdown.ts) and banner (passkey-save-banner.ts)

### Data Model
- Extend `FullEntryData` with 7 passkey provider fields (privateKeyJwk, publicKeyCose, userHandle, userDisplayName, signCount, algorithm, transports)
- Extend `DecryptedEntry` with `relyingPartyId` and `credentialId` for rpId-based matching
- Add `PASSKEY` to `EXT_ENTRY_TYPE` and `ACTIONABLE_TYPES`

### Crypto
- P-256 (ES256, alg -7) key generation via Web Crypto API
- ECDSA signing with P1363→DER conversion
- COSE public key encoding for attestation
- "none" attestation format (software authenticator)

## Implementation Steps

1. Data model & types (entry.ts, messages.ts, constants.ts)
2. Crypto utilities (cbor.ts, webauthn-crypto.ts)
3. Background passkey provider (passkey-provider.ts, index.ts wiring)
4. Content scripts (webauthn-interceptor.js, webauthn-bridge)
5. Selection UI (passkey-dropdown.ts, passkey-save-banner.ts)
6. Web app round-trip preservation (personal-passkey-form.tsx, edit dialog)

## Testing Strategy

- Existing vitest suite (541 files, 6737 tests) must continue to pass
- Production build (`npx next build`) must succeed
- Manual testing: load extension in Chrome, visit WebAuthn demo site, register/authenticate
- Crypto unit tests for CBOR, DER encoding, key generation

## Considerations & Constraints

- Extension is a separate bundle; cannot share code with webapp `src/lib/`
- MAIN world scripts must be plain JS (CRXJS copies without transpilation)
- `navigator.credentials` override must run at `document_start` before page JS
- Counter update requires full blob decrypt/encrypt (counter is inside E2E-encrypted blob)
- `PublicKeyCredential` objects are plain objects (no prototype chain), which means `instanceof` checks by websites will fail

## User Operation Scenarios

1. **Authentication flow**: User visits GitHub → GitHub calls `navigator.credentials.get()` → Extension shows modal with matching passkeys → User selects one → Extension signs challenge → GitHub receives assertion → Login succeeds
2. **Registration flow**: User visits GitHub → GitHub calls `navigator.credentials.create()` → Extension shows save banner → User clicks "Save in passwd-sso" → Extension generates key pair → Saves as PASSKEY entry → Returns attestation to GitHub
3. **Fallback flow**: User visits site → Extension has no matching passkeys → Falls through to platform authenticator transparently
4. **Cancel flow**: User sees selection modal → Clicks "Cancel" → Website receives NotAllowedError
5. **Platform fallback**: User sees selection modal → Clicks "Use device passkey" → Falls through to platform authenticator
6. **Web app edit**: User opens PASSKEY entry in web app → Edits title/notes → Provider fields preserved on save
