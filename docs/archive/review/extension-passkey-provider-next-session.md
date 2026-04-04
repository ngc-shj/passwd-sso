# Next Session: Google Passkey Registration Compatibility

## Goal

Make the passwd-sso extension's passkey provider work on Google's passkey management page (myaccount.google.com).

## Current Status

- **Branch**: `feat/extension-passkey-provider` (14 commits ahead of main)
- **webauthn.io**: Registration and authentication both work ✅
- **Google**: Registration fails with `RpcError` ❌

## What Works

- MAIN world interceptor injects via `chrome.scripting.registerContentScripts` with `world: "MAIN"`
- `navigator.credentials.create()` and `.get()` are overridden
- Save banner appears on Google's passkey page
- Vault entry is saved (PASSKEY type with E2E encrypted private key)
- `Object.setPrototypeOf` sets correct prototype chain (`PublicKeyCredential.prototype`, `AuthenticatorAttestationResponse.prototype`)
- All data fields are correct (ArrayBuffer types, `getTransports`, `getPublicKey`, `getAuthenticatorData`)

## The Problem

Google's passkey page (`myaccount.google.com/signinoptions/passkeys`) loads its own scripts:

- **`passkeys-inject.js`** — Injected into the page, has a `lifetimeTimer` that throws `NotAllowedError` on timeout
- **`passkeys.js`** — Contains `postMessageToExtension()` and wraps `navigator.credentials.create()`

Stack trace on failure:
```
passkeys-inject.js:22 Uncaught NotAllowedError: lifetimeTimer has expired
  sendResponse @ passkeys-inject.js:41
  (anonymous) @ passkeys-inject.js:86
  (anonymous) @ passkeys.js:136
  postMessageToExtension @ passkeys.js:120
  create @ passkeys.js:188
```

Google's JS appears to:
1. Wrap `navigator.credentials.create` with its own `create()` in `passkeys.js`
2. Use `postMessageToExtension` to communicate with Google Password Manager (a separate extension)
3. Start a `lifetimeTimer` that kills the operation if it takes too long

Our interceptor returns the credential correctly, but Google's wrapper either:
- Doesn't see our response (it goes to Google Password Manager instead)
- Rejects our response before forwarding to the server
- The `lifetimeTimer` expires because our async bridge adds latency

## Investigation Needed

1. **Read Google's `passkeys-inject.js` and `passkeys.js`** — Use DevTools Sources panel to find and read these scripts. Understand how `postMessageToExtension` works and what it expects.

2. **Check if Google bypasses `navigator.credentials`** — Google may not call `navigator.credentials.create()` at all on their passkey management page, instead using `postMessageToExtension` to communicate directly with their own extension.

3. **Study KeePassXC's approach** — KeePassXC successfully registers passkeys on Google. Their browser extension source code is at:
   - https://github.com/niclas/keepassxc-browser
   - Look at how they handle WebAuthn interception
   - They may use native messaging + OS credential provider instead of JS interception

4. **Check if the `RpcError` is client-side or server-side** — Use Chrome Network tab to see if the attestation data is actually sent to Google's server, or if Google's client-side JS rejects it before sending.

5. **Consider alternative approaches**:
   - Can we intercept `postMessageToExtension` instead of `navigator.credentials.create`?
   - Should we detect Google's passkey page and use a different strategy?
   - Is there a way to register as a Chrome credential provider without `chrome.credentialProvider` (which is Chrome OS only)?

## Key Files

- `extension/src/content/webauthn-interceptor.js` — MAIN world interceptor (plain JS)
- `extension/src/background/passkey-provider.ts` — Background crypto + entry CRUD
- `extension/src/content/webauthn-bridge-lib.ts` — ISOLATED world bridge
- `extension/src/lib/webauthn-crypto.ts` — P-256 key gen, signing, CBOR, DER

## Debug Commands

In page console (top frame):
```js
// Check if interceptor is active
window.__pssoWebAuthnInterceptor  // should be true

// Check prototype chain
navigator.credentials.create({...}).then(c => {
  console.log("instanceof:", c instanceof PublicKeyCredential);
});
```

In SW console:
```js
// Check interceptor registration
chrome.scripting.getRegisteredContentScripts().then(r => console.log(JSON.stringify(r, null, 2)))
```

## Also Needed in This Session

- Create PR for the current state (webauthn.io works, Google is known limitation)
- Add Google compatibility as a documented known limitation in the PR
