# Extension Vault Auto-Unlock — 方式A (web-tab re-wrap → bridge → SW)

## Goal

Eliminate the passphrase screen after the extension connects. During
`ext_connect` the web-app tab has already PRF-unwrapped the vault secret key in
memory (the normal passkey auto-unlock). 方式A re-wraps that secret key **for the
extension's own ECDH keypair**, hands the ciphertext across the token-bridge, and
the service worker unwraps it locally — so connecting unlocks the vault, no
passphrase, and **no plaintext key ever touches the page, content script, or
server**.

## CRITICAL correctness constraint (a sub-investigation got this wrong)

**The server NEVER holds the plaintext vault secret key — that is the whole point
of the E2E design.** Any design that says "the server re-wraps the vault key in
the `/api/extension/token/exchange` response" is WRONG and impossible: the server
has only `encryptedSecretKey` (passphrase-wrapped) and PRF-wrapped blobs, never
the plaintext. The re-wrap MUST happen client-side, in the web-app tab, where the
PRF-unwrapped key transiently lives.

So in 方式A the server's role is unchanged (it still only does bridge-code +
token exchange). The vault-key ciphertext travels **peer-to-peer**: web-app tab →
content script (opaque ciphertext only) → SW. The server may optionally act as a
dumb relay/escrow for the ciphertext, but it is never able to decrypt it.

## Trust boundary (what crosses where)

| Hop | Today | 方式A adds |
|-----|-------|-----------|
| web-app tab (page heap) | bridge-code request kickoff | holds PRF-unwrapped vault key **transiently**, re-wraps it for the extension's ECDH pubkey, zeroizes |
| content script (`token-bridge`) | relays `{ok, errorCode}` only | relays the **ciphertext** envelope (opaque; cannot decrypt — no ECDH private key) |
| service worker | holds token, DPoP key | generates ECDH keypair, unwraps the envelope → vault key, holds `encryptionKey` |
| server | bridge-code + exchange | unchanged (optionally a dumb ciphertext relay) |

The content script remains unable to read anything sensitive: the envelope is
sealed to the SW's ECDH public key, whose private half never leaves the SW's IDB.

## Reusable crypto (confirmed present)

The team-key ECDH escrow primitives are an EXACT fit ("seal a secret for the
holder of an ECDH keypair"):

- Web app wrap: `createTeamKeyEscrow(secret, recipientPubJwk, ...) → { ephemeralPublicKey, encrypted{ciphertext,iv,authTag}, hkdfSalt }`
  ([src/lib/crypto/crypto-team.ts:283-324](../../src/lib/crypto/crypto-team.ts))
  built on `wrapTeamKeyForMember` → `deriveTeamWrappingKey` (ECDH deriveBits →
  HKDF-SHA256 → AES-256-GCM, with AAD).
- Extension unwrap: `unwrapTeamKey(encrypted, ephemeralPubJwk, recipientPrivKey, hkdfSalt, ctx)`
  ([extension/src/lib/crypto-team.ts:280-317](../../extension/src/lib/crypto-team.ts)) — identical shape.
- ECDH keypair gen: `generateECDHKeyPair()` (`["deriveKey","deriveBits"]`, P-256)
  ([src/lib/crypto/crypto-emergency.ts:91-97](../../src/lib/crypto/crypto-emergency.ts)).

We will NOT overload the team context literally; we add a dedicated
domain-separated AAD/info for the extension-vault-key wrap (see Security below),
to keep the team and extension key-transfer cryptographically distinct.

## Key facts that shape the design

1. **DPoP key is ECDSA `["sign"]` only — cannot do ECDH.**
   ([extension/src/lib/dpop-key.ts:93-101](../../extension/src/lib/dpop-key.ts)).
   The SW must generate a SEPARATE ECDH P-256 keypair, stored in the same IDB
   (new record key, e.g. `current-ecdh`), private key non-extractable.

2. **Connect happens in the web-app tab; the SW drives bridge-code/exchange
   internally; the content script is a pure relay** that today only sees
   `{ok, errorCode}` ([extension/src/content/token-bridge-lib.ts](../../extension/src/content/token-bridge-lib.ts)).
   The envelope must ride this relay as opaque bytes.

3. **The web app already auto-unlocks via PRF** on the dashboard
   (`unlockWithStoredPrf` in vault-context). During `ext_connect` the dashboard is
   the page being shown, so the unwrapped key is available right when connect runs
   — **but only if the user signed in with a PRF passkey**. Google/SAML/passphrase
   sessions have no PRF key in memory → 方式A must fall back to the passphrase
   screen (unchanged behavior) in that case.

## Design

### Handshake addition (peer-to-peer envelope)

Extend the existing connect handshake so the SW publishes its ECDH public key and
the web-app tab returns a sealed envelope. Two viable channels:

- **(Preferred) Direct over the bridge.** The SW, when it returns its
  `START_CONNECT` result to the content script, also includes its **ECDH public
  JWK**. The web-app tab (auto-extension-connect), upon `ok`, if it currently
  holds a PRF-unwrapped vault key, calls `createTeamKeyEscrow`-style wrap against
  that pubkey and posts the envelope back over the bridge as a second message
  (`EXT_VAULT_KEY_ENVELOPE`). The content script relays it to the SW
  (`EXT_MSG.INSTALL_VAULT_KEY`). Server is never involved in the key transfer.
  - Pro: server stays oblivious; minimal server change.
  - Con: a new bridge message type + careful ordering with C15-v2 activation.

- (Alternative) Server escrow relay. Web tab POSTs the (opaque) envelope to a new
  endpoint keyed by bridge-code; SW fetches it via Bearer after exchange. Server
  stores ciphertext only. More moving parts; only worth it if the direct bridge
  message proves awkward. Default to the direct channel.

### Service worker

1. On first connect (or lazily), `getOrCreateEcdhKeyPair()` in IDB
   (`extension/src/lib/ecdh-key.ts`, mirroring dpop-key.ts), export public JWK.
2. Include the ECDH public JWK in the `START_CONNECT` response payload.
3. New handler `INSTALL_VAULT_KEY`: receive `{ ephemeralPublicKey, ciphertext,
   iv, authTag, hkdfSalt }`, import the SW's ECDH private key, run the
   extension-side unwrap → `secretKey`. Then converge on the SAME post-unlock tail
   the passphrase path uses (refactor into `finishUnlock(secretKey)`): derive
   encryptionKey, `verifyKey` against the artifact from `/api/vault/unlock/data`,
   set state, persist, schedule auto-lock. Zeroize `secretKey`.
   - If `verifyKey` fails (e.g. vault key rotated since the page's PRF wrap →
     stale key), DISCARD and fall back to the passphrase screen. Never install a
     key that fails verification.

### Web-app tab (auto-extension-connect)

After `result.ok`, if a freshly-unwrapped vault key is available in this page's
vault context (PRF auto-unlock just ran), wrap it for the SW's ECDH pubkey and
post the envelope. Then **zeroize** the plaintext. If no key is available
(non-PRF session, vault not unlocked on this page), do nothing — extension shows
the passphrase screen as today. This makes 方式A a pure enhancement with a clean
fallback.

### Popup UX

- When the vault auto-unlocks via the installed key, the popup simply lands on
  `vault_unlocked` — no passphrase shown. The win is the ABSENCE of a screen.
- When fallback occurs (no PRF), the passphrase screen behaves exactly as today.
- No new button needed (unlike 方式B). Optional: a one-time toast "Vault unlocked
  via passkey".

## Security review checklist (must hold)

- **No plaintext off-SW/off-page.** Envelope is sealed to the SW ECDH pubkey;
  content script & server see only ciphertext. ✅ by construction.
- **Forward-ish secrecy.** Each wrap uses a fresh ephemeral ECDH key
  (createTeamKeyEscrow generates one per call) + random 32-byte HKDF salt. ✅
- **Domain separation.** Use a dedicated HKDF `info` / AAD string for the
  extension-vault-key wrap (NOT the team string), e.g. AAD binding
  `{ purpose: "ext-vault-key", userId, recipientJkt: <SW ECDH thumbprint>,
  keyVersion }`. Binding the recipient's key thumbprint prevents an envelope
  minted for one extension install from being replayed to another. Mirror the
  AAD-parity discipline (memory `project_aad_three_implementations`).
- **Recipient authenticity.** The SW ECDH pubkey crosses the bridge from the SW.
  An XSS in the page could substitute its OWN ECDH pubkey to receive the wrapped
  key. Mitigations: (a) the page only EVER wraps a key it already holds (XSS in
  the page already has the unwrapped key — no NEW capability granted), and (b) the
  C15-v2 user-activation gate already guards the connect trigger. Document that
  方式A does not worsen the page-XSS threat (page-XSS is already game-over for that
  session's vault). The protected boundary is content-script/server, which 方式A
  keeps sealed.
- **keyVersion staleness** → verify-or-fallback (above).
- **Zeroization** on both ends (page + SW), single-use envelope, short TTL.

## Open questions before coding

1. **Envelope channel**: direct bridge message vs server escrow. Lean direct.
   Needs a new `EXT_VAULT_KEY_ENVELOPE` (page→CS→SW) message + ordering after the
   `ok`. Confirm the content-script relay can carry a second message without
   reopening the C15 activation gate (the wrap is a consequence of the same user
   gesture).
2. **Does auto-extension-connect have access to the vault context's unwrapped
   key** at connect time? Trace whether the `ext_connect` page is inside the
   VaultProvider and whether `getSecretKey()` (or equiv) is callable there.
3. **ECDH key lifecycle**: regenerate on DPoP key reset? Tie its lifetime to the
   connection; drop on disconnect/CLEAR_TOKEN.
4. **AAD exact bytes**: define and golden-vector test across web + extension.

## Comparison recap (why 方式A over 方式B)

- 方式B (popup ceremony) is likely INFEASIBLE: a passkey registered for the
  web-app origin probably cannot be asserted from a `chrome-extension://` popup
  (WebAuthn RP-id binding). 方式A sidesteps WebAuthn-in-extension entirely — the
  ceremony runs where it already works (web tab), and only ciphertext moves.
- 方式A reuses proven team-ECDH escrow primitives, keeps the server oblivious, and
  delivers the true "connect = unlock" UX the user asked for.

## Scope / sequencing

Separate PR from `feat/extension-reauth-ux`. Server change is minimal (none, if
the direct-bridge channel is used). Bulk is: extension ECDH keypair + IDB,
new bridge message + relay, SW install handler + finishUnlock refactor, web-tab
wrap-on-connect, AAD + parity tests, popup fallback verification.

**Gate before implementation: Open Question #2 (is the unwrapped vault key
reachable in the ext_connect page context?). If the dashboard PRF auto-unlock has
already zeroized the key by the time connect runs, we need a small hook to capture
it at unlock time. Resolve before building.**
