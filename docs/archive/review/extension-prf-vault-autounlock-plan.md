# Plan: Extension PRF Vault Auto-Unlock (方式A)

## Project context

- **Type**: mixed (Next.js web app + browser-extension MV3 package + iOS, all in one repo). This change touches the web app (`src/`) and the extension (`extension/`).
- **Test infrastructure**: unit + integration + E2E + CI/CD (vitest for both web and extension; Playwright E2E; multi-package CI gates via `pre-pr.sh`).
- **Verification environment constraints**:
  - **VC1 — passkey PRF ceremony**: requires a real authenticator that supports the WebAuthn PRF (hmac-secret) extension. The PRF auto-unlock path on the web tab cannot be exercised end-to-end in headless CI without a virtual authenticator configured for PRF. Manual-test path for the full "connect = unlock" flow is `blocked-deferred` for CI; `verifiable-local` only with a PRF-capable authenticator (e.g. Chrome virtual authenticator devtools, or a hardware key with hmac-secret). Crypto round-trip (wrap→bridge→unwrap) IS `verifiable-local` and `verifiable-CI` via unit tests with a fixed PRF-output fixture — the ceremony is mocked, the crypto is real.
  - **VC2 — cross-context message relay**: the page→content-script→SW envelope hop runs across real extension contexts; jsdom unit tests mock `chrome.runtime`. Full relay is `verifiable-local` (loaded unpacked extension) but `blocked-deferred` for the existing CI (no loaded-extension harness). Each hop's logic is `verifiable-CI` in isolation via the existing `token-bridge-lib.ts` / background test patterns.

## Objective

After the extension connects (during `ext_connect` on the web-app tab), if the user's
vault is unlocked on that tab via a PRF passkey, transfer the vault secret key to the
extension so the popup lands on `vault_unlocked` with **no passphrase prompt**. The
plaintext vault key must never cross the page heap boundary in the clear, the content
script, or the server — only ciphertext sealed to the extension's own ECDH keypair moves.

When no PRF-unwrapped key is available (Google/SAML/passphrase session, or PRF
unavailable), behavior is unchanged: the extension shows its passphrase screen as today.
This is a pure enhancement with a clean fallback.

## Requirements

**Functional**
- FR1: On successful `ext_connect`, if the web tab holds (or can obtain via
  `unlockWithStoredPrf()`) the PRF-unwrapped vault secret key, the extension SW receives
  it and unlocks the vault without user passphrase entry.
- FR2: If no PRF key is available, no envelope is sent; the extension falls back to the
  passphrase screen (existing behavior). No regression for non-PRF sessions.
- FR3: If the transferred key fails verification against the server's verification
  artifact (e.g. vault key rotated since the page's PRF wrap), the SW discards it and
  falls back to the passphrase screen. Never install an unverified key.

**Non-functional**
- NFR1 (trust boundary): plaintext vault key never appears in the content script or
  server. The envelope is sealed to the SW's ECDH public key whose private half never
  leaves the SW's IndexedDB.
- NFR2 (domain separation): the extension-vault-key wrap uses a dedicated AAD distinct
  from the team-key wrap, so an envelope minted for the team path cannot be replayed as
  an extension-vault-key envelope and vice versa.
- NFR3 (zeroization): plaintext key material (page-side secret key copy, SW-side
  unwrapped key, PRF output) is zeroized after use on both ends.
- NFR4 (parity): the wrap (web) and unwrap (extension) crypto must be byte-compatible;
  guarded by a golden-vector parity test, mirroring the AAD parity discipline
  ([[project_aad_three_implementations]]).

## Technical approach

Reuse the proven team-key ECDH escrow primitives ("seal a secret for the holder of an
ECDH keypair"), with a NEW domain-separated AAD context:

- Web wrap: `createTeamKeyEscrow`-style flow → `wrapTeamKeyForMember` →
  `deriveTeamWrappingKey` (ECDH deriveBits → HKDF-SHA256 → AES-256-GCM with AAD)
  ([src/lib/crypto/crypto-team.ts:283-324](../../src/lib/crypto/crypto-team.ts)).
- Extension unwrap: `unwrapTeamKey(encrypted, ephemeralPubJwk, recipientPrivKey, hkdfSalt, ctx)`
  ([extension/src/lib/crypto-team.ts:280-317](../../extension/src/lib/crypto-team.ts)).
- ECDH keypair gen: `generateECDHKeyPair()` (P-256, `["deriveKey","deriveBits"]`)
  ([src/lib/crypto/crypto-emergency.ts:91-97](../../src/lib/crypto/crypto-emergency.ts)).
- AAD: extend `buildTeamKeyWrapAAD` registry in `crypto-aad.ts` with a dedicated
  ext-vault-key purpose (NOT the team string).

**Channel: direct over the bridge** (server stays oblivious). The SW publishes its ECDH
public JWK in the `START_CONNECT` response; the web tab wraps the key and posts the
envelope back over the existing token-bridge relay as a second message; the content
script relays it to the SW. No server change.

**Key reachability (resolved Open Question #2)**: PR #620 made `ext_connect` skip
`VaultLockScreen` (where PRF auto-unlock fires). So `AutoExtensionConnect` must call
`unlockWithStoredPrf()` itself when `hasPrf()` is true, harvest the key via
`getSecretKey()`, wrap it, then zeroize. Non-PRF → skip, fall back.

## Contracts

### C1 — Extension SW ECDH keypair (IDB-backed)
- **Module**: `extension/src/lib/ecdh-key.ts` (NEW), mirroring `dpop-key.ts`.
- **Signatures**:
  - `getOrCreateEcdhKeyPair(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }>`
  - `getEcdhPublicJwk(): Promise<JsonWebKey>`
  - `resetEcdhKey(): void` (in-memory cache drop; mirrors `resetInMemoryKeyCache`)
- **Invariants**:
  - app-enforced: private key generated with `["deriveKey","deriveBits"]`, P-256,
    `extractable: false`; stored in IDB store `dpop-keys` (reuse the DB) under a
    SEPARATE record key `current-ecdh` (NOT `current`). The DPoP signing key
    (`["sign"]`) and this ECDH key are distinct CryptoKeys — never conflated.
  - app-enforced: persist-before-resolve (IDB put completes before thumbprint/pubjwk
    returned), mirroring dpop-key.ts.
- **Forbidden patterns**:
  - `pattern: namedCurve:\s*"P-256".*\["sign".*"deriveBits"\]` — reason: ECDSA and ECDH usages must not be combined on one key.
- **Acceptance**: a fresh SW generates one ECDH keypair; subsequent calls return the same
  public JWK until reset; key survives SW restart via IDB.

### C2 — Dedicated ext-vault-key AAD
- **Module**: `src/lib/crypto/crypto-aad.ts` (web) + `extension/src/lib/crypto-aad*.ts` (ext mirror).
- **Signature**: `buildExtVaultKeyWrapAAD(ctx: ExtVaultKeyWrapContext): Uint8Array`
  where `ExtVaultKeyWrapContext = { purpose: typeof EXT_VAULT_KEY_AAD_PURPOSE; userId: string; recipientJkt: string; keyVersion: number; wrapVersion: number }`.
  The purpose literal is exported as a named constant
  `export const EXT_VAULT_KEY_AAD_PURPOSE = "ext-vault-key" as const` from `crypto-aad.ts`
  (and mirrored in the extension), never inlined — both impls import the same constant so
  the AAD parity (C8) cannot drift on the purpose string ([[feedback_const_object_for_string_literals]]).
- **Invariants**:
  - app-enforced: AAD bytes are byte-identical between web and extension implementations
    (parity test C8). `purpose` is the literal `"ext-vault-key"`, distinct from any team
    purpose string.
  - app-enforced: `recipientJkt` is the RFC 7638 thumbprint of the SW's ECDH public key —
    binds the envelope to THIS extension install (anti-replay to a different recipient).
- **Forbidden patterns**:
  - `pattern: ext-vault-key.*team|team.*ext-vault-key` — reason: the two AAD purposes must never be mixed in one builder branch.
- **Acceptance**: wrapping with this AAD and unwrapping with a different AAD (team, or a
  different recipientJkt) fails the GCM auth tag check.

### C3 — START_CONNECT response carries SW ECDH public JWK
- **Producer**: `extension/src/background/index.ts` START_CONNECT handler →
  `startConnect` result.
- **Shape addition**: the SW's reply to the content script's `START_CONNECT` message gains
  `{ ok, errorCode?, ecdhPublicJwk?: JsonWebKey }`. `ecdhPublicJwk` present only when
  `ok === true` (a connected SW that can receive a key).
- **Consumer-flow walkthrough**:
  - Consumer: `token-bridge-lib.ts` `handleConnectRequestMessage` (path: extension/src/content/token-bridge-lib.ts) reads `{ ok, errorCode, ecdhPublicJwk }` and relays `ecdhPublicJwk` to the web tab inside the existing `EXT_CONNECT_READY` envelope (a new optional field). It performs NO crypto; it only forwards the JWK.
  - Consumer: `auto-extension-connect.tsx` `connect()` (path: src/components/extension/auto-extension-connect.tsx) reads `{ ok, errorCode, ecdhPublicJwk }` from `requestExtensionConnect()`'s result and, when `ok && ecdhPublicJwk && hasPrf-or-already-unlocked`, uses `ecdhPublicJwk` as the recipient public key for `createTeamKeyEscrow`-style wrap.
- **Invariants**: app-enforced — `ecdhPublicJwk` is the public half only; the private key
  never crosses any message boundary.
- **Acceptance**: after a successful connect, the web tab receives a well-formed P-256 ECDH
  public JWK; on `ok === false` the field is absent.

### C4 — token-bridge relay carries the envelope (page → CS → SW)
- **Producer/relay**: `extension/src/content/token-bridge-lib.ts` (+ its plain-JS mirror
  `token-bridge.js` — MUST update both, [[project_extension_parallel_impl]]).
- **New messages**:
  - `EXT_CONNECT_READY` envelope gains optional `ecdhPublicJwk?: JsonWebKey` (C3 relay).
  - New page→CS message `EXT_VAULT_KEY_ENVELOPE` `{ type, reqId, envelope: VaultKeyEnvelope }`
    relayed to the SW as `EXT_MSG.INSTALL_VAULT_KEY`.
  - `VaultKeyEnvelope = { ephemeralPublicKey: string; ciphertext: string; iv: string; authTag: string; hkdfSalt: string; keyVersion: number; wrapVersion: number }` (all hex except the JWK string).
- **Invariants**:
  - app-enforced: the content script does NO crypto and holds no ECDH private key — it
    relays opaque bytes only (preserves the pure-relay contract,
    [[project_webauthn_bridge_user_presence]] trust model).
  - app-enforced: the envelope message is accepted by the relay only under the same
    origin + (for the page→CS direction) the same C15-v2 user-activation discipline the
    connect request already enforces, since the wrap is a consequence of the same gesture.
- **Forbidden patterns**:
  - `pattern: INSTALL_VAULT_KEY` MUST appear in BOTH `token-bridge-lib.ts` and `token-bridge.js` — reason: parallel-impl drift guard.
- **Consumer-flow walkthrough**:
  - Consumer: SW `INSTALL_VAULT_KEY` handler (path: extension/src/background/index.ts) reads `{ ephemeralPublicKey, ciphertext, iv, authTag, hkdfSalt, keyVersion, wrapVersion }` and uses ALL of them: `unwrapTeamKey`-style unwrap needs ephemeralPublicKey + ciphertext/iv/authTag + hkdfSalt + the reconstructed AAD (which needs keyVersion + wrapVersion + recipientJkt(self) + userId(from token)).
- **Acceptance**: a valid envelope posted by the page reaches the SW handler intact; a
  malformed/oversized envelope is rejected without throwing.

### C5 — SW INSTALL_VAULT_KEY handler + finishUnlock refactor
- **Module**: `extension/src/background/index.ts`.
- **Refactor**: extract the post-unlock tail shared by the passphrase path
  (`UNLOCK_VAULT`) into `finishUnlock(secretKey: Uint8Array, vaultData): Promise<boolean>`
  — derive encryptionKey, `verifyKey` against `verificationArtifact`, set state, persist,
  schedule auto-lock, zeroize.
- **Signature**: `case EXT_MSG.INSTALL_VAULT_KEY` → unwrap envelope → `finishUnlock`.
- **Invariants**:
  - app-enforced: requires a current token (Bearer) — reuses `/api/vault/unlock/data` to
    fetch `verificationArtifact` + ECDH-team fields, exactly like `UNLOCK_VAULT`.
  - app-enforced: if `verifyKey` fails → discard, do NOT set `encryptionKey`, leave vault
    locked (FR3). Zeroize the candidate key.
  - app-enforced: AAD reconstructed SW-side uses `recipientJkt = thumbprint(own ECDH
    pubkey)` and `userId` from the authenticated token — NOT from the envelope (prevents a
    forged-userId envelope from unwrapping).
- **Acceptance**: valid envelope → vault unlocked, `GET_STATUS` reports
  `vaultUnlocked: true`; tampered envelope or rotated-key envelope → vault stays locked,
  no throw.

### C6 — Web tab wrap-on-connect (auto-extension-connect)
- **Module**: `src/components/extension/auto-extension-connect.tsx`.
- **Behavior**: after `result.ok` with `ecdhPublicJwk`:
  1. If vault not already unlocked on this page AND `hasPrf()` → `await unlockWithStoredPrf()`.
  2. `const sk = getSecretKey()`; if null → skip (fallback), do nothing.
  3. Wrap `sk` for `ecdhPublicJwk` with the C2 AAD (recipientJkt = thumbprint(ecdhPublicJwk),
     userId = session user, keyVersion = `getKeyVersion()`), post `EXT_VAULT_KEY_ENVELOPE`.
  4. Zeroize the `sk` copy.
- **Invariants**:
  - app-enforced: the page never posts plaintext — only the sealed envelope.
  - app-enforced: zeroize `sk` (`.fill(0)`) in a `finally` regardless of post success.
  - app-enforced: does not block or fail the connect UX if wrapping fails — best-effort;
    on any error the extension simply falls back to the passphrase screen.
- **Acceptance**: PRF session → envelope posted, plaintext zeroized; non-PRF session → no
  envelope, no error.

### C7 — Popup UX (no new screen)
- **Module**: `extension/src/popup/*` (relies on existing `GET_STATUS` + storage-change reactivity).
- **Behavior**: when the SW installs the key it calls `persistState()`, which writes
  `SESSION_KEY` to `chrome.storage.session`. The popup's existing
  `chrome.storage.onChanged` listener (App.tsx, already present for keyboard-shortcut
  lock) fires `refreshStatus(0, false)`, so a popup that is ALREADY OPEN when the key is
  installed re-reads `GET_STATUS` and transitions to `vault_unlocked` immediately — no
  polling, no missed update (addresses R4: the install path must trigger the same
  storage-change signal the lock path already uses). A popup opened AFTER install simply
  reads `vaultUnlocked: true` on mount. On fallback, the passphrase screen behaves exactly
  as today. No new button.
- **Invariants**: app-enforced — `INSTALL_VAULT_KEY` success path MUST call `persistState()`
  (so the storage-change listener fires); `finishUnlock` already does this for the
  passphrase path, so the shared `finishUnlock` (C5) covers it.
- **Acceptance**: PRF connect → popup opens directly to the entry list; a popup left open
  during connect flips to the entry list without user action; non-PRF → popup shows the
  passphrase screen.

### C8 — Crypto parity + AAD golden vectors
- **Modules**: `src/lib/crypto/__tests__/*` + `extension/src/__tests__/lib/*`.
- **Tests**: a fixed (prfOutput, secretKey, ephemeral keypair, salt, ctx) fixture wrapped
  by the web impl unwraps to the identical secretKey by the extension impl, and vice
  versa; AAD bytes match byte-for-byte; a wrong-purpose/wrong-recipientJkt AAD fails.
- **Acceptance**: parity tests green in both packages; CI runs both.

## Invariants summary (universally-quantified — member-set derivation, R42)

- "The content script does NO crypto on the key path." Member-set = every handler in the
  token-bridge relay. Derivation: `grep -nE 'crypto\.|subtle|deriveBits|importKey' extension/src/content/token-bridge*.ts` → MUST be empty. Applied members: `token-bridge-lib.ts`, `token-bridge.js`.
- "Plaintext key is zeroized at every site that holds it." Member-set = sites assigning a
  raw secret key. Derivation: `grep -nE 'getSecretKey\(\)|secretKey\b' src/components/extension/auto-extension-connect.tsx extension/src/background/index.ts` → each holder has a `.fill(0)`.

## Forbidden patterns (diff-wide)

- `pattern: postMessage\([^)]*secretKey` — reason: never post a plaintext key over any message channel.
- `pattern: ecdhPrivateKey.*postMessage|postMessage.*ecdhPrivate` — reason: ECDH private key never crosses a boundary.
- `pattern: INSTALL_VAULT_KEY` in only one of the two token-bridge files — reason: parallel-impl drift (C4).

## Testing strategy

Explicit test-file mapping (which existing/new files each contract touches):

- **C6 (wrap-on-connect)** → extend `src/components/extension/auto-extension-connect.test.tsx`:
  mock `useVault()` to expose a fixed `getSecretKey()`/`hasPrf()`/`getKeyVersion()`; assert
  envelope shape posted, plaintext zeroized, no-PRF skip, wrap-failure → no throw / fallback.
- **C5 (INSTALL_VAULT_KEY + finishUnlock)** → extend `extension/src/__tests__/background.test.ts`:
  fixture envelope → `finishUnlock` → `GET_STATUS vaultUnlocked: true`; tampered envelope →
  stays locked; rotated `keyVersion` (verifyKey fails) → stays locked; forged-userId envelope
  rejected (AAD reconstructed from token, not envelope).
- **C2 + C8 (AAD + parity)** → NEW `src/lib/crypto/__tests__/ext-vault-key-aad.test.ts` and
  `extension/src/__tests__/lib/ext-vault-key-parity.test.ts`: golden-vector cross-impl
  wrap/unwrap; AAD byte-for-byte match; wrong-purpose / wrong-recipientJkt AAD fails GCM.
- **C1 (ECDH key)** → NEW `extension/src/__tests__/lib/ecdh-key.test.ts`: keypair gen,
  IDB persistence across SW restart, separate record key from DPoP, usages assertion.
- **C4 (relay)** → extend the existing `token-bridge` test (jsdom): page→CS→SW threading;
  assert the content script forwards opaque bytes and performs no crypto. Update BOTH
  `token-bridge-lib.ts` test and confirm `token-bridge.js` mirror (manual diff check).
- **C3 (START_CONNECT shape)** → covered by the C4 relay test + a background-test assertion
  that the START_CONNECT reply includes `ecdhPublicJwk` on success only.
- E2E: `blocked-deferred` for the full PRF ceremony (VC1) — document the manual-test
  recipe (Chrome virtual authenticator with PRF) in the plan; the crypto + relay layers
  are covered by unit/parity tests above.

**Page-vault side effect note**: C6 may call `unlockWithStoredPrf()`, which unlocks the
page's own vault context (sets `VaultProvider` state to UNLOCKED) as a side effect of
harvesting the key. This is benign — the ext_connect tab is shown the connect overlay (PR
#620), not the dashboard, and after connect the user closes the tab. SC4 tracks the
optional re-lock nicety. No UI inconsistency results because no dashboard content renders
on the ext_connect tab.

## Considerations & constraints

### Scope contract
- **SC1 — server escrow relay channel**: the alternative "server stores ciphertext keyed
  by bridge-code" channel is NOT built; direct-bridge only. Owner: future issue if the
  direct channel proves awkward.
- **SC2 — 方式B (popup WebAuthn ceremony)**: rejected (RP-id binding likely blocks
  chrome-extension:// origin). Not in scope. Owner: design memo, closed.
- **SC3 — team-vault auto-unlock over the extension**: only the personal vault secret key
  is transferred. Team keys continue to be derived on demand from the personal key as
  today. Owner: existing team-key flow.
- **SC4 — re-lock the page-side vault after harvest**: optional nicety (page vault could be
  re-locked after wrapping). Deferred — the page vault state is unchanged by this feature;
  PR #620 already keeps it locked in the non-PRF path. Owner: follow-up if desired.

### Known risks
- Key rotation between the page's PRF unwrap and the SW verify → handled by FR3
  (verify-or-fallback).
- C15-v2 activation: the envelope post is a consequence of the same connect gesture; must
  not require a second user activation. Verify the relay accepts the second message under
  the original activation window.

## User operation scenarios

1. **PRF passkey user, fresh connect**: signs in with PRF passkey on the ext_connect tab →
   vault auto-unlocks on the page → extension receives the sealed key → popup opens to the
   entry list, no passphrase. (Happy path.)
2. **Google/SAML user**: no PRF key in memory → no envelope → popup shows passphrase
   screen (unchanged).
3. **PRF user whose vault key was rotated** after the passkey's PRF wrap → page wraps a
   stale key → SW verify fails → popup falls back to passphrase screen.
4. **XSS on the page**: the page already holds the unwrapped key (XSS there is already
   game-over for that session's vault); 方式A grants no NEW capability to a page attacker —
   the protected boundary is content-script/server, which stays sealed.

## Go/No-Go Gate

| ID  | Subject                                              | Status  |
|-----|------------------------------------------------------|---------|
| C1  | Extension SW ECDH keypair (IDB)                      | pending |
| C2  | Dedicated ext-vault-key AAD                          | pending |
| C3  | START_CONNECT carries SW ECDH public JWK             | pending |
| C4  | token-bridge relay carries the envelope              | pending |
| C5  | SW INSTALL_VAULT_KEY handler + finishUnlock refactor | pending |
| C6  | Web tab wrap-on-connect                              | pending |
| C7  | Popup UX (no new screen)                             | pending |
| C8  | Crypto parity + AAD golden vectors                   | pending |
