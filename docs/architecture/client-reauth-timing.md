# Client Re-Authentication & Vault-Unlock Timing

When each client (browser extension, iOS app) forces the user to (re-)connect,
(re-)authenticate, or (re-)unlock the vault — and the token-lifetime knobs that
control how often it happens.

Two separate layers, true for every client:
- **Connection / token** = server access (bearer + DPoP). Absent ⇒ must reconnect.
- **Vault key** = E2E encryption key, derived client-side. Absent ⇒ must unlock.

Losing the token always also loses the vault key (no bearer ⇒ no `/api/vault/unlock/data`),
so a "reconnect" is always followed by a vault unlock. The reverse is no longer
true on either client: the token can now outlive the vault key across a service-worker
restart (extension) or an app relaunch (iOS) — see the Presence model below.

---

## Presence model (shared by extension and iOS)

Both clients' token families expire on the same rule (`docs/archive/review/long-lived-client-login-plan.md`
C2–C4): `expiresAt = min(now + idle, presenceAt + idle, familyCreatedAt + absolute)`
(`computeClientTokenExpiry`, `src/lib/auth/tokens/client-token-expiry.ts`).

- **Presence** = the timestamp of the last successful `POST /api/vault/unlock/verify`
  call — a server-side resubmission of the same `authHash` used by
  `/api/vault/unlock`, proving the client still knows the passphrase (or, on iOS,
  the biometric-cached equivalent). Presence is per token **family**
  (`getFamilyPresenceAt` = `MAX(lastPresenceAt)` across every row of the family,
  falling back to `familyCreatedAt` if none was ever recorded).
- **Idle timeout** — `Tenant.extensionTokenIdleTimeoutMinutes` (default 7 d).
  A family goes stale `idle` after the **last verified unlock**, not after the
  last refresh. Refreshing the token on a schedule, with no unlock in between,
  does **not** keep a family alive past `idle`.
- **Absolute timeout** — `Tenant.extensionTokenAbsoluteTimeoutMinutes`
  (default 30 d), measured from `familyCreatedAt`. Rotation never resets it.
- Both fields are shared verbatim between the browser extension and iOS
  (no separate iOS field) — a tenant that tightens/loosens one tightens/loosens
  both clients.
- A wrong `authHash` on this route never trips account lockout and is
  rate-limited per token family instead (5 / 5 min) — see
  `docs/security/session-timeout-design.md` and the monitoring note below.

---

## Browser extension

### State machine

`extension/src/popup/App.tsx` shows the **Connect button** (`LoginPrompt`, state
`not_logged_in`) exactly when `GET_STATUS` returns `hasToken: false`, or when the
user clicks Disconnect. Everything below is a way the SW's `currentToken` becomes
null.

### Every case the Connect button appears

| # | Case | Trigger | `disconnectReason` | Frequency |
|---|------|---------|--------------------|-----------|
| a | First install / never connected | no stored session on first popup open | — (generic) | once per install |
| b | **Token idle expiry (7 days since last verified unlock)** | `ALARM_TOKEN_TTL`, or lazy expiry check in `GET_STATUS`/`GET_TOKEN` | `EXPIRED` | rare for an active user — every real unlock resets it |
| c | **Absolute family cap (30 days from first issuance)** | refresh rejected (401) once family age > absolute timeout | `REVOKED` | ~monthly regardless of activity |
| d | Server-side revocation | refresh 401/403/404 — signed out elsewhere, admin revoke, passkey re-auth required, device deregister | `REVOKED` | moderate |
| e | Browser restart, or extension reload/update | `chrome.storage.session` is cleared on browser close and on extension reload/update — the token does not persist across either | `EXPIRED` (lazy check finds nothing) | on browser/extension restart only |
| f | Vault timeout + LOGOUT action | `ALARM_VAULT_LOCK` + effective action is `LOGOUT` — either the local `vaultTimeoutAction` setting or a tenant `requireVaultTimeoutLogout` override | `TIMEOUT_LOGOUT` | low (opt-in, or tenant-mandated) |
| g | User disconnects | popup Disconnect (`CLEAR_TOKEN`) | `MANUAL` | on demand |
| h | DPoP key mismatch | persisted `cnfJkt` ≠ IDB DPoP thumbprint — DPoP-key reset (e.g. via the Options page) | — (generic) | rare |
| i | DPoP key unavailable | `getDpopThumbprint()` throws (IDB corruption, browser restriction) | — (generic) | rare |

**What changed from the previous model:** a plain service-worker restart —
Chrome terminating an idle SW and waking it again on the next event — is no
longer a reconnect trigger. `hydrateFromSession()` restores `currentToken` from
`chrome.storage.session` (plain text; C11) and re-arms the refresh/TTL alarms.
Only case (e) — a full browser restart or an extension reload/update, both of
which clear `chrome.storage.session` outright — still forces Connect. This was
the single biggest source of the "Connect appears after every SW wake" friction
before this change.

The **vault key does not** survive an SW restart: `vaultSecretKey` is still
AES-256-GCM-wrapped under an ephemeral, non-extractable `CryptoKey` that lives
only in SW memory and is regenerated on every SW startup. `hydrateFromSession()`
always fails to decrypt it after a restart, so the popup shows the **unlock
screen** (passphrase prompt), not Connect — the connection survives, the vault
re-locks. The extension has **no biometric / quick re-unlock**; every re-unlock
is a passphrase prompt.

### Presence proof on unlock

After a successful **local** unlock (the GCM/artifact check against the locally
held verification data already proved the passphrase), the background computes
`authHash` (`deriveAuthKeyBytes` + `computeAuthHash`, `extension/src/lib/crypto.ts`,
byte-identical to the web client) and calls `POST /api/vault/unlock/verify`
(`recordUnlockPresence()`). This call is **fire-and-forget and never blocks or
fails the local unlock**:

| Response | Handling |
|----------|----------|
| `200` | presence recorded silently |
| `422 AUTH_HASH_MISMATCH` | logged (`vault-unlock-verify-mismatch`); non-blocking |
| `401` (token/DPoP layer) | logged (`vault-unlock-verify-token-failure`) |
| `403 ACCOUNT_LOCKED` | logged (`vault-unlock-verify-account-locked`) |
| `429` | logged (`vault-unlock-verify-rate-limited`) |
| network error | logged (`vault-unlock-verify-network-error`) |

A verify failure only means presence was not recorded this time — it never
undoes the local unlock, and the idle clock is only extended on the next
successful call.

### Auto-lock is an inactivity timer (C6)

Vault auto-lock (`ALARM_VAULT_LOCK`) is re-armed by `registerActivity()` on user
activity, debounced to at most once per 30 s. Counted activity: messages from
extension pages (popup, options), `chrome.commands` events, context-menu
clicks, and content-script fill/copy requests gated on a trusted user gesture
(`event.isTrusted`). The offscreen keepalive ping and any page-originated,
non-`isTrusted` message do **not** count — an unattended tab cannot keep the
vault unlocked. Effective lock action = `LOGOUT` if the tenant sets
`requireVaultTimeoutLogout`, else the user's local `vaultTimeoutAction`
(`getEffectiveVaultTimeoutAction()`); the tenant flag disables the local
selector in the Options UI.

### Token-lifetime knobs

Tenant-configurable (`src/lib/validations/common.ts`):

- **Idle TTL** — default **7 days** (`extensionTokenIdleTimeoutMinutes`).
  Redefined by this change: the clock resets only on a **server-verified vault
  unlock** (presence, above), not on every background refresh. Drives case (b).
- **Absolute TTL** — default **30 days** (`extensionTokenAbsoluteTimeoutMinutes`).
  Family expires this long after first issuance regardless of unlocks or
  refreshes; enforced in `/api/extension/token/refresh/route.ts`. Drives case (c).
- **Refresh cadence** — alarm ~2 min before expiry (adaptive half-life clamp for
  short TTLs), `extension/src/background/index.ts` `scheduleRefreshAlarm()`.
- **Refresh no longer needs a web session** (FR1/C5): the refresh route dropped
  its `prisma.session` lookup; the tenant is resolved from the token row itself,
  so signing out of the web app (single session, not "everywhere") no longer
  affects the extension's connection.

---

## iOS app

iOS is architecturally different — and, with presence-based idle now enforced
on both, no longer the more lenient of the two on the absolute axis, though it
remains far lighter on unlock friction thanks to Face ID.

### Auth & token

- **OAuth 2.1 PKCE + DPoP** (RFC 9449) via `ASWebAuthenticationSession`, custom
  scheme `passwd-sso://` (`ios/PasswdSSOApp/Auth/AuthCoordinator.swift`).
- Tokens (`accessToken` + `refreshToken` + `expiresAt`) in **per-app Keychain**
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) — `ios/Shared/Storage/HostTokenStore.swift`.
- **Access token TTL** = fixed **24 h** code constant (`IOS_ACCESS_TOKEN_TTL_MS`,
  `src/lib/auth/tokens/mobile-token.ts`) — not tenant-configurable, and further
  capped so it can never outlive the refresh row's own C3-computed expiry.
  Proactive refresh 60 s before expiry (`MobileAPIClient.validAccessToken()`).
- **Refresh-row / family lifetime is bounded by the SAME tenant fields the
  extension uses** — `extensionTokenIdleTimeoutMinutes` (idle from the last
  server-verified unlock, default 7 d) and `extensionTokenAbsoluteTimeoutMinutes`
  (absolute from family creation, default 30 d). `refreshIosToken()` enforces
  both on every refresh, revoking the family (`EXTENSION_TOKEN_FAMILY_REVOKED`,
  `metadata.reason = "presence_expired"` or `"family_expired"`) when exceeded.

> Corrects two prior inaccuracies in this document: iOS access tokens were
> never "~1 hour" (24 h since introduction), and iOS previously had **no**
> tenant-configurable idle timeout at all — only an unenforced 24 h idle
> constant and a hardcoded 7-day absolute cap. Both axes now match the
> extension's tenant policy, with the idle/absolute defaults **swapped**
> relative to the old iOS constants (idle 7 d / absolute 30 d, same as the
> extension).

### Vault unlock and presence (Face ID / Touch ID)

- **Biometric (Face ID / Touch ID) re-unlock is built in** (`VaultUnlocker.swift`):
  a bridge key persisted wrapped in Keychain (`biometryCurrentSet`) lets the
  user re-unlock with biometrics — no passphrase, no network required for the
  *local* unlock. First unlock is passphrase (PBKDF2 600k); subsequent unlocks
  are biometric.
- **Every unlock — passphrase or biometric — also re-proves server presence.**
  On passphrase unlock, the app derives `authHash` and wraps it under the same
  biometric-gated bridge key (`WrappedKeyStore.saveAuthHash`). On biometric
  unlock, it unwraps that cached `authHash` in the same `LAContext` evaluation
  (no second prompt) and calls `MobileAPIClient.verifyUnlock(authHash:)` →
  `POST /api/vault/unlock/verify` (`recordPresence()` in
  `ios/PasswdSSOApp/Vault/PresenceRecorder.swift`), best-effort:
  - `200` → presence recorded; nothing else happens.
  - `422 AUTH_HASH_MISMATCH` → the cached `authHash` is deleted
    (`WrappedKeyStore.deleteAuthHash`) so a later biometric unlock does not
    keep re-presenting a hash the server now rejects.
  - Any thrown error (401-ladder exhaustion, network failure, `429`,
    `ACCOUNT_LOCKED`) leaves the cache untouched — presence just was not
    confirmed this time; the next unlock retries. The vault unlocks locally
    regardless of the outcome.
- **Consequence for a daily Face ID user:** because a biometric unlock records
  presence exactly like a passphrase unlock, `idle` effectively never expires
  under daily use. The **absolute cap** (`extensionTokenAbsoluteTimeoutMinutes`,
  default 30 d, measured from family creation and never reset by rotation) is
  therefore the real re-authentication ceiling for such a user, not the idle
  timeout — plan §FR4/C12.

### Auto-lock

- Default **15 min** idle timer (`AutoLockService`), user-configurable via the
  Settings picker between **5 and 60 minutes** (`AppSettingsStore.minMinutes` /
  `.maxMinutes`) — a prior version of this document said "1–1440 configurable";
  1–1440 (`AutoLockLimits.floorMinutes`/`.maxMinutes`) is the internal clamp
  used when a *tenant* enforces a value outside the user picker's range, not
  the picker's own bounds.
- Action: `.lock` (default) or `.logout`; `requireVaultTimeoutLogout` (tenant)
  forces `.logout` regardless of the local setting (`AutoLockService.timeoutAction`
  getter), mirroring the extension's C10 override.

### When iOS forces re-auth / re-unlock

| Trigger | Result |
|---------|--------|
| Cold launch, first run | Setup screen (server URL) |
| Cold launch, returning user | **Face ID / passphrase unlock** (no separate "connect") |
| Cold launch, token expired but offline | Face ID unlock against cached vault; sync retries online; presence not recorded until online |
| Refresh fails: presence/absolute expired, or dead session | "Sign in again" (OAuth) |
| Idle timeout (15 min default) | Lock screen → Face ID / passphrase re-unlock (each re-unlock also re-proves presence) |
| Backgrounding | Idle timer continues; re-unlock if timeout elapsed |
| Idle logout (local `.logout` action or tenant `requireVaultTimeoutLogout`) | Sign-in screen (tokens cleared) |
| Logout button | Setup screen (everything cleared) |
| Biometric cancel/fail | Silent fallback to passphrase (no forced re-sign-in) |

### AutoFill credential-provider extension (separate process)

Independent biometric gate per fill; mints its own short-lived upload token
(`AutofillTokenRefresher.swift`), re-minted on app foreground, cleared on lock.
Cannot see the host app's DPoP key, access token, or cached `authHash`.

### Demo Mode

App Store review only: fully in-memory, no server / OAuth / tokens / Keychain.
Does not affect the real timing picture.

---

## Cross-client comparison

| Aspect | Browser extension | iOS app |
|--------|-------------------|---------|
| Auth | OAuth + refresh-token-family, DPoP (IDB key) | OAuth 2.1 PKCE + DPoP (Secure Enclave key) |
| Family idle / absolute | presence idle **7 d** + absolute **30 d** (tenant policy) | same tenant fields: presence idle **7 d** + absolute **30 d** |
| Access-token-layer TTL | none (single row = the family row, no separate access/refresh split) | fixed **24 h** access row, refreshed automatically |
| Presence proof | passphrase-only, every unlock | passphrase OR Face ID/Touch ID, every unlock |
| Refresh | ~2 min before expiry, no web session required | 60 s before expiry |
| "Reconnect" trigger | browser restart / extension reload-update / idle-or-absolute expiry / revoke / manual | refresh failure at idle-or-absolute expiry / dead session (rare under daily Face ID use) |
| Token survives SW/process restart | **yes**, plain in `chrome.storage.session`, until browser close | n/a — Keychain-backed, survives app relaunch by design |
| Vault re-unlock | **passphrase only** (no biometric) | **Face ID / Touch ID** after first unlock |
| Idle auto-lock | inactivity timer (tenant policy or local; activity-driven) | 15 min default, 5–60 min user range |
| Offline unlock | cached data only | biometric + cached vault; presence not recorded until online |

**Takeaway:** the extension no longer loses its connection on every SW wake
(the main pre-existing friction source), but still has no quick re-unlock —
every re-unlock, local or presence-proving, is a passphrase prompt. iOS keeps
its Face ID advantage and, because Face ID now also proves presence, a daily
iOS user is bounded only by the 30-day absolute cap rather than any idle timer.

---

## Levers to reduce extension friction

### Lever 1+2 — raise the token TTLs (already a tenant policy; NO code change)

The idle TTL (case b) and absolute TTL (case c) are **tenant security policy**, not
hardcoded constants. A tenant admin can already adjust both from
**Settings → Security → session/extension-token policy**:

- API: `GET`/`PUT /api/tenant/policy` accepts `extensionTokenIdleTimeoutMinutes` and
  `extensionTokenAbsoluteTimeoutMinutes` ([route.ts](../../src/app/api/tenant/policy/route.ts), validated).
- UI: [tenant-session-policy-card.tsx](../../src/components/settings/security/tenant-session-policy-card.tsx).
- Schema defaults: `extension_token_idle_timeout_minutes` **10080 (7d)**,
  `extension_token_absolute_timeout_minutes` **43200 (30d)** ([schema.prisma](../../prisma/schema.prisma)).
- Allowed range: **5 min – 30 days** for each (`EXTENSION_TOKEN_*_TIMEOUT_MIN/MAX` in
  `src/lib/validations/common.ts`). Both fields now also govern iOS (see above) —
  raising or lowering either changes both clients' family lifetime.

So a tenant that finds either client reconnects too often **raises its own idle
TTL** (up to 30 days) — no code change, no new crypto. The security trade-off is
the tenant's to make: a longer-lived token = larger leak window, **mitigated by
DPoP sender-binding** (a stolen token is unusable without the non-exportable
device key). The absolute TTL is the "force periodic re-auth" knob; loosening
it is a deliberate policy choice.

> Do NOT raise the *default* (7d/30d) in code — that would silently relax every
> tenant's baseline. The conservative default is correct; per-tenant relaxation
> is the intended path.

### Levers rejected / not recommended

- **E2b — persist the extension token across a full browser restart** (case e)
  was considered and **rejected** (plan D4): the only way to survive a browser
  restart is a disk-backed store (`chrome.storage.local` or IndexedDB), and
  IndexedDB is **not OS-protected** the way the OS-level cookie jar is — a
  stolen disk image would recover a long-lived bearer credential outright.
  `chrome.storage.session` (memory-backed, cleared on browser close) was kept
  as the only persistence layer; only the vault key needed the additional
  ephemeral-key wrapping (it must not even survive an SW restart). No owner;
  not revisited without a materially different storage primitive.
- **Biometric / quick vault re-unlock in the extension (WebAuthn PRF)** —
  reviewed and still **No-Go** on trust-boundary grounds: the extension has no
  equivalent of iOS's Secure-Enclave-backed bridge key, and a PRF-derived
  unlock key would need to live somewhere a compromised extension context (or
  a malicious sibling extension with overlapping permissions) could reach. See
  the dedicated No-Go review,
  `docs/archive/review/extension-prf-vault-autounlock-plan.md`. Heavy; would
  only help PRF-capable authenticator users; not recommended.

**Recommendation:** the SW-restart reconnect case (this change's main target)
is closed. The remaining friction — no quick extension re-unlock, and a full
reconnect after a browser restart or extension update — has no code-level fix
that does not weaken the fail-secure design (E2b) or open a new trust boundary
(PRF). A tenant that still finds the extension reconnects too often should
raise its own idle/absolute TTL (lever 1/2); each avoided reconnect also avoids
a vault unlock, which is the user's actual pain.
