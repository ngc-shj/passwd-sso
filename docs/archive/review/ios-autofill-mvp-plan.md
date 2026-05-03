# iOS AutoFill MVP Plan

Date: 2026-04-30 (rewrite v2 — round 1 + round 2 reviews folded in)
Plan name: `ios-autofill-mvp`
Branch: `feature/ios-autofill-mvp`
Worktree: `passwd-sso-ios` (sibling of `passwd-sso`, base `origin/main`)
Save path: `docs/archive/review/ios-autofill-mvp-plan.md`

## Project Context

- Type: `mixed` (web app + browser extension + CLI + iOS app)
- Test infrastructure: parent repo has `unit + integration + E2E + CI/CD` (Vitest + Playwright + GitHub Actions on `ubuntu-latest`); the iOS workspace adds XCTest + a new `macos-latest` CI job as part of this plan
- Existing references:
  - Web product / API: `src/`, `README.ja.md`
  - Browser extension baseline: `extension/`
  - Auth / vault / token flows: `src/app/api/extension/*`, `src/lib/auth/*`, `src/lib/vault/*`, `src/lib/auth/tokens/extension-token.ts`
  - Existing OAuth 2.1 + PKCE implementation (MCP gateway): `src/app/api/mcp/*` — reused as the design template for the iOS auth flow

## Objective

Ship an iPhone MVP that lets a user fill stored credentials and TOTP codes in iOS Safari and supported apps via the iOS AutoFill credential-provider extension, without weakening the server-side zero-knowledge guarantee.

The MVP lets a user:
- configure their `passwd-sso` server URL
- sign in and unlock their vault on iPhone
- fill personal- and team-vault credentials in iOS Safari and apps with Associated Domains, gated by Face ID / Touch ID per fill
- fill TOTP codes via AutoFill (iOS 17+ One-Time-Codes path)
- browse / search vault entries inside the host app
- update credentials manually from inside the host app (the AutoFill-extension save/update path is **out of scope** — see "Non-goals")

## Non-Goals & Known Platform Gaps

These are the deliberate gaps versus the browser extension. Each is here so the MVP scope stays stable and the user-visible UX surface is honest.

| Gap | Reason | Future direction |
|-----|--------|------------------|
| **Save/update credential from a successful sign-in form** (browser extension via `webRequest.onCompleted` + DOM heuristics) | iOS has no equivalent callback into a third-party AutoFill extension after a sign-in completes. `ASCredentialIdentityStore` only registers hints. | Manual update inside `PasswdSSOApp`. A "Save to passwd-sso" share-sheet action is MVP+1. |
| **Magic Link sign-in on iPhone** | Magic Link click happens in the user's mail client, opening Safari (not the `ASWebAuthenticationSession` ephemeral instance). The Auth.js cookie ends up in the wrong context; the ephemeral session times out. | MVP+1: a server-side `mode=mobile` redirect on `/api/auth/callback/nodemailer` that forwards to a Universal Link payload. |
| **AutoFill in apps without Associated Domains** | iOS supplies no host string to the credential provider in this case; the user must pick from a manual list. | Document the UX. No iOS API change can recover host context from arbitrary apps. |
| **Pre-iOS-17 TOTP AutoFill** | The third-party One-Time-Codes provider entry point (`prepareOneTimeCodeCredentialList(for:)` + `ProvidesOneTimeCodes = YES`) is iOS-17-only. | iOS 16 users can still use password AutoFill; TOTP via copy/paste from the host app remains. |
| **Jailbroken-device protection** | All on-device protections are bypassable on a jailbroken device. | Out of scope; record the residual-risk acceptance in app docs. The server-side ZK property still holds. |
| **AutoFill-driven phishing protection beyond URL host match** | Self-hosted Apple App Site Association (AASA) per stored relying-party domain is operationally infeasible. iOS AutoFill matches by URL host string (parity with browser extension). | UX mitigation only: the credential picker shows the host the request came from, and users are reminded to verify the URL bar. |

## Requirements

### Functional

- iOS app target (`PasswdSSOApp`):
  - server URL setup
  - sign-in via `ASWebAuthenticationSession`
  - vault unlock with master passphrase
  - vault list, search, entry detail (personal + team)
  - TOTP display + copy
  - lock / logout / token refresh
  - settings (auto-lock interval, sign-out, reset)
  - manual credential edit (replaces the extension's save/update)
- AutoFill credential provider extension target (`PasswdSSOAutofillExtension`):
  - password credential matching for Safari + apps with Associated Domains
  - TOTP credential matching (iOS 17+ One-Time-Codes path)
  - locked-vault fallback (route the user to the host app)
  - per-fill Face ID / Touch ID prompt
- Personal and team vault entries both participate in matching.
- Server-side work is non-trivial: ~10 new files and modifications to the `ExtensionToken` schema, the `validateExtensionToken` dispatch, the tenant policy, and audit actions. See "Server-Side Changes" for the concrete file list. The existing `extension-token` desktop flow keeps current behavior unchanged for `clientKind='BROWSER_EXTENSION'` rows.
- Zero-knowledge property is preserved end-to-end:
  - server never receives plaintext vault contents
  - the AutoFill extension cannot decrypt vault material on disk without a fresh biometric prompt

### Non-Functional

- **Deployment target: iOS 17.0** (required for third-party `prepareOneTimeCodeCredentialList(for:)`). 
- **UI framework: SwiftUI**. 
- **Test framework: XCTest** (broadest CI tooling support; Swift Testing optional for new files later). 
- **Module shape**: `Shared` is an **Xcode framework target** (not SPM) initially. SPM split deferred until the iOS codebase justifies it.
- App and extension share state via two coordinated entitlements:
  - **App Group entitlement** `group.com.passwd-sso.shared` — shared file container for opaque ciphertext blobs
  - **Keychain access group entitlement** `<TeamID>.com.passwd-sso.shared` — shared Keychain for the per-device bridge key blob (which co-locates `bridge_key` and `cache_version_counter` in a single Keychain item — see "Encrypted-entries cache integrity")
- Auto-lock default: 5 minutes (user-configurable 1–60 minutes).

## Technical Approach

### Repository Strategy

Keep iOS in a sibling worktree of the parent repo: `passwd-sso-ios/` with the same git history root, branch `feature/ios-autofill-mvp`. The directory structure inside the worktree:

```text
ios/
  PasswdSSO.xcodeproj
  PasswdSSOApp/              # SwiftUI app
  PasswdSSOAutofillExtension/  # ASCredentialProviderViewController
  Shared/                    # framework target — models, API client, crypto, URL match, TOTP
  PasswdSSOTests/            # XCTest unit tests for Shared + per-target logic
  PasswdSSOUITests/          # XCUITest for app-side flows
extension/test/fixtures/     # NEW — JSON fixtures consumed by both Vitest and XCTest
```

(The "Packages/" SPM split shown in the previous draft is deferred — added only when the iOS codebase justifies it.)

### Deployment & Framework Decisions (decided up-front)

| Axis | Decision |
|------|----------|
| Minimum iOS | 17.0 |
| UI | SwiftUI |
| Test framework | XCTest |
| Shared module | Xcode framework target (not SPM) |
| Auth browser handoff | `ASWebAuthenticationSession` with `prefersEphemeralWebBrowserSession = true` |
| Redirect URI form | **Universal Link** (`apple-app-site-association` on the user's `passwd-sso` server domain). Custom URL schemes are forbidden — any installed app can claim them. |
| Token proof-of-possession | DPoP (RFC 9449) — net-new in this plan; parent's MCP gateway implements OAuth 2.1 + PKCE only. DPoP signing key is a Secure-Enclave-resident P-256 key (sign-only — Secure Enclave does not support ECDH; reusing this key for ECDH is a forbidden future-misuse). |
| Per-fill auth gate | `LAContext` biometric prompt enforced via Keychain access control on the bridge key, with `touchIDAuthenticationAllowableReuseDuration = 0` so iOS does not cache the authorization across consecutive fills |

### Auth & Token Acquisition Flow (resolves F1 / S1 / S3)

The existing `/api/extension/token/exchange` is built around a same-origin `window.postMessage` bridge code. That contract does not survive the iOS app boundary. Adding a thin mobile-specific authorization flow is cheaper than retrofitting the extension flow.

**Provider compatibility with `prefersEphemeralWebBrowserSession=true`**:

The ephemeral session isolates cookies from Safari. This affects each provider:
- **Google OIDC**: works; user re-enters credentials per iOS sign-in.
- **SAML / Jackson**: works; many IdPs (Okta, Azure AD, ADFS) require fresh MFA on each ephemeral sign-in. Tenants on SAML should expect users to re-authenticate every refresh-failure cycle.
- **Magic Link**: does NOT work — see Non-goals (the email click leaves the ephemeral webview).
- **Passkey**: does NOT work in the ephemeral webview reliably — iOS may not surface platform passkeys to a website loaded in an ephemeral `ASWebAuthenticationSession` instance. Passkey is deferred to MVP+1; the host-side passkey provider is the future path, not the ephemeral webview.

**Three new server endpoints**:

1. `GET /api/mobile/authorize` — entry point opened inside `ASWebAuthenticationSession`
   - query: `client_kind=ios`, `state` (32 bytes, base64url), `code_challenge` (S256), `device_pubkey` (P-256 from Secure Enclave, base64url-DER)
   - **`redirect_uri` is NOT a query parameter** — server computes it as `<self-origin>/api/mobile/authorize/redirect`. Accepting a client-supplied `redirect_uri` would be an open-redirect / bridge-code-phishing vector since iOS public clients have no pre-registered redirect-URI row to validate against. The Universal Link claim happens client-side (AASA on the same self-origin).
   - reuses Auth.js for the actual sign-in (Google/SAML)
   - on success, persists `(state, code_challenge, device_pubkey)` bound to a one-time bridge code under SELECT-FOR-UPDATE; bridge-code TTL = 60 s, single-use
   - redirects to the computed Universal Link with `?code=<one-time-bridge>&state=<state>`
2. `POST /api/mobile/token` — exchange the bridge code for an iOS access/refresh token pair
   - body: `{ code, code_verifier, device_pubkey }`
   - request itself MUST carry a DPoP proof signed by the same `device_pubkey` (RFC 9449 §4) so possession of the Secure Enclave key is required at exchange — defeats bridge-code interception that does not also extract the Secure Enclave key
   - server verifies, under transactional lock: bridge code exists and is unused; `state` matches; PKCE `code_verifier` hashes to the stored `code_challenge`; `device_pubkey` matches stored value; DPoP proof is valid
   - issues a single access/refresh pair bound to the device's Secure-Enclave DPoP key (see "Token shape" below); persists one row in `ExtensionToken` with `clientKind='IOS_APP'`, `devicePubkey`, `cnf.jkt` (DPoP key thumbprint), and `familyId`
3. `POST /api/mobile/token/refresh` — DPoP-protected refresh
   - DPoP proof signed by the same `device_pubkey` registered at exchange
   - rotates per the existing extension-token-rotation contract; replay disambiguation: a refresh request whose token was rotated within the last 5 s and whose body is byte-identical to the prior successful refresh returns the cached new token (legitimate retry-after-network-failure case); any other use of a revoked token escalates to family revoke + audit `MOBILE_TOKEN_REPLAY_DETECTED`

**Token shape (resolves S13 + the AutoFill DPoP-key access gap discovered in self-review)**:

`/api/mobile/token` issues a single access/refresh pair bound to a single Secure-Enclave DPoP key in the **per-app Keychain** (host-only). The AutoFill extension does NOT have a bearer credential and does NOT call the server during a fill — instead, the host app pre-caches encrypted vault entries (`encryptedBlob`, `encryptedOverview` per CLAUDE.md "E2E Encryption Architecture") in the App Group container, and the AutoFill extension decrypts locally with `bridge_key` → `vault_key` → entry plaintext. This pattern matches what 1Password / Bitwarden iOS do for the AutoFill hot path.

| Token | Storage | Scopes |
|-------|---------|--------|
| `access_token` | per-app Keychain (host) | `passwords:read`, `passwords:write`, `vault:unlock-data` |
| `refresh_token` | per-app Keychain (host) | — (only the host app refreshes per F18) |

Implications:
- A coresident attacker who compromises the AutoFill extension process gets no bearer credential — they can decrypt only what is already in App Group, which requires bypassing the biometric gate on `bridge_key`.
- The S13 round-2 concern (extension token has `passwords:write` and can mass-overwrite vault) is moot: the extension has no token at all.
- The DPoP key access path is internally consistent: only the host app holds the Secure Enclave key, so only the host app makes DPoP-signed requests.
- The cost: vault changes made on web/desktop are not visible to AutoFill until the host app's `BackgroundTask` resyncs the encrypted-entries cache. Acceptable for MVP; surfaced as "your iPhone may show stale entries until the app syncs" in `ios/README.md`.

A coresident attacker that compromises the AutoFill extension cannot mass-overwrite vault entries because the `passwords:write` scope is in the host-app token only, which the extension cannot read.

**iOS access token TTLs (resolves F14)**:

iOS TTLs are NOT taken from the tenant's `extensionTokenIdleTimeoutMinutes` / `extensionTokenAbsoluteTimeoutMinutes`. Making those tenant fields per-`clientKind` would require additional schema changes that this plan deliberately does not adopt; iOS TTLs are instead non-configurable hard constants in `mobile-token.ts`:

- Idle: 24 h
- Absolute: 7 days

The desktop extension's 7d/30d tenant-policy defaults assume a controlled environment, which is false on a phone. Tenants who need finer-grained iOS lifetime control fall back to the admin UI's per-session revoke (which can target `clientKind='IOS_APP'` rows specifically). Tightening the global iOS hard constants is a future enhancement, gated by demand.

**Refresh ownership (resolves F18)**:

The host app owns refresh entirely. Tokens live in the per-app Keychain (host-only) — the AutoFill extension cannot read them and does not call the server during a fill (see "Token shape"). The host app records `lastSuccessfulRefreshAt` **inside the AES-GCM-authenticated cache header** (NOT as a plaintext file in App Group — see "Encrypted-entries cache integrity"); the AutoFill extension reads this timestamp from the encrypted header AFTER the bridge-key biometric prompt and treats `now > lastSuccessfulRefreshAt + 7 days` as session-expired, falling closed with "Open passwd-sso to refresh." Storing the timestamp in the encrypted header (vs a plaintext file) prevents a coresident attacker from backdating the freshness gate.

**DPoP Conformance (resolves S18)**:

The mobile token validation path implements RFC 9449 with these pinned requirements (cite RFC 9449 §):

- §4.2 (DPoP Proof JWT): payload = `{ jti, htm, htu, iat, ath? }`. `ath` (access-token-hash, SHA-256 of access token) is REQUIRED on every protected call, not just the token endpoint — without `ath`, a stolen DPoP proof can be paired with a different access token.
- §4.3 (Server Verification): `iat` skew window ≤ 30 s (clamped both directions). `htu` must canonical-match the route's URL: scheme lowercase, host lowercase, no query/fragment, path as routed (NOT as proxied — server records its canonical URL once).
- §11.1 (jti uniqueness): server-side `jti` cache (Redis, TTL = 2 × iat skew window = 60 s, scoped per-token); duplicate `jti` within window → reject + audit.
- §8 / §9 (DPoP-Nonce): server issues `DPoP-Nonce` headers on `/api/mobile/token` and `/api/mobile/token/refresh`. Client must echo on next call. Mitigates pre-generated proofs from a brief device compromise.
- `cnf.jkt` (RFC 9449 §6): access token row stores the SHA-256 thumbprint of the DPoP public key. Every protected call's DPoP proof must contain a `jwk` whose thumbprint equals `cnf.jkt` of the bearer token.

**Why not just call `/api/extension/token`**: it requires an Auth.js session cookie inside the calling client, which the iOS app does not have. Moving the cookie inside an `ASWebAuthenticationSession` ephemeral instance and proxying back through `postMessage` is an order of magnitude more code than a redirect-based bridge code.

**Why a separate `/api/mobile/*` namespace** (vs. extending `/api/extension/*`):
- distinct scope set, distinct TTLs, distinct token validation path (DPoP)
- distinct revocation surface (admin can list "iPhone — last used X" and revoke per-`clientKind` without affecting desktop sessions)
- the new `devicePubkey` / `cnfJkt` columns are added to `ExtensionToken` (so iOS rows live alongside browser-extension rows in the same table), but the validation path branches on `clientKind` to keep the existing desktop flow byte-identical to today's behavior

### Cross-Process State Propagation (resolves F3 / F7 / S2)

The host app and AutoFill extension are separate processes. Their only sanctioned shared channels are the App Group container and the Keychain access group. The decryption of vault material in the AutoFill extension MUST require a fresh biometric prompt (otherwise the on-disk state becomes plaintext-equivalent under forensic acquisition).

**Bridge-key model** (one of two blobs per cached secret):

```
host-app process memory          shared Keychain access group        App Group container
┌─────────────────────────┐     ┌──────────────────────────────┐    ┌──────────────────────────────┐
│ master passphrase       │     │ bridge_key                    │    │ wrapped_vault_key            │
│   ↓ PBKDF2 600k         │ ─── │   - random 256-bit            │    │   = AES-256-GCM(             │
│ wrapping_key            │     │   - kSecAttr-                 │    │       bridge_key,            │
│   ↓ HKDF                │     │     AccessibleWhenUnlocked-   │    │       vault_key)             │
│ vault_key (in mem only) │     │     ThisDeviceOnly            │    │                              │
│                         │     │   - SecAccessControl:         │    │ wrapped_team_keys[]          │
│ team_key[i] (in mem)    │     │     biometryCurrentSet        │    │   = AES-256-GCM(             │
│                         │     │     (NO devicePasscode        │    │       bridge_key,            │
│                         │     │      fallback)                │    │       team_key[i])           │
│                         │     │   - Synchronizable=false      │    │                              │
└─────────────────────────┘     └──────────────────────────────┘    └──────────────────────────────┘
```

**ACL flag decision (resolves S14)**: `biometryCurrentSet` only — no `.devicePasscode` OR-fallback. The threat model the plan defends against is forensic acquisition with passcode-knowing attacker (shoulder-surf, coercion, cloud-account recovery). `.devicePasscode` would let that attacker decrypt the bridge_key. Trade-off: when biometry enrollment changes (re-enroll Face ID, add a finger), the bridge_key is invalidated by `biometryCurrentSet` — user must unlock the host app again with the master passphrase. This is acceptable because the host-app unlock is the design's primary trust gate.

**Per-fill biometric reuse (resolves S16)**: each Keychain read of `bridge_key` from the AutoFill extension uses an `LAContext` with `touchIDAuthenticationAllowableReuseDuration = 0` (passed via `kSecUseAuthenticationContext`). iOS otherwise caches biometric authorization for ~10 s for the same Keychain item; the cache would let consecutive AutoFill invocations decrypt without a fresh prompt, defeating the per-fill biometric claim. Setting the reuse window to 0 forces a fresh prompt on every fill.

**Vault key zeroing (resolves S16 cont.)**: the AutoFill extension zeroes `vault_key` after EACH `provideCredentialWithoutUserInteraction` (or `prepareCredentialList`) returns — not on `viewWillDisappear` only. iOS may serve multiple credential requests in one extension process before the system reaps it; without per-call zeroing, a debugger or heap-inspection bug could read the cached vault key.

Lifecycle:
1. **First unlock in the host app**: derive `vault_key`, generate `bridge_key` (random 256-bit), store `bridge_key` in shared Keychain access group with the access-control flags above (gated by `biometryCurrentSet`), fetch the user's full encrypted entries from `/api/passwords/*` (DPoP-signed by the host's Secure Enclave key), and write `wrapped_vault_key`, `wrapped_team_keys[]`, and the `encryptedEntries[]` cache to the App Group container.
2. **Sync (host-app)**: the **primary** refresh path is on host-app foreground — when the user opens `PasswdSSOApp`, the app refreshes the access token and re-fetches `encryptedEntries[]` immediately. A `BGTaskScheduler` BackgroundTask requests a top-up at 15-min intervals as a best-effort backstop (iOS does NOT guarantee BackgroundTask execution — under Low Power Mode, low battery, low usage, or thermal throttling, iOS may delay or drop scheduled tasks for hours). Because BackgroundTask is unreliable, the design treats foreground sync as load-bearing and BackgroundTask as opportunistic. **Functional consequence**: a user who has not opened the host app recently may see "Open passwd-sso to refresh" on the next AutoFill — this is by design (per F23), not a bug.
3. **AutoFill invocation**: extension reads `wrapped_*` blobs and `encryptedEntries[]` from App Group; reads `bridge_key` from shared Keychain (`reuseDuration = 0` triggers OS biometric prompt every fill); decrypts `vault_key` and the per-team keys it needs into process memory; filters entries by URL host (decrypting `encryptedOverview` first for matching, then `encryptedBlob` for the chosen entry); returns the credential identity to iOS; zeroes `vault_key` and seed buffers immediately on return. **The extension never makes a network call.**
4. **App-side auto-lock or logout**: host app deletes the `bridge_key` Keychain item from the shared access group. Both processes lose access to vault material until next host-app unlock. App Group blobs become useless ciphertext. (On logout, the host-app also deletes `access_token` and `refresh_token` from the per-app Keychain and clears the `encryptedEntries[]` cache; on auto-lock those are kept so the user can unlock and resume without re-signing-in.)
5. **Device reboot**: see paragraph below the lifecycle.
**Device reboot**: `WhenUnlockedThisDeviceOnly` Keychain items are preserved across reboot but become unreadable until the device is unlocked once after boot (Class A, per Apple Platform Security). After first unlock, the item is again accessible. The host app's in-memory `vault_key` is lost on reboot regardless (process killed), so the host app forces master-passphrase entry on next launch — which regenerates state (a fresh `bridge_key` overwrites the old Keychain item, fresh `wrapped_*` blobs are written to App Group, and `encryptedEntries[]` is re-fetched).

This means every AutoFill invocation requires Face ID / Touch ID (after the host app has unlocked at least once since the last reboot). The previous draft's "session snapshot in App Group" wording would have allowed silent decryption — the bridge-key model explicitly closes that.

**Authoritative "is unlocked" predicate (resolves F16)**: the canonical predicate is "`bridge_key` is readable from shared Keychain". App Group lock-state metadata is advisory ONLY and must NEVER gate decryption. The AutoFill extension's first action is `read bridge_key`; on Keychain miss, route to host app (no decryption attempt). This is robust against host-app crash mid-write: if Keychain is set but App Group blobs are missing, the extension reads the (absent) wrapped blob and fails cleanly; if App Group blobs are set but Keychain is missing, the extension surfaces the unlock prompt.

**Team-key cache invalidation triggers (resolves F17)**: 
- explicit invalidation: lock, logout, team membership change, team key rotation
- **wall-clock cap: 15 minutes** — every `wrapped_team_keys[i]` blob carries an `issued_at` timestamp; the AutoFill extension refuses to use any blob older than 15 min. This bounds the staleness window because `/api/notifications` is a poll-only endpoint (no server-push channel exists in the parent project); the host app polls notifications on its `BackgroundTask` schedule, but a phone backgrounded for hours could miss a membership-revoke push. The 15-min cap forces a host-app fetch and re-evaluation. The trade-off: an active user filling many team credentials in 15 min still sees fast biometric-only fills; a backgrounded device beyond 15 min fails gracefully to "Open passwd-sso to refresh."

This is a documented limitation: the membership-revoke window for an ex-team-member's iPhone is up to 15 min, not "instant". Acceptable for MVP; an APNs silent-push channel for membership-change events is a future enhancement.

**Encrypted-entries cache integrity (resolves S27 + F25 + F26 + S29)**:

The `encryptedEntries[]` cache and the `lastSuccessfulRefreshAt` timestamp in the App Group container need three integrity properties beyond the per-entry AES-256-GCM authentication:

1. **Bytes-identical to server wire format**: iOS persists the server-returned `encryptedBlob` / `encryptedOverview` byte-for-byte (same IV, same authTag, same AAD construction `(tenantId, entryId, version)` per `src/lib/crypto/aad.ts`). The cache is a mirror, not a re-wrap. A developer must NOT change the cache file's per-entry encoding.

2. **Rollback resistance**: each cache write produces a **cache header** containing `{ cache_version_counter: u64, cache_issued_at: timestamp (Unix epoch seconds), lastSuccessfulRefreshAt: timestamp, entry_count: u32, host_install_uuid: 128-bit }`, AES-256-GCM-encrypted under `vault_key`. The AAD includes the tuple itself **plus the `host_install_uuid` from the bridge_key_blob** so a cache produced by a previous install (different UUID) fails AAD verification regardless of counter state.

   **Byte-encoding (resolves F30)**: All multi-byte integers in both the `bridge_key_blob` and the cache header use **big-endian (network byte order)**. `host_install_uuid` is the 16-byte big-endian representation of the UUID per RFC 4122 §4.1.2. Reader and writer MUST agree on this byte order; mismatches produce silent AAD-verification failures with no debugging signal.

   The shared Keychain item (`bridge_key_blob` per Storage Contract) co-locates `bridge_key`, `cache_version_counter`, and `host_install_uuid` so the AutoFill extension does ONE Keychain read (one biometric prompt) per fill. On every cache write the host app increments the counter and rewrites the blob.

   **Write ordering (resolves F31)**: cache writes follow this strict order to make a host-app crash mid-write self-recoverable:
   1. compute new counter value `N+1`, encrypt new cache header with `N+1` and AAD
   2. atomic write of the cache file (`encryptedEntries.tmp` → fsync → `rename(2)`)
   3. ONLY after the cache rename succeeds, update the `bridge_key_blob` Keychain item to counter `N+1`
   
   If the host app crashes between steps 2 and 3, the cache file is at counter `N+1` while the Keychain blob remains at `N` → AutoFill on next fill sees `cache.counter > blob.counter`, which is treated as **stale-blob recovery** (NOT a rollback): the extension still rejects (counters don't match) AND sets the recovery flag in App Group. On next host-app foreground, the host app detects `cache.counter > blob.counter`, validates the cache header decrypts under `vault_key`, and updates the blob counter forward. This is the only direction in which `cache.counter > blob.counter` is acceptable; the reverse (`cache.counter < blob.counter`) is always a real rollback.

   **First-launch detection (resolves S33)**: iOS does NOT reliably clear shared Keychain access group items or App Group containers on uninstall — both are bound to identifiers that survive the bundle. Detection mechanism: a sentinel Keychain item `bridge_key_blob_owner_marker` is stored in the **per-app Keychain** (per-app Keychain items have been cleared on uninstall since iOS 10.3 — confirmed via Apple Developer Forums and iOS 10.3 release-notes guidance; the precise behavior must be re-verified against current Apple platform docs at implementation time as Apple does not publish a single canonical TN for this rule). On every host-app launch, the app reads the sentinel; if absent, treat as fresh install — UNCONDITIONALLY delete `bridge_key_blob` from the shared Keychain access group (delete does not require biometry), delete the App Group cache file, and re-init. The sentinel itself is regenerated post-init. **Implementer obligation**: empirically verify on the target iOS deployment range (17.x at MVP) that uninstall clears per-app Keychain items; if a future iOS version regresses this behavior, fall back to a UserDefaults-based sentinel inside the App Group container (UserDefaults inside App Group is cleared by deleting the App Group, which is part of the unconditional re-init flow).

   **`host_install_uuid` generation (resolves S36)**: generated via `SecRandomCopyBytes(kSecRandomDefault, 16, &bytes)` (matching the rigor used for PKCE state and other security-sensitive random values). NOT Swift's `UUID()` (whose underlying RNG is implementation-defined).

   **Counter seed**: on first launch, the counter is seeded to a random non-zero `u64` via `SecRandomCopyBytes` — preventing rollback-to-zero-counter precomputation attacks.

   The AutoFill extension on read:
   - reads `bridge_key_blob` from shared Keychain (single biometric op)
   - decrypts the cache header with `vault_key` (derived from `bridge_key`); AAD must match including `host_install_uuid`
   - rejects the cache if `header.cache_version_counter != bridge_key_blob.cache_version_counter` (rollback detected) — emits the rollback-rejection flag in App Group for the host app to drain on next launch (per S30); the flag is **MAC-protected (resolves S35)**: the AutoFill extension HMAC-SHA-256s the flag payload `{ expectedCounter, observedCounter, headerIssuedAt, rejectionKind }` under a key derived from `vault_key` via HKDF (info=`"rollback-flag-mac"`), so the host app can verify the flag's authenticity before posting to `/api/mobile/cache-rollback-report`. A forged flag fails MAC verification and is dropped (with a separate `MOBILE_CACHE_FLAG_FORGED` audit event); a suppressed flag (deleted by attacker) cannot be detected — accepted residual risk.
   - rejects the cache if `header.cache_issued_at > now + 30s` (clock-skew attack) or older than 1 hour AND `header.lastSuccessfulRefreshAt` older than 24 h (idle window)
   - reads timestamps EXCLUSIVELY from the encrypted header (NOT from any plaintext file in App Group) — this is a load-bearing rule for the freshness gate (resolves F29 / S31)

   A coresident attacker who restores an older `encryptedEntries[]` alone gets a stale counter; the Keychain counter is current; the comparison fails. **Acknowledged limitation**: a full encrypted-iTunes/Finder-backup restore that includes the same Keychain access group will restore both files atomically — the rollback succeeds because the restored state is internally consistent and matches a prior good moment. This is acceptable: the user's iPhone is no worse off than the moment of backup. iCloud Keychain backup excludes `*ThisDeviceOnly` items by spec, so iCloud-only restores cannot bring the counter forward — they fail the comparison correctly. Document this in `ios/README.md` under "Backup restore behavior".

3. **Atomic write**: the host app writes `encryptedEntries.tmp` first, fsyncs, then `rename(2)` to `encryptedEntries`. The reader (extension) sees either the prior committed file or the new one — never a torn write. iOS POSIX `rename(2)` is atomic on the same filesystem, which the App Group container is.

**Cache write integrity** (host-app compromise scenario): an attacker who gains code execution in the host app already has access to the in-memory `vault_key` and can produce arbitrary valid ciphertext. The cache write path is therefore not an additional compromise vector beyond the host-app process itself; AES-256-GCM authenticates ciphertext under `vault_key`, so an attacker without the host-app process cannot inject anything the AutoFill extension would decrypt.

### Shared Storage Contract (refined)

| Storage | Contents | Accessibility |
|---------|----------|---------------|
| Keychain (per-app, host) | DPoP private key, `access_token`, `refresh_token` | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, Secure Enclave for the DPoP key (`kSecAttrTokenIDSecureEnclave`), `kSecAttrSynchronizable=false` |
| Keychain (shared, both) | `bridge_key_blob` — single item containing `bridge_key` (256-bit) `\|\|` `cache_version_counter` (u64, big-endian) `\|\|` `host_install_uuid` (128-bit, RFC 4122 §4.1.2). All multi-byte integers big-endian — see "Encrypted-entries cache integrity" §. Co-located so one biometric prompt covers both reads (resolves F28). | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` + `SecAccessControlCreateWithFlags(.biometryCurrentSet)` (NO `.devicePasscode` fallback per S14), `kSecAttrAccessGroup=<TeamID>.com.passwd-sso.shared`, `kSecAttrSynchronizable=false`. Read with `kSecUseAuthenticationContext` carrying `LAContext` with `touchIDAuthenticationAllowableReuseDuration=0` — fresh prompt per fill, single item read. |
| App Group container | `wrapped_vault_key`, `wrapped_team_keys[]` (each with `issued_at`), `encryptedEntries[]` (`encryptedBlob` + `encryptedOverview` per parent E2E format), server URL, advisory lock-state metadata | unprotected file (entire content is opaque ciphertext or non-secret coordination); lock state is advisory only — see "is unlocked" predicate above |
| Process memory only | `vault_key`, decrypted entries, live TOTP codes, decrypted form context | wiped on `viewWillDisappear`, `applicationWillResignActive`, lock, logout |
| **Never persisted** | master passphrase, plaintext vault entries, plaintext TOTP seeds | — |

### Side-Channel Controls (resolves S6)

The host app and extension both implement:

- Any view that displays a password / TOTP / seed wraps the value in a `UITextField` with `isSecureTextEntry = true`.
- Observe `UIScreen.capturedDidChangeNotification`; when `UIScreen.main.isCaptured == true`, overlay a "Recording — content hidden" view across vault list and detail screens.
- On `applicationWillResignActive`, swap the key window contents for a blur view to neutralize App-Switcher snapshot leak.
- Pasteboard writes use `UIPasteboard.general.setItems([[type: value]], options: [UIPasteboard.OptionsKey.localOnly: true, UIPasteboard.OptionsKey.expirationDate: Date().addingTimeInterval(60)])`. 60 s max retention; `localOnly` blocks Universal Clipboard sync. (Note: iOS 16 changed pasteboard semantics — verify on target devices that `localOnly` still suppresses Handoff propagation; if not, fall back to skipping pasteboard for sensitive values entirely.)
- AutoFill extension never writes plaintext to the pasteboard — it returns credentials via `ASExtensionContext.completeRequest`.

### Universal Links / AASA (resolves S7 / S20 / S24 / F19)

**AASA file format** (self-hosters add this to their server at `https://<server>/.well-known/apple-app-site-association`):

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TeamID>.com.passwd-sso"],
        "components": [
          { "/": "/api/mobile/authorize/redirect", "comment": "iOS auth callback" }
        ]
      }
    ]
  }
}
```

The bundle ID is claimed **only for the auth callback path** — not for arbitrary credential-matching domains. Documented in `ios/README.md`.

**AutoFill credential matching** uses **URL host string match** (parity with the browser extension's existing logic). AASA does NOT gate credential availability per stored relying-party domain — operationally infeasible for self-hosted instances.

**Server URL TOFU (resolves S20)**:

A user pasting a malicious server URL (homograph, phishing-link-shared) into the server-URL field would have the entire ZK property collapse — the attacker mounts a complete server clone. The host app implements a TOFU (trust-on-first-use) pattern:

1. On first server URL entry, the app fetches `<server>/.well-known/apple-app-site-association` (also probes whether the server runs `passwd-sso` by hitting `/api/health/live`).
2. The app pins the AASA file's SHA-256 hash and the TLS certificate's SubjectPublicKeyInfo hash on first successful sign-in. The pinned values are stored in the per-app Keychain.
3. The vault unlock screen prominently displays the server URL (`Unlocking vault on https://my.passwd-sso.example`) so the user re-confirms the target on every unlock.
4. On AASA hash rotation or certificate-pin mismatch, the host app surfaces a hard error (Cancel / Trust New Server) — the latter requires re-entering the master passphrase, providing an additional human-in-the-loop check.

**Honest threat-model scope (resolves S28)**: TOFU pinning defends two scenarios well:
- (a) MITM on the **first** AASA / TLS fetch (a malicious server intercepts the first install — pinning catches it on subsequent rotations).
- (b) Benign legitimate operator key/cert rotation (pinning surfaces a confirmation dialog so the user knows it happened).

TOFU does **NOT** strongly defend the post-pin server-takeover scenario (a real attacker obtains the ability to MITM after the user has already pinned — DNS hijack, BGP hijack, MITM CA, lawful interception). Once the attacker is mid-stream, the master-passphrase prompt is verified against the **server-controlled verifier**, so the malicious server can accept any passphrase. The Trust-New-Server prompt is therefore meaningful UX (the user is alerted) but not a cryptographic boundary. The honest user-facing recovery against confirmed server takeover is **uninstall + reinstall**, which clears the pinned values. Document this in `ios/README.md` under "When to re-install".

**App-side AutoFill (resolves S24)**:

A malicious app with a valid AASA pointing at `victim.com` is handed the victim's credentials by the standard URL-host-match logic. The browser-extension parity argument is weak here because Safari shows a URL bar and apps do not. Mitigation:

- App-side AutoFill (non-Safari) is **opt-in per tenant**, default OFF. The tenant admin enables explicitly via tenant policy.
- For app-side fills, the credential picker shows the requesting bundle ID and forces an extra confirmation tap (label: "Fill `username` for app `bundle-id`?").
- Safari fills do not require the extra confirmation since the user can verify the URL bar.

The MVP ships with the tenant-policy column (`allowAppSideAutofill: boolean` on Tenant; default false) and the per-fill confirmation UI.

### Server-Side Changes (resolves F8 / F12 / F13 / S25)

Concrete file list — all server-side work needed for iOS MVP. **DPoP (RFC 9449) is grep-zero in the parent codebase** as of round-2 review; the DPoP infrastructure is net-new and accounts for the bulk of server-side scope.

**New (DPoP infrastructure)**:
- `src/lib/auth/dpop/verify.ts` — DPoP proof JWT parser + verifier (htm/htu/iat/jti/ath/cnf.jkt checks per RFC 9449 §4)
- `src/lib/auth/dpop/jti-cache.ts` — Redis-backed jti uniqueness cache (TTL = 60 s, scoped per-token)
- `src/lib/auth/dpop/htu-canonical.ts` — canonical URL builder for the route's expected `htu` value (handles proxy-rewriting consistency)
- `src/lib/auth/dpop/nonce.ts` — `DPoP-Nonce` issuance + acceptance for the token endpoints

**New (mobile auth endpoints)**:
- `src/app/api/mobile/authorize/route.ts` — GET handler, sets up the bridge code + state binding (server-computes redirect URI, never accepts client-supplied)
- `src/app/api/mobile/authorize/redirect/route.ts` — completion handler that issues the redirect to the Universal Link
- `src/app/api/mobile/token/route.ts` — POST handler, PKCE + bridge-code exchange + DPoP proof validation at exchange; issues a single access/refresh pair bound to the device's Secure Enclave DPoP key
- `src/app/api/mobile/token/refresh/route.ts` — POST handler, DPoP-protected refresh with rotation + replay disambiguation (5 s legitimate-retry window per S21)
- `src/lib/auth/tokens/mobile-token.ts` — iOS-specific TTL constants (idle 24 h, absolute 7 days), `validateExtensionToken` dispatch helper for `clientKind='IOS_APP'`

**New (Prisma migrations)**:
- `prisma/migrations/<ts>_extension_token_client_kind/migration.sql`:
  - Adds `clientKind` enum (`BROWSER_EXTENSION` | `IOS_APP`) — default `'BROWSER_EXTENSION'` so existing rows backfill cleanly (NOT NULL with default)
  - Adds nullable columns: `devicePubkey TEXT`, `cnfJkt TEXT` (DPoP key thumbprint), `lastUsedIp TEXT`, `lastUsedUserAgent TEXT`
  - `BROWSER_EXTENSION` rows have NULL for all four (verified by a backward-compat test)
- `prisma/migrations/<ts>_tenant_app_autofill_policy/migration.sql`:
  - Adds `Tenant.allowAppSideAutofill BOOLEAN NOT NULL DEFAULT false` (per S24)

**Modified**:
- `prisma/schema.prisma` — `ExtensionToken` model adds the 4 columns above; `Tenant` model adds `allowAppSideAutofill`
- `src/lib/constants/auth/extension-token.ts` — add `IOS_TOKEN_DEFAULT_SCOPES` (`passwords:read`, `passwords:write`, `vault:unlock-data`); single scope set since the AutoFill extension does not hold its own token
- `src/lib/auth/tokens/extension-token.ts` — `validateExtensionToken` dispatches to `mobile-token.ts` DPoP path for `clientKind='IOS_APP'`; updates `lastUsedIp` / `lastUsedUserAgent` on every validate (per S8 + S25)
- `src/app/api/sessions/route.ts` — surface `clientKind`, `lastUsedIp`, `lastUsedUserAgent` in the per-session list; per-clientKind revoke
- `src/app/api/tenant/policy/route.ts` — read/write `allowAppSideAutofill` (per S24)
- `src/lib/audit/audit.ts`, `src/lib/constants/audit/audit.ts`, `messages/{en,ja}/AuditLog.json` — add audit actions: `MOBILE_TOKEN_ISSUED`, `MOBILE_TOKEN_REFRESHED`, `MOBILE_TOKEN_REVOKED`, `MOBILE_TOKEN_REPLAY_DETECTED`, `MOBILE_CACHE_ROLLBACK_REJECTED`, `MOBILE_CACHE_FLAG_FORGED` (per S30 / S35 — the AutoFill extension cannot emit audit directly; it sets a HMAC-protected flag in App Group, the host app drains the flag on next foreground, verifies the HMAC, and posts via the new endpoint below — DPoP-signed by the host's Secure Enclave key)
- `src/app/api/mobile/cache-rollback-report/route.ts` (new — accepts the rollback-rejection report from the host app and emits the audit event with metadata `{ deviceId, expectedCounter, observedCounter, headerIssuedAt, lastSuccessfulRefreshAt, rejectionKind: 'counter_mismatch'|'header_stale'|'aad_mismatch'|'authtag_invalid'|'header_clock_skew'|'header_missing'|'entry_count_mismatch'|'header_invalid'|'flag_forged' }`). The `'flag_forged'` value (resolves T47) is reported by the host app when its drain detects a HMAC-failed flag and is mapped server-side to the `MOBILE_CACHE_FLAG_FORGED` audit action (other rejectionKind values map to `MOBILE_CACHE_ROLLBACK_REJECTED`). **Rate limit (resolves S34)**: max 5 reports per `(tenantId, deviceId)` per 24 h, falling back to per-tenant cap, to prevent audit-log flooding by a compromised host app or post-token-theft attacker. Documented in §"Server-Side Changes"; integrated with the existing rate-limit middleware.
- The `MOBILE_TOKEN_REPLAY_DETECTED` audit metadata payload is rich enough to disambiguate attack vectors (per S25): `{ devicePubkeyFingerprint, ipAddress, userAgent, replayKind: 'access_token_reuse'|'refresh_token_reuse'|'dpop_jti_reuse', sameDeviceKey: boolean, clockSkewMs }`

**Test files (co-located, per parent-repo convention)**:
- `src/app/api/mobile/authorize/route.test.ts`
- `src/app/api/mobile/authorize/redirect/route.test.ts`
- `src/app/api/mobile/token/route.test.ts`
- `src/app/api/mobile/token/refresh/route.test.ts`
- `src/app/api/mobile/cache-rollback-report/route.test.ts` (per F32 / T43 — DPoP auth required, rejects unsigned/invalid `cnf.jkt`, rate-limit per (tenantId, deviceId) enforced, accepts each `rejectionKind` enum value, rejects unknown values, audit row written with full metadata payload)
- `src/lib/auth/tokens/mobile-token.test.ts`
- `src/lib/auth/dpop/verify.test.ts`
- `src/lib/auth/dpop/jti-cache.test.ts`
- `src/__tests__/integration/extension-token-migration.test.ts` — real-DB integration: seed pre-migration `BROWSER_EXTENSION` row, run migration, assert row still validates with `clientKind='BROWSER_EXTENSION'` and other columns NULL (per T23)
- `src/__tests__/integration/cache-rollback-report-audit.test.ts` (per T43) — real-DB integration: POST a valid DPoP-signed report, assert one row in `audit_logs` with `actionType='MOBILE_CACHE_ROLLBACK_REJECTED'` and the full `{ deviceId, expectedCounter, observedCounter, headerIssuedAt, lastSuccessfulRefreshAt, rejectionKind }` metadata JSON shape

### iOS Mapping from Browser Extension

| Extension surface | iOS surface |
|-------------------|-------------|
| popup UI | `PasswdSSOApp` SwiftUI screens (login, unlock, browse, detail, settings) |
| background script (session, token refresh, vault sync) | `Shared` framework + a `BackgroundTask` in the host app ONLY: refreshes the access/refresh token, and re-fetches `encryptedEntries[]` into the App Group cache. The AutoFill extension never calls the server (per the "Token shape" subsection). |
| content script (form fill) | `ASCredentialProviderViewController` in `PasswdSSOAutofillExtension` |
| `webRequest.onCompleted` save/update | **No iOS equivalent.** Manual update inside `PasswdSSOApp` (see Non-goals) |
| WebAuthn interceptor / passkey provider | Deferred to MVP+1 — `ASAuthorizationPlatformPublicKeyCredentialProvider` |

## Implementation Steps

(Reordered so design steps precede dependent code per F11.)

1. **Confirm scope**. Re-read the Non-goals table with the team. Anything that has to ship and is not in this plan must enter the plan now, not later.

2. **Extract shared test fixtures (server-side prep work)**. Before any iOS code, extract the existing extension fixtures into JSON so iOS XCTest can consume them.
   - `extension/test/fixtures/totp-rfc6238-vectors.json` — RFC 6238 test vectors (T=59, T=1111111109, …) currently inlined in `extension/src/__tests__/lib/totp.test.ts`
   - `extension/test/fixtures/url-match-cases.json` — host-match cases currently inlined in `extension/src/__tests__/lib/url-matching.test.ts`
   - **`login-save-decisions.json` is NOT extracted** (per round-2 T14/T18): the existing background-login-save tests depend on per-test AES-GCM round-trips against a freshly-generated `CryptoKey`, which JSON cannot encode. Save/update via AutoFill is out of scope for iOS, so iOS does not need parity for this surface. The existing Vitest test stays as-is.
   - Update the URL/TOTP Vitest tests to load from JSON. **Verification (per T26)**: before extraction, run `npx vitest --reporter=json > /tmp/before.json`; after extraction, run again and diff the test-case-name set; the diff must be empty. Commit the before/after artifact in the extraction PR description.

3. **Server-side: add DPoP infrastructure + the three mobile endpoints + Prisma migrations + audit action additions**. Land this in a separate PR before iOS implementation begins. Per F13, this is closer to ~10 new files than 1; budget accordingly. Tests (each at the co-located test file path listed in "Server-Side Changes"):
   - PKCE happy path
   - PKCE mismatch → reject
   - state mismatch → reject
   - bridge-code single-use enforcement (re-use → reject under SELECT-FOR-UPDATE)
   - bridge-code TTL expiry (61 s → reject)
   - DPoP signature failure forgery cases (per T22): (a) valid JWS structure but signed with different P-256 key, (b) signature byte tampered, (c) `htm` claim mismatch (POST vs GET), (d) `htu` claim mismatch (different path), (e) `iat` claim outside skew window (>30 s past, >30 s future), (f) missing `ath` claim on protected call, (g) `cnf.jkt` mismatch with bearer token's stored thumbprint
   - DPoP-Nonce required on `/api/mobile/token` and `/api/mobile/token/refresh` (missing nonce → reject + return new nonce)
   - jti replay cache: same `jti` within 60 s → reject
   - bridge-code phishing attempt: `redirect_uri` query parameter (if attacker-supplied) is ignored — server uses self-origin
   - replay (revoked token reuse) → escalate to family revoke + audit emit with rich metadata
   - replay false-positive disambiguation (per S21): duplicate refresh request within 5 s after successful rotation, byte-identical body → returns cached new token, no family revoke
   - admin revoke of `IOS_APP`-typed token does not affect `BROWSER_EXTENSION` tokens
   - Prisma migration backward-compat (per T23): seed pre-migration `BROWSER_EXTENSION` row, run migration, assert row still validates (`clientKind='BROWSER_EXTENSION'`, other columns NULL)
   - Tenant `allowAppSideAutofill` policy: default false; admin-write surfaces in audit log

4. **Scaffold the iOS workspace**. Xcode project with two targets, `Shared` framework, `PasswdSSOTests` (XCTest unit) and `PasswdSSOUITests` (XCUITest UI) test targets. Entitlements wired:
   - `PasswdSSOApp`, `PasswdSSOAutofillExtension`: App Group + Keychain access group
   - `PasswdSSOTests`: **App Group + Keychain access group ALSO granted to the test bundle** (per T17) so the cross-process bridge-key XCTest can drive both writer and reader paths through `Shared` directly
   - `Info.plist`: `ASCredentialProviderExtensionCapabilities.ProvidesOneTimeCodes = YES`
   - README per directory documenting target responsibilities (already drafted in `ios/*/README.md`)

5. **Build the `Shared` framework**.
   - Models: `ServerConfig`, `SessionState`, `LockState`, `VaultEntrySummary`, `VaultEntryDetail`, `TeamContext`.
   - Crypto: PBKDF2/HKDF helpers (parity with `src/lib/crypto/`), AES-256-GCM wrappers, Secure-Enclave key generation/use helpers (sign-only — Secure Enclave does not support ECDH; record this constraint in code comment per S22).
   - API client: typed wrappers for `/api/mobile/*`, `/api/passwords/*`, `/api/teams/*`.
   - URL matching: ports of the extension's logic; consumes `extension/test/fixtures/url-match-cases.json` for parity tests.
   - TOTP: ports the extension's RFC 6238 implementation; consumes `extension/test/fixtures/totp-rfc6238-vectors.json`.
   - Bridge-key store: a single class that owns the `bridge_key_blob` lifecycle (create on first unlock with random `host_install_uuid` + non-zero counter seed; increment counter on every cache write; delete on lock/logout; observable for invalidation events).
   - **`BackgroundSyncCoordinator` (per T40)**: pure async function `run(session: SessionState, client: NetworkClient) -> Result<SyncReport, Error>` that performs token refresh + encryptedEntries fetch + cache rewrite. Unit-tested via XCTest with a mocked `NetworkClient`. The `BGTaskScheduler` glue (which Apple does NOT make unit-testable) is a thin wrapper that calls `BackgroundSyncCoordinator.run`; manual-test path uses LLDB `_simulateLaunchForTaskWithIdentifier` (see Manual Tests).
   - **Auto-lock timer takes a `Clock` parameter** (Swift's `ContinuousClock` / `SuspendingClock`) so `LockStateReducer` is pure over `(state, event, clock)` and tests inject a `TestClock` (per T20 — no real-clock dependency, no `sleep` in tests).

6. **Build the host-app authentication flow**.
   - Server URL setup screen.
   - `ASWebAuthenticationSession` launcher with `prefersEphemeralWebBrowserSession = true`.
   - Universal Link handler in the app delegate that resumes the session on the redirect URL.
   - PKCE generation; state generation (`SecRandomCopyBytes`); state verification on resume.
   - DPoP key generation in Secure Enclave; pubkey export for the authorize call.
   - `/api/mobile/token` exchange; persist `access_token` and `refresh_token` to per-app Keychain (DPoP key already in Secure Enclave per the Keygen step above).

7. **Build the host-app vault unlock + browse + entry cache**.
   - Unlock flow: passphrase entry → derive `vault_key` → generate fresh `bridge_key` (overwrites any prior value) → wrap `vault_key` and team keys to App Group.
   - Fetch encrypted entries from `/api/passwords/*` and `/api/teams/*/passwords` and persist `encryptedEntries[]` into the App Group container.
   - List / search / detail screens (decrypt locally from the cache).
   - TOTP display + copy with the side-channel controls applied.
   - Auto-lock timer + manual lock action; both delete the `bridge_key` Keychain item.
   - On app foreground (primary path): refresh access token and re-sync `encryptedEntries[]`. This is the load-bearing sync path. `BGTaskScheduler` registration adds a best-effort 15-min top-up; treat as opportunistic, not guaranteed (iOS may drop background work indefinitely under Low Power Mode or thermal throttling — F23).

8. **Build the AutoFill extension password support**.
   - `ASCredentialProviderViewController.prepareCredentialList(for:)` and `provideCredentialWithoutUserInteraction(for:)`.
   - Credential matching: decrypt `encryptedOverview` for each cached entry (using `vault_key` derived from `bridge_key`), filter by URL host or app's Associated Domains host.
   - Bridge-key fetch from shared Keychain (triggers biometric); decrypt only the chosen entry's `encryptedBlob` for the credential return.
   - **No network call** in the extension's hot path.
   - Locked-state fallback: present a sheet that opens the host app for unlock.

9. **Build the AutoFill extension TOTP support**.
   - `prepareOneTimeCodeCredentialList(for:)` and the corresponding completion APIs.
   - TOTP seed decrypted in process memory only for the duration of the fill; the 6-digit code returned to iOS, the seed buffer zeroed.

10. **Add the manual credential edit flow in the host app**.
   - "Edit" / "Save" inside the entry detail screen.
   - This replaces the browser-extension's save/update; document the user-visible UX in the host-app README.

11. **Wire the side-channel controls** (per "Side-Channel Controls" subsection above).

12. **Add the macOS CI job — integrated with the existing `dorny/paths-filter` orchestration** (resolves T16).
   - Modify `.github/workflows/ci.yml` (do NOT create a separate `ci-ios.yml`):
     - Add `ios` output to the existing `changes` job filter: `ios: ['ios/**', 'extension/test/fixtures/**']`
     - Add an `ios-ci` job alongside `extension-ci`, `app-ci`, etc., with `runs-on: macos-latest`, `needs: [changes]`, `if: needs.changes.outputs.ios == 'true' || needs.changes.outputs.extension == 'true'` (the second condition ensures fixture changes also run iOS tests)
     - Job runs `xcodebuild test -scheme PasswdSSOTests -destination 'platform=iOS Simulator,name=iPhone 15'`
   - **Backward-Compat Regression Contract enforcement**: the same `changes` job already gates `extension-ci`. Add a CI step in `ios-ci` that asserts each of the listed contract test paths exists (fail the build with a clear message if a path is missing — per T15 which found the previous draft listed paths that did not exist).
   - On failure, the same `xcodebuild` command can be reproduced locally.

13. **Author the manual test plan artifact** (`docs/archive/review/ios-autofill-mvp-manual-test.md` — Tier-2 per R35).

14. **Document architecture and operating assumptions**.
   - `ios/README.md` — entitlement requirements (App Group + Keychain access group), associated-domains setup for self-hosters, iOS-17 deployment target rationale, jailbreak-detection out-of-scope.
   - `README.md` (parent repo) — link to the iOS workspace + a one-paragraph "What changes for self-hosters" note (AASA file requirement).

## Testing Strategy

### Unit Tests (XCTest, on `Shared` framework)

- URL/domain matching parity — loads `url-match-cases.json`, asserts each case identically against the iOS implementation.
- TOTP generation parity — loads `totp-rfc6238-vectors.json`, asserts identical 6-digit output for each vector.
- (Save/update decision parity is NOT included — see Step 2 rationale and Non-goals; save/update via AutoFill is out of scope.)
- Token state transitions (split into two test classes per T10):
  - `ExtensionTokenStateMachineTests` — refresh / expiry / revoke / concurrent-refresh race
  - `AuthSessionStateMachineTests` — signed-out → signed-in → vault-locked → vault-unlocked → expired
- `LockStateReducerTests` — pure function tests over `(state, event, clock)` with a `TestClock`. Includes auto-lock-fires-at-boundary test with no real-clock dependency.
- Credential filtering / ranking logic.
- Personal / team vault model parsing.
- Bridge-key store — generate, persist, invalidate; mocked Keychain.
- Secure-Enclave key generation + DPoP signature happy path / failure path; mocked `SecKey*` API.
- AAD-binding parity test for team-entry decryption — `buildTeamEntryAAD(teamId, entryId)` matches `src/lib/crypto/aad.ts` server-side.
- `BackgroundSyncCoordinatorTests` (per T40) — mocked `NetworkClient` exercising token-refresh + cache-rewrite paths; happy path, network failure → reportable result, expired-refresh-token → propagates error to caller. The `BGTaskScheduler` glue itself is not unit-tested; manual exercise via LLDB documented in Manual Tests.

### Cross-Process Bridge-Key Test — split into XCTest + XCUITest (resolves T17)

Per round-2 review, an XCUITest cannot drive Keychain reads in the AutoFill extension process directly. Split the load-bearing test into:

**Part A — XCTest unit-level (`PasswdSSOTests`, links `Shared`, both entitlements granted to test bundle)**:
- Drive `BridgeKeyStore.write(...)` with vault_key + team_keys
- Drive a "extension-process-equivalent" code path (the same `BridgeKeyStore.read(...)` API the AutoFill extension uses) within the test process
- Assertions:
  - (a) After write, read returns the bridge_key
  - (b) After `BridgeKeyStore.delete()` (simulating lock), read returns `nil`
  - (c) Decrypt with the wrapped blob succeeds before lock; fails after
  - (d) `wrapped_team_keys[]` `issued_at` older than 15 min → blob refused (per F17)
- This is the cryptographic property test. It does NOT verify the OS-level biometric prompt (XCTest cannot drive Touch ID UI).

**Part B — XCUITest UI-level (`PasswdSSOUITests`, simulator + Safari)**:
- Drives Safari to a known login form
- Asserts the OS-level biometric prompt appears once per fill (UI element assertion)
- Asserts the credential picker shows expected match list

### Integration Tests (XCUITest, simulator)

- App login → unlock → fetch vault summaries (against a local test server).
- Token refresh and logout flows.
- **Team-vault four-case enumeration (resolves T19 + T27)**:
  - (a) Personal-only — entry has `entryType=PERSONAL`; only `wrapped_vault_key` consumed; team blob unused
  - (b) Team-only — entry has `teamId=A`; only `wrapped_team_keys[A]` consumed; personal blob unused
  - (c) Mixed — fill flow over a session where both personal and team-A entries return suggestions for the same host
  - (d) Cross-team isolation — `encryptedEntries[]` cache contains BOTH team-A-tagged and team-B-tagged rows AND `wrapped_team_keys[A]` and `wrapped_team_keys[B]` both present. Assert: team-B row attempted with `team_key[A]` rejects via AAD-binding (`decrypt-rejected-by-AAD`); team-A row decrypts cleanly under `team_key[A]` (cache routing is correct)
- **Cache hydration parity test (resolves T30)** — a unit test in `PasswdSSOTests` that exercises the round-trip: host-app `EntryCacheWriter.persist(entries)` produces an App Group file → extension's `EntryCacheReader.load(path)` returns byte-identical decrypted entries after `bridge_key` unwrap. Uses fixtures mirroring the parent E2E format.
- **Cache atomic-write / torn-cache test (resolves T28 + T39)** — XCTest covering three failure modes:
  - (a) `.tmp` exists but rename never occurred (process killed between fsync and rename): reader uses the committed `encryptedEntries`, ignores stray `.tmp` (assert reader does NOT pick `.tmp` as a fallback)
  - (b) `.tmp` byte-truncated mid-write: same assertion as (a)
  - (c) Note: POSIX `rename(2)` on APFS is atomic; "partial rename" is not a real failure mode (documented, not tested)
- **Cache rollback rejection test (resolves S27 + T37)** — XCTest covering two variants:
  - (i) **coresident-attacker restore**: writes cache version N, then N+1 (counter and bridge_key_blob updated), then rolls the cache file back to N. Asserts the extension rejects N (counter mismatch) and emits the `MOBILE_CACHE_ROLLBACK_REJECTED` flag in App Group
  - (ii) **iCloud-keychain-backup-restore variant**: simulate `*ThisDeviceOnly` Keychain item being absent post-restore (since iCloud Keychain excludes `*ThisDeviceOnly`). Assert the comparison fails because the bridge_key_blob is missing → routes to host-app re-unlock (correct fail-closed)
  - (iii) **encrypted-iTunes/Finder local-backup restore variant** (limitation acknowledgement, resolves T44): both files restored together → rollback succeeds by design. Positive acceptance assertion: `EntryCacheReader.load()` returns `Result.success(entries)` AND `entries.count == header.entry_count` AND `header.cache_version_counter == bridge_key_blob.cache_version_counter` (restored values match) AND a sample entry round-trips through `decrypt(encryptedBlob)` to known plaintext from the fixture. Document this is intentional acceptance, not a bug, in `ios/README.md` under "Backup restore behavior".
- **Cache header negative tests (resolves T41 + T48)** — XCTest that for each of the following the extension MUST fail closed (route to host-app re-unlock; no entry decryption) AND set the App Group rollback-rejection flag with the matching `rejectionKind`:
  - (i) header missing entirely (file too short) → `rejectionKind='header_missing'`
  - (ii) header AAD mismatch (e.g., `host_install_uuid` from a previous install) → `rejectionKind='aad_mismatch'`
  - (iii) header authTag bit-flip → `rejectionKind='authtag_invalid'`
  - (iv) header `entry_count` ≠ actual entries-array length (consistency check) → `rejectionKind='entry_count_mismatch'`
  - (v) header `cache_issued_at` > `now + 30s` (clock-skew attack) → `rejectionKind='header_clock_skew'`
  Asserting `rejectionKind` symmetry between iOS-side emission and the server-side enum (line above) prevents enum-coverage drift.
- **`RollbackFlagMACTests` (resolves T46 + S38)** — XCTest covering the HMAC-protected rollback flag end-to-end:
  - (a) `AutoFillRollbackFlagWriter.write(payload, vaultKey)` produces a flag whose `HostRollbackFlagDrain.verify(flag, vaultKey)` succeeds and returns `Result.success(payload)`
  - (b) flag with bit-flipped MAC bytes → `verify` returns `Result.failure(.forged)` (constant-time comparison must not leak — assert via timing oracle harness or by using `CryptoKit.HMAC` which provides constant-time `==`)
  - (c) flag written under a DIFFERENT `vault_key` (simulating attacker-forged) → `verify` returns `Result.failure(.forged)`
  - (d) on `.forged`, the host-app drain posts to `/api/mobile/cache-rollback-report` with `rejectionKind='flag_forged'`; integration test asserts the server emits `MOBILE_CACHE_FLAG_FORGED` audit row with the metadata
  - (e) HKDF info string `"rollback-flag-mac"` is unique — assert no collision with any other vault_key-derived key in the codebase (grep test in CI)
- **LAContext-shared dual-read test (resolves T42)** — XCTest verifies that `BridgeKeyStore.readForFill()` performs ONE `LAContext.evaluateAccessControl` invocation while reading the entire `bridge_key_blob` (single Keychain item — assert exactly one Keychain `SecItemCopyMatching` call). Prevents regression where future refactor splits bridge_key and counter into separate Keychain items, doubling biometric prompts.
- **Logout cache invalidation test (resolves T29)** — XCTest that signs in, populates cache, logs out, and asserts: App Group `encryptedEntries` file is absent or zero-length; `wrapped_vault_key` and `wrapped_team_keys[]` cleared; `bridge_key_blob` Keychain item deleted; `MOBILE_TOKEN_REVOKED` audit emitted.
- **Reinstall counter reseed test (resolves S32 + T45)** — XCTest that simulates uninstall → reinstall: per-app-Keychain sentinel is deleted (matching iOS uninstall behavior); host-app launches, detects sentinel-absent → unconditionally deletes shared `bridge_key_blob` and App Group cache → re-init generates fresh `host_install_uuid` (asserted via `SecRandomCopyBytes` mock) and non-zero random counter; **a stashed pre-reinstall cache file with the same counter value as the newly seeded counter is then placed in App Group, and the test asserts the rejection records `rejectionKind='aad_mismatch'` (NOT `counter_mismatch`)** — proves only the `host_install_uuid` rotation is what stops the attacker, defending against regressions where uuid regeneration accidentally short-circuits.

### Manual Tests (Tier-2 manual test plan artifact)

Authored as `docs/archive/review/ios-autofill-mvp-manual-test.md` before MVP sign-off, with sections:
- **Pre-conditions** — deterministic test tenant seeded via a new script `npm run db:seed:ios-mvp` (per T25 — required so manual-test results are reproducible across reviewers); test domain list (Safari + iOS simulator app for app-side fill); iPhone test device + iPhone simulator
- **Steps** — numbered, per-scenario; covers all 10 user operation scenarios
- **Expected result** — concrete (status code / log line / on-screen element)
- **Rollback** — how to clear the AutoFill provider selection / wipe the App Group container / delete the `bridge_key_blob` Keychain item AND the per-app `bridge_key_blob_owner_marker` sentinel after a failed run
- **Adversarial scenarios** (Tier-2 obligation):
  - AutoFill on a phishing host that visually mimics a saved domain (homograph) — credential picker shows the actual host
  - Malicious-app relying-party overlap (subdomain confusion) — verify the matching rule does not over-match; verify the extra-confirmation tap appears for app-side fills (per S24)
  - AutoFill while screen-recording — content-hidden overlay appears
  - AutoFill while device under MDM / supervised mode — verify behavior is unchanged
  - Forensic acquisition simulation — boot the simulator, do not unlock the host app, observe the extension cannot decrypt anything
  - **Refresh-token theft simulation (per T24)** — extract refresh token from device backup; attempt to use from a different device with a different DPoP key. Expected: `cnf.jkt` mismatch → reject + audit `MOBILE_TOKEN_REPLAY_DETECTED` with `replayKind='refresh_token_reuse'`, family revoked, host app surfaces "session revoked, sign in again."
  - **Host-app crash mid-write (per T24)** — kill host app between writing `wrapped_vault_key` and writing `bridge_key`. Expected: AutoFill extension's next attempt fails cleanly per the "is unlocked" predicate (Keychain miss → no decrypt attempt → unlock prompt); no half-state read.
  - **Bridge-key access-group rotation (per T24)** — simulate iOS bundle ID Team ID change (uninstall + reinstall under different signing identity). Expected: extension cannot read bridge_key (different access group); host app surfaces re-unlock prompt.
  - **Server URL TOFU (per S20)** — change AASA file content on the server after first sign-in; observe app surfaces "trust new server?" prompt requiring master-passphrase re-entry.
  - **Server URL phishing (per S20)** — attempt to enter a homograph server URL on first setup; observe the unlock screen prominently displays the entered URL so user can recognize the mismatch.
  - **Cache freshness window (per T34)** — add an entry on web → immediately try AutoFill on iPhone → verify entry NOT present (cache is stale) → foreground host app → confirm cache refresh runs → verify entry now present.
  - **BackgroundTask under Low Power Mode (per T35 / F23)** — enable iOS Low Power Mode → background host app for 4 h → trigger AutoFill → verify staleness handled gracefully (15-min wall-clock cap on team keys triggers fail-closed; surfaced as "Open passwd-sso to refresh" rather than silently filling stale).
  - **End-to-end host-sync → extension-fill (per T33)** — sign in → unlock → wait for or trigger sync → verify App Group cache file size > 0 → drive Safari to a fixture login form → assert credential picker shows fixture entry. Re-run after `BackgroundTask` to verify the top-up path produces the same outcome.
  - **Server-takeover recovery via uninstall + reinstall (per T38 / S28)** — sign in to server A, observe AASA + TLS pin established. Uninstall app. Reinstall. On first launch, verify: server URL field is empty, no pinned AASA hash, no pinned cert SPKI, master-passphrase challenge requires fresh sign-in. Confirms `Synchronizable=false` keeps pinned values truly local to the bundle.
  - **BGTaskScheduler exercise (per T40)** — manual-only path: drive `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.passwd-sso.cache-sync"]` via LLDB on the simulator with the host app installed; verify the BackgroundTask handler updates `lastSuccessfulRefreshAt` and rewrites the cache. (The handler logic itself is unit-testable as `BackgroundSyncCoordinator.run(session, client) → Result` — see Unit Tests.)

### Backward-Compatibility Regression Contract (resolves T2 / T15)

Any iOS-driven server change must keep these existing test files green (CI gate; PR template item). Paths are co-located with their routes per the parent-repo convention — round-2 review found the previous draft's `src/__tests__/api/extension/token/*.test.ts` paths did not exist:

- `extension/src/__tests__/api.test.ts`
- `extension/src/__tests__/background.test.ts`
- `extension/src/__tests__/lib/totp.test.ts` (after fixture extraction)
- `extension/src/__tests__/lib/url-matching.test.ts` (after fixture extraction)
- `extension/src/__tests__/background-login-save.test.ts` (no fixture extraction — see Step 2)
- `src/app/api/extension/bridge-code/route.test.ts`
- `src/app/api/extension/token/route.test.ts`
- `src/app/api/extension/token/exchange/route.test.ts`
- `src/app/api/extension/token/refresh/route.test.ts`

A PR touching `src/app/api/extension/**` or `src/lib/auth/tokens/extension-token.ts` must show this list still passes. The CI `ios-ci` job asserts each path exists (fail with a clear message if a path is missing — defends against silent path-glob no-ops per T15).

### Three-Tier Extension Test Matrix (resolves T6)

| Tier | What | Where |
|------|------|-------|
| Unit (XCTest, links `Shared`, both entitlements granted) | credential filtering / ranking pure functions, `ASPasswordCredentialIdentity` builder, URL → host normalization, lock-state read from App Group, **cross-process bridge-key cryptographic property test** (Part A above) | `PasswdSSOTests` |
| UI (XCUITest, simulator + Safari) | "extension launches while locked" — drives Safari to a known login form; biometric-prompt-presence assertion; credential-picker UI; **cross-process bridge-key UI assertion** (Part B above) | `PasswdSSOUITests` |
| Manual (real device) | third-party app login flows, real Face ID, screen-recording overlay, App-Switcher snapshot blur, refresh-token theft simulation, host-app crash mid-write, server URL TOFU | manual test plan artifact |

## Considerations & Constraints

- **iOS device roaming vs. tenant `enforceAccessRestriction` IP/CIDR gate**: a tenant policy of "only Tailscale CIDR allowed" will silently fail every iOS refresh outside the office. The plan does not loosen the policy. Tenants who want iPhone access must extend their CIDR allowlist; the iOS app surfaces a clear error message ("network policy denied refresh") so users understand the failure.
- **Self-hosters must publish AASA**: the `apple-app-site-association` file is a one-time setup item under `https://<server>/.well-known/`. Documented in `ios/README.md` with the exact JSON template (see "Universal Links / AASA" section).
- **macOS CI minutes cost**: `macos-latest` runners are billed at ~10× the Linux rate. The `dorny/paths-filter` `ios` output limits exposure to PRs that touch `ios/**` or `extension/test/fixtures/**`. Re-evaluate after the first quarter of usage.
- **Team-vault staleness window**: 15 min hard cap on cached team keys (per F17). Membership-revoke takes up to 15 min to propagate to a backgrounded iPhone; APNs silent-push for membership-change is a future enhancement.
- **Passkey support deferred** (MVP+1): `ASAuthorizationPlatformPublicKeyCredentialProvider` integration with the existing WebAuthn server flow. Required checks at that time: rpId match against `ASCredentialServiceIdentifier` host, signCount monotonic, UV=1, AAGUID handling, attestation type policy, expected origin = Universal Link origin (NOT web origin).
- **Jailbreak detection out of scope**: residual risk accepted in `ios/README.md`.
- **Refresh replay false-positive disambiguation (per S21)**: a refresh request whose token was rotated within the last 5 s and whose body is byte-identical to the prior successful refresh returns the cached new token. Any other use of a revoked token escalates to family revoke. This avoids alert fatigue from network-retry false-positives.
- **Secure Enclave key constraint (per S22)**: the DPoP private key is sign-only (`kSecAttrKeyOperationsSign`); Secure Enclave does not support ECDH key agreement. Future work that needs ECDH must use a separate non-Enclave key.
- **iOS 17.0 baseline (per F20)**: pinned because `prepareOneTimeCodeCredentialList(for:)` is iOS-17-only. iOS 16 users are excluded from the MVP entirely. Alternative — split deployment target (iOS 16 with `if #available(iOS 17.0, *)` gating only the One-Time-Codes provider registration) — was considered and deferred to MVP+1 if user-base data warrants it. Decision is recorded as a product-owner accepted constraint, not an engineering necessity.
- **Cache size soft cap (per T32 / F24)**: MVP supports up to ~5,000 entries per device cached locally. Each entry's `encryptedBlob` is roughly 1–2 KB, so the cache lands in single-digit MB for typical users. Vaults exceeding this cap are not blocked, but the extension may degrade to "Open passwd-sso for additional entries" when AutoFill needs an entry not in the cache (the host app re-prioritizes which entries to cache by `lastAccessedAt` on the next sync). Re-evaluate the cap after first-quarter usage data.

## Out of Scope

- save/update credential via the AutoFill extension (browser-extension parity gap; manual update in the host app is the iOS path)
- Magic Link sign-in on iOS (deferred to MVP+1)
- passkey provider (deferred to MVP+1)
- tenant admin UI inside the iOS app
- SCIM / directory sync workflows
- audit-log management UI on iOS
- MCP / service-account workflows on iOS
- iPad-specific layouts beyond what falls out of SwiftUI
- watchOS / widget extensions

## User Operation Scenarios (refined)

1. A user installs `PasswdSSOApp`, enters their server URL, signs in via the browser handoff, unlocks the vault, and confirms they can browse entries.
2. A user opens Safari on a standard sign-in page; the AutoFill keyboard offers a matching credential after a Face ID prompt.
3. A user opens an app sign-in form (app has Associated Domains); AutoFill offers a personal-vault credential after Face ID.
4. A user logs in to a service protected by TOTP; the iOS keyboard offers the stored one-time code (iOS 17+, fields with `.oneTimeCode` `textContentType`).
5. A user belongs to a team; AutoFill offers the team credential after Face ID, in Safari and in apps with Associated Domains.
6. A user logs in to a service with a changed password; the user opens `PasswdSSOApp` and updates the entry manually. (No AutoFill-driven save/update — see Non-goals.)
7. The vault auto-locks while Safari is open; the next AutoFill action prompts the user to unlock the host app, then resumes.
8. A user has no matching domain entry; the AutoFill keyboard shows "no suggestions" and a "Open passwd-sso" link.
9. A user is logged out or has an expired token; both the host app and the extension surface a clear "Sign in again" path.
10. A user opens an app without Associated Domains; the AutoFill keyboard shows the manual search list (documented gap, not parity-claimed).

## Open Questions (resolved / remaining)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Which auth flow first? | Resolved — `ASWebAuthenticationSession` + Universal Link + PKCE + DPoP via three new `/api/mobile/*` endpoints. |
| 2 | Is full passkey retrieval truly required for MVP? | Resolved — deferred to MVP+1 (Non-goals). |
| 3 | Do current extension-token scopes cover iOS needs? | Resolved — no. iOS uses a separate `clientKind='IOS_APP'` token type with iOS-specific scopes and TTLs. |
| 4 | How much of team-vault unlock state can safely be shared with the AutoFill extension? | Resolved — the bridge-key model wraps team keys; extension reads them only after biometric prompt. Membership change invalidates per-team blob. |

Remaining (deferred / non-blocking for MVP):
- Whether the macOS CI job needs to upgrade to a self-hosted runner (re-evaluate after first quarter).
- Whether MVP+1 should add a "Save to passwd-sso" share-sheet action before passkey support, or after.

## Files and Areas Likely to Be Updated

**iOS workspace (new)**:
- `ios/PasswdSSOApp/**`
- `ios/PasswdSSOAutofillExtension/**`
- `ios/Shared/**`
- `ios/PasswdSSOTests/**`
- `ios/PasswdSSOUITests/**`
- `ios/README.md`, `ios/PasswdSSOApp/README.md`, `ios/PasswdSSOAutofillExtension/README.md`, `ios/Shared/README.md`

**Server / parent repo (in this same plan, before iOS code)**:
- `prisma/schema.prisma` (add `clientKind`, `devicePubkey`, `cnfJkt`, `lastUsedIp`, `lastUsedUserAgent` to `ExtensionToken`; add `allowAppSideAutofill` to `Tenant`)
- `prisma/migrations/<ts>_extension_token_client_kind/migration.sql` (new — `clientKind` enum NOT NULL with default `'BROWSER_EXTENSION'`)
- `prisma/migrations/<ts>_tenant_app_autofill_policy/migration.sql` (new — `allowAppSideAutofill` BOOL default false)
- DPoP infrastructure (new):
  - `src/lib/auth/dpop/verify.ts`
  - `src/lib/auth/dpop/jti-cache.ts` (Redis-backed)
  - `src/lib/auth/dpop/htu-canonical.ts`
  - `src/lib/auth/dpop/nonce.ts`
- Mobile auth endpoints (new):
  - `src/app/api/mobile/authorize/route.ts`
  - `src/app/api/mobile/authorize/redirect/route.ts`
  - `src/app/api/mobile/token/route.ts`
  - `src/app/api/mobile/token/refresh/route.ts`
  - `src/app/api/mobile/cache-rollback-report/route.ts` (rate-limited; DPoP-signed)
- `src/lib/auth/tokens/mobile-token.ts` (new — iOS TTL constants 24h/7d, validateExtensionToken DPoP dispatch helper)
- `src/lib/auth/tokens/extension-token.ts` (modified — `validateExtensionToken` dispatches to `mobile-token.ts` for `clientKind='IOS_APP'`; updates `lastUsedIp`/`lastUsedUserAgent`)
- `src/lib/constants/auth/extension-token.ts` (modified — add `IOS_TOKEN_DEFAULT_SCOPES` (`passwords:read`, `passwords:write`, `vault:unlock-data`); single scope set since the AutoFill extension does not hold its own token)
- `src/lib/audit/audit.ts`, `src/lib/constants/audit/audit.ts` (new audit actions with rich metadata per S25)
- `messages/{en,ja}/AuditLog.json` (i18n labels for new audit actions)
- `src/app/api/sessions/route.ts` (surface `clientKind`, `lastUsedIp`, `lastUsedUserAgent`; per-clientKind revoke)
- `src/app/api/tenant/policy/route.ts` (modified — read/write `allowAppSideAutofill`)
- Co-located test files (new) per parent-repo convention:
  - `src/app/api/mobile/authorize/route.test.ts`
  - `src/app/api/mobile/authorize/redirect/route.test.ts`
  - `src/app/api/mobile/token/route.test.ts`
  - `src/app/api/mobile/token/refresh/route.test.ts`
  - `src/app/api/mobile/cache-rollback-report/route.test.ts`
  - `src/lib/auth/tokens/mobile-token.test.ts`
  - `src/lib/auth/dpop/verify.test.ts`
  - `src/lib/auth/dpop/jti-cache.test.ts`
- `src/__tests__/integration/extension-token-migration.test.ts` (new — real-DB integration test for migration backward-compat per T23)
- `src/__tests__/integration/cache-rollback-report-audit.test.ts` (new — real-DB integration test for the rollback-report end-to-end audit emission per T43)
- `extension/test/fixtures/totp-rfc6238-vectors.json` (new — extracted)
- `extension/test/fixtures/url-match-cases.json` (new — extracted)
- (`login-save-decisions.json` is NOT extracted — see Step 2 / T14 / T18)
- `extension/src/__tests__/lib/totp.test.ts`, `url-matching.test.ts` (modified — load from JSON)
- `.github/workflows/ci.yml` (modified — add `ios` output to `changes` job filter; add `ios-ci` job; do NOT create separate `ci-ios.yml`)
- `prisma/seed-ios-mvp.ts` + `package.json` script `db:seed:ios-mvp` (deterministic test-tenant seed per T25 / T31). Seed contents required for the manual-test plan: (a) ≥1 personal vault entry encrypted under a known fixture passphrase, (b) ≥1 team-A vault entry, (c) ≥1 team-B vault entry (so cross-team isolation manual scenario has data), (d) the fixture passphrase + master-key derivation parameters documented in `ios-autofill-mvp-manual-test.md`
- `README.md`, `README.ja.md` (document iOS workspace + AASA self-host requirement)
- `docs/archive/review/ios-autofill-mvp-manual-test.md` (new — Tier-2 manual test plan with adversarial scenarios per T7 + T24)

## Decisions Carried (round 3)

After round-1 and round-2 review, the plan carries the following hardened decisions:

**Auth & tokens**:
- iOS 17.0 deployment target (per F20: accepted product trade for `prepareOneTimeCodeCredentialList`)
- `ASWebAuthenticationSession` with `prefersEphemeralWebBrowserSession=true` + Universal Link + PKCE + DPoP
- Magic Link, Passkey via ephemeral webview: out of scope (Passkey deferred to MVP+1 via the host-side provider, not the ephemeral webview)
- `redirect_uri` is server-computed (NOT client-supplied) — closes the open-redirect/bridge-code-phishing vector
- bridge-code TTL = 60 s, single-use under SELECT-FOR-UPDATE; DPoP proof required at exchange
- DPoP RFC 9449 conformance: `ath` claim mandatory on every protected call, jti uniqueness cache (Redis, 60 s TTL), `cnf.jkt` thumbprint binding, `DPoP-Nonce` on token endpoints, `iat` skew ≤ 30 s
- Single access/refresh pair, host-app only; AutoFill extension has NO bearer credential and makes NO network calls (encrypted entries pre-cached in App Group by host-app `BackgroundTask`)
- iOS TTLs are non-configurable hard constants (idle 24 h, absolute 7 d) — NOT taken from tenant `extensionTokenIdle/AbsoluteTimeoutMinutes`
- Refresh ownership is HOST APP ONLY

**Cross-process state**:
- bridge-key model with `biometryCurrentSet` ONLY (NO `.devicePasscode` fallback per S14)
- `kSecUseAuthenticationContext` with `touchIDAuthenticationAllowableReuseDuration = 0` per fill (defeats 10 s biometric reuse cache)
- Keychain access classes pinned: `WhenUnlockedThisDeviceOnly`, `Synchronizable=false`, Secure Enclave for DPoP key
- Authoritative "is unlocked" predicate: `bridge_key` is readable from shared Keychain (App Group lock-state metadata is advisory only)
- Team-key cache hard wall-clock cap: 15 min (because `/api/notifications` is poll-only, not push)
- vault_key zeroed after EACH `provideCredentialWithoutUserInteraction` (not on `viewWillDisappear`)

**Out of scope (recorded)**:
- save/update via AutoFill extension (manual update via host app instead)
- Magic Link sign-in
- App-side AutoFill (non-Safari) is OPT-IN per tenant, default OFF; per-fill bundle-ID confirmation when enabled
- iCloud Keychain sync (Synchronizable=false everywhere)
- jailbreak detection

**Test infrastructure**:
- shared test fixtures extracted to JSON before iOS code (TOTP + URL only; login-save-decisions NOT extracted because crypto round-trip can't be JSON-encoded)
- cross-process bridge-key test split: XCTest unit (cryptographic property, with both entitlements granted to test bundle) + XCUITest UI (biometric prompt presence)
- macOS CI integrated into the existing `dorny/paths-filter` `changes` job (NOT a separate workflow)
- Backward-Compat Regression Contract uses co-located paths (per parent convention; previous draft's `src/__tests__/api/extension/...` paths did not exist)
- Tier-2 manual test plan with 9 adversarial scenarios (including refresh-token theft, host-app crash mid-write, server URL TOFU)
- Prisma migration backward-compat integration test (real DB, not mocked)
- Auto-lock unit tests use `TestClock` injection (no real-clock / `sleep`)

**Server URL trust**:
- TOFU pattern: AASA hash + TLS SubjectPublicKeyInfo pinned on first sign-in; rotation forces master-passphrase re-entry; unlock screen displays the server URL prominently every time

## Implementation Checklist

Generated 2026-05-02 during phase 2 (coding) Step 2-1 impact analysis. Steps 1-3 are complete (extension fixtures landed via PR #416; server-side DPoP + `/api/mobile/*` endpoints landed via PR #418; followups via PR #419-#421). This checklist covers the remaining iOS-side work (Steps 4-14).

### Files to be created (iOS workspace)

**Project generation**:

- `ios/project.yml` — XcodeGen manifest (single source of truth for the Xcode project shape; `.xcodeproj` is generated from it)
- `ios/PasswdSSO.xcodeproj/` — generated by `xcodegen generate` (committed for ease of opening; regenerable)
- `ios/Configs/Common.xcconfig` — shared build settings (deployment target 17.0, Swift 6, code-signing style)
- `ios/Configs/App.xcconfig`, `ios/Configs/AutofillExtension.xcconfig`, `ios/Configs/Shared.xcconfig` — per-target build settings

**Entitlements**:

- `ios/PasswdSSOApp/PasswdSSOApp.entitlements` — App Group `group.com.passwd-sso.shared` + Keychain access group `$(AppIdentifierPrefix)com.passwd-sso.shared`
- `ios/PasswdSSOAutofillExtension/PasswdSSOAutofillExtension.entitlements` — same App Group + Keychain access group
- `ios/PasswdSSOTests/PasswdSSOTests.entitlements` — same App Group + Keychain access group (per T17 — cross-process bridge-key XCTest needs both)

**Info.plist files**:

- `ios/PasswdSSOApp/Info.plist` — UIApplicationSceneManifest, Associated Domains placeholder for `applinks:<server>` (configured at signing time)
- `ios/PasswdSSOAutofillExtension/Info.plist` — `NSExtension.NSExtensionAttributes.ASCredentialProviderExtensionCapabilities.ProvidesOneTimeCodes = YES` (iOS 17+ TOTP path), `NSExtensionPrincipalClass`

**Stub Swift sources** (real impl in Step 5+; Step 4 only places enough to compile):

- `ios/PasswdSSOApp/PasswdSSOAppApp.swift` — `@main` SwiftUI `App` entry
- `ios/PasswdSSOApp/ContentView.swift` — placeholder
- `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift` — `ASCredentialProviderViewController` subclass with empty overrides
- `ios/Shared/Shared.swift` — framework public-API placeholder (one `public let sharedFrameworkVersion` so the framework has a non-empty surface)
- `ios/PasswdSSOTests/PasswdSSOTests.swift` — empty XCTestCase
- `ios/PasswdSSOUITests/PasswdSSOUITests.swift` — empty XCUITest

**Documentation update**:

- `ios/README.md` — add "Building locally" section: `brew install xcodegen` prerequisite, `xcodegen generate` regenerate command, `xcodebuild -scheme PasswdSSOApp test` smoke command

### Files to be modified (parent repo)

- `.github/workflows/ci.yml` — add `ios` filter to `changes` job + `ios-ci` job on `macos-latest` running `xcodebuild test` (Step 12)
- `README.md`, `README.ja.md` — link to ios workspace + AASA self-host requirement (Step 14)

### Files NOT to be touched (already landed)

- `extension/test/fixtures/totp-rfc6238-vectors.json`, `extension/test/fixtures/url-match-cases.json` (Step 2 — done in PR #416)
- `src/lib/auth/dpop/{verify,jti-cache,htu-canonical,nonce}.ts` (Step 3 — done in PR #418)
- `src/app/api/mobile/{authorize,authorize/redirect,token,token/refresh,cache-rollback-report}/route.ts` (Step 3 — done in PR #418/#420/#421)
- `src/lib/auth/tokens/mobile-token.ts`, `src/lib/auth/tokens/extension-token.ts` (Step 3 — done in PR #418/#421)
- Prisma migrations for `clientKind`/`devicePubkey`/`cnfJkt`/`allowAppSideAutofill` (Step 3 — done in PR #418)
- Audit actions `MOBILE_TOKEN_*` / `MOBILE_CACHE_*` (Step 3 — done in PR #418)
- `/api/sessions` iOS surfacing (Step 3 — done in PR #418)

### Shared utilities to reuse from parent repo (Swift parity ports)

Sub-agents implementing Step 5 (Shared framework) MUST port — not reinvent — these primitives. Parity is asserted via the shared JSON fixtures.

| Primitive | Parent source | Swift port location | Parity test |
|-----------|--------------|---------------------|-------------|
| AAD construction (length-prefixed binary, big-endian) | `src/lib/crypto/crypto-aad.ts` | `ios/Shared/Crypto/AAD.swift` | `PasswdSSOTests/AADParityTests.swift` — same scope/version/field encoding produces identical bytes |
| URL host extraction + match | `extension/src/lib/url-matching.ts` | `ios/Shared/URLMatching/URLMatcher.swift` | `PasswdSSOTests/URLMatchingTests.swift` — loads `url-match-cases.json` fixture, asserts every case |
| TOTP (RFC 6238, SHA1/256/512, 6-8 digits, 15-60 s period) | `extension/src/lib/totp.ts` | `ios/Shared/TOTP/TOTPGenerator.swift` | `PasswdSSOTests/TOTPVectorTests.swift` — loads `totp-rfc6238-vectors.json` fixture, asserts all 8 RFC vectors |
| PBKDF2 (SHA-256, 600k iters) → wrapping key | `src/lib/crypto/crypto-client.ts` | `ios/Shared/Crypto/KDF.swift` | covered by integration with server (no fixture; manual test) |
| HKDF (SHA-256, info-bound) → encryption key + auth key | `src/lib/crypto/crypto-client.ts` | `ios/Shared/Crypto/KDF.swift` | same |
| AES-256-GCM wrap/unwrap | `src/lib/crypto/envelope.ts` | `ios/Shared/Crypto/AESGCM.swift` | round-trip test in `PasswdSSOTests` |

### Patterns to follow

- **Constant-object enums** (per user CLAUDE.md): Swift uses `enum` (raw-valued) or `struct` with `static let` constants for groups of 3+ string literals. Example: audit `rejectionKind` cases mirror server `MOBILE_CACHE_*` enum values exactly — port as Swift `enum RejectionKind: String` to enforce compile-time exhaustiveness.
- **Big-endian byte order** (per plan §"Encrypted-entries cache integrity"): all multi-byte integers in `bridge_key_blob` and cache header use network byte order; Swift port uses `bigEndian` initializers explicitly, never relies on host endianness.
- **No backwards-compat shims**: this is greenfield iOS code; do not introduce v1/v2 dispatch.
- **Test-driven parity**: every primitive ported from parent has its parity test in the same commit.

### Step-level batch plan (delegation to Sonnet sub-agents per Step 2-2)

| Step | Size | Delegation |
|------|------|------------|
| 4 (workspace scaffold) | small | direct (orchestrator) — single batch, sets up tooling for downstream sub-agents |
| 5 (Shared framework: models, crypto, API client, URL match, TOTP, BridgeKeyStore, BackgroundSyncCoordinator) | large | Sonnet sub-agent (one batch — all primitives co-evolve) |
| 6 (host-app auth flow: PKCE, DPoP, ASWebAuthenticationSession, Universal Link handler, /api/mobile/token exchange) | medium | Sonnet sub-agent |
| 7 (host-app vault unlock + browse + cache write + auto-lock) | large | Sonnet sub-agent |
| 8-9 (AutoFill ext password + TOTP — single coupled batch) | medium | Sonnet sub-agent |
| 10 (host-app manual edit) | medium | Sonnet sub-agent |
| 11 (side-channel wiring) | small | direct |
| 12 (CI ios job in `.github/workflows/ci.yml`) | small | direct |
| 13 (manual test plan artifact) | small | direct |
| 14 (README updates) | small | direct |

### Step 4 specific scaffold details

**XcodeGen `project.yml` shape (canonical)**:

- `name: PasswdSSO`
- `options.deploymentTarget.iOS: "17.0"`, `options.bundleIdPrefix: com.passwd-sso`
- `options.developmentLanguage: en`, `options.usesTabs: false`
- `settings.SWIFT_VERSION: 6.0`, `settings.IPHONEOS_DEPLOYMENT_TARGET: 17.0`, `settings.CODE_SIGN_STYLE: Automatic`, `settings.DEVELOPMENT_TEAM: ""` (empty = "Sign to run locally" for simulator)
- 5 targets (see "Files to be created" above)
- `Shared` is a `framework` type; both `App` and `AutofillExtension` `dependencies` reference `Shared` with `embed: true` for App, `link: true` for extension (extensions cannot embed frameworks; extensions link to the app's embedded copy via `Shared.framework` reference)
- `PasswdSSOTests` `dependencies`: `Shared` (link); `host: PasswdSSOApp` (so test bundle inherits app entitlements)
- `PasswdSSOUITests` `dependencies`: none direct; `host: PasswdSSOApp`
- `App` target has `extensions: [PasswdSSOAutofillExtension]` so the extension is bundled

**Build verification commands** (Step 4 success criteria):

- `cd ios && xcodegen generate` exits 0
- `xcodebuild -project ios/PasswdSSO.xcodeproj -list` lists all 5 targets and 3 schemes (App, Tests, UITests)
- `xcodebuild -project ios/PasswdSSO.xcodeproj -scheme PasswdSSOApp -destination 'platform=iOS Simulator,name=iPhone 15,OS=17.2' build` succeeds (or substitute available simulator name from `xcrun simctl list`)
- `xcodebuild -project ios/PasswdSSO.xcodeproj -scheme PasswdSSOApp -destination 'platform=iOS Simulator,name=iPhone 15,OS=17.2' test` runs the empty XCTest bundle and passes

### CI / pre-PR coordination

- New `ios-ci` job in `.github/workflows/ci.yml` is a Step 12 deliverable, NOT a Step 4 deliverable; Step 4 only verifies local `xcodebuild` succeeds.
- `scripts/pre-pr.sh` is unchanged in Step 4; iOS path is gated by the `dorny/paths-filter` `ios` output added in Step 12, so a Step-4-only commit does not need to pass any new CI.
- The branch's accumulated commits land as **one PR after Step 14** per the user's PR strategy.

### Constraints carried into Step 4 (R1-R30 self-check before commit)

- **R1 (shared utility reuse)**: N/A for Step 4 — no Swift code exists yet to reuse.
- **R2 (constants hardcoded)**: deployment target `17.0`, App Group `group.com.passwd-sso.shared`, Keychain `$(AppIdentifierPrefix)com.passwd-sso.shared` MUST be defined ONCE in `Common.xcconfig` (or `project.yml` `settings`) and referenced from every target — NOT duplicated in 5 entitlements files.
- **R20 (multi-statement preservation in mechanical edits)**: `project.yml` is hand-written — no risk. After `xcodegen generate`, run `xcodebuild -list` to verify the generated `.pbxproj` parses.
- **R25 (persist/hydrate symmetry)**: N/A for Step 4 — no persisted state added.
- **RT2 (testability)**: empty XCTest bundle ships in Step 4 only as a build-graph proof; real test cases come in Step 5.
