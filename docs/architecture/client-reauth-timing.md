# Client Re-Authentication & Vault-Unlock Timing

When each client (browser extension, iOS app) forces the user to (re-)connect,
(re-)authenticate, or (re-)unlock the vault — and the token-lifetime knobs that
control how often it happens.

Two separate layers, true for every client:
- **Connection / token** = server access (bearer + DPoP). Absent ⇒ must reconnect.
- **Vault key** = E2E encryption key, derived client-side. Absent ⇒ must unlock.

Losing the token always also loses the vault key (no bearer ⇒ no `/api/vault/unlock/data`),
so a "reconnect" is always followed by a vault unlock.

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
| b | **Token idle expiry (7 days)** | `ALARM_TOKEN_TTL`, or lazy expiry check in `GET_STATUS`/`GET_TOKEN` | `EXPIRED` | **most common** |
| c | **Absolute family cap (30 days)** | refresh rejected (401) once family age > absolute timeout | `REVOKED` | ~monthly even for daily users |
| d | Server-side revocation | refresh 401/403/404 — signed out elsewhere, admin revoke, passkey re-auth required, device deregister | `REVOKED` | moderate |
| e | SW restart + token already expired | SW wakes after long idle; `hydrateFromSession` finds stored session past `expiresAt` | `EXPIRED` | moderate |
| f | Vault timeout + LOGOUT action | `ALARM_VAULT_LOCK` + `cachedVaultTimeoutAction === LOGOUT` | `TIMEOUT_LOGOUT` | low (opt-in) |
| g | User disconnects | popup Disconnect (`CLEAR_TOKEN`) | `MANUAL` | on demand |
| h | DPoP key mismatch | persisted `cnfJkt` ≠ IDB DPoP thumbprint — DPoP-key reset, or **extension reload** losing the in-memory ephemeral wrapping key (stored session becomes unreadable) | — (generic) | every extension reload |
| i | DPoP key unavailable | `getDpopThumbprint()` throws (IDB corruption, browser restriction) | — (generic) | rare |

Cases (e) and (h) are the "after reloading the extension, Connect appears"
symptom. The extension has **no biometric / quick re-unlock** — every reconnect
ends in a passphrase prompt (the friction PR #620 reduced by at least not
forcing the *vault* passphrase just to authorize the connection).

### Token-lifetime knobs

Defined in `src/lib/validations/common.ts` (~L211-213), per-tenant configurable:

- **Idle TTL** — default **7 days** (`extensionTokenIdleTimeoutMinutes`). Reset by
  each successful refresh. Drives case (b).
- **Absolute TTL** — default **30 days** (`extensionTokenAbsoluteTimeoutMinutes`).
  Family expires this long after first issuance regardless of refreshes; enforced
  in `/api/extension/token/refresh/route.ts` (~L97-107). Drives case (c).
- **Refresh cadence** — alarm ~2 min before expiry (adaptive half-life clamp for
  short TTLs), `extension/src/background/index.ts` (~L553-569).

---

## iOS app

iOS is architecturally different — and notably **lighter** on re-auth friction
than the extension.

### Auth & token

- **OAuth 2.1 PKCE + DPoP** (RFC 9449) via `ASWebAuthenticationSession`, custom
  scheme `passwd-sso://` (`ios/PasswdSSOApp/Auth/AuthCoordinator.swift`).
- Tokens (`accessToken` + `refreshToken` + `expiresAt`) in **per-app Keychain**
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) — `ios/Shared/Storage/HostTokenStore.swift`.
- **Access token TTL** = server-issued `expiresIn` (typically ~1 hour). Proactive
  refresh **60 s before expiry** (`MobileAPIClient.validAccessToken()` ~L665-726).
- **No 7-day idle or 30-day absolute cap** like the extension — only the server
  TTL + refresh. Connection effectively persists as long as the refresh token is
  valid server-side.

### Vault unlock (the key difference)

- **Biometric (Face ID / Touch ID) re-unlock is built in** (`VaultUnlocker.swift`
  ~L209-272): a bridge key persisted wrapped in Keychain lets the user re-unlock
  with biometrics — **no passphrase, no network**. First unlock is passphrase
  (PBKDF2 600k); subsequent unlocks are biometric.
- **Auto-lock**: idle timeout default **15 min** (1–1440 configurable + tenant
  override), action `.lock` (default) or `.logout` — `AutoLockService.swift`.

### When iOS forces re-auth / re-unlock

| Trigger | Result |
|---------|--------|
| Cold launch, first run | Setup screen (server URL) |
| Cold launch, returning user | **Face ID / passphrase unlock** (no separate "connect") |
| Cold launch, token expired but offline | Face ID unlock against cached vault; sync retries online |
| Cold launch, refresh fails (dead session) | "Sign in again" (OAuth) OR local biometric unlock |
| Idle timeout (15 min default) | Lock screen → Face ID / passphrase re-unlock |
| Backgrounding | Idle timer continues; re-unlock if timeout elapsed |
| Idle logout (tenant policy = logout) | Sign-in screen (tokens cleared) |
| Logout button | Setup screen (everything cleared) |
| Biometric cancel/fail | Silent fallback to passphrase (no forced re-sign-in) |

### AutoFill credential-provider extension (separate process)

Independent biometric gate per fill; mints its own short-lived upload token
(`AutofillTokenRefresher.swift`), re-minted on app foreground, cleared on lock.
Cannot see the host app's DPoP key or access token.

### Demo Mode

App Store review only: fully in-memory, no server / OAuth / tokens / Keychain.
Does not affect the real timing picture.

---

## Cross-client comparison

| Aspect | Browser extension | iOS app |
|--------|-------------------|---------|
| Auth | OAuth + refresh-token-family | OAuth 2.1 PKCE + DPoP |
| Access token TTL | idle **7 days** + absolute **30 days** | server `expiresIn` (~1 h) + refresh |
| Refresh | ~2 min before expiry | 60 s before expiry |
| "Reconnect" trigger | 7-day idle / 30-day cap / SW reload / revoke / manual | refresh-token death (rare) |
| Vault re-unlock | **passphrase only** (no biometric) | **Face ID / Touch ID** after first unlock |
| Idle auto-lock | vault-lock alarm (tenant policy) | 15 min default |
| Offline unlock | cached data only | biometric + cached vault |

**Takeaway:** the extension is the friction outlier — it both reconnects more
often (7-day idle / 30-day cap / reload-loses-token) AND has no quick re-unlock
(passphrase every time). iOS reconnects rarely and re-unlocks with biometrics.

---

## Levers to reduce extension friction

### Lever 1+2 — raise the token TTLs (already a tenant policy; NO code change)

The idle TTL (case b) and absolute TTL (case c) are **tenant security policy**, not
hardcoded constants. A tenant admin can already adjust both from
**Settings → Security → session/extension-token policy**:

- API: `GET`/`PUT /api/tenant/policy` accepts `extensionTokenIdleTimeoutMinutes` and
  `extensionTokenAbsoluteTimeoutMinutes` ([route.ts](../../src/app/api/tenant/policy/route.ts) ~L203-204, validated).
- UI: [tenant-session-policy-card.tsx](../../src/components/settings/security/tenant-session-policy-card.tsx) (~L97-98, 234-235).
- Schema defaults: `extension_token_idle_timeout_minutes` **10080 (7d)**,
  `extension_token_absolute_timeout_minutes` **43200 (30d)** ([schema.prisma](../../prisma/schema.prisma) ~L501-502).
- Allowed range: **5 min – 30 days** for each (`EXTENSION_TOKEN_*_TIMEOUT_MIN/MAX` in
  `src/lib/validations/common.ts` ~L195-198). Token issuance reads the tenant value and
  falls back to the default when unset (`src/lib/auth/tokens/extension-token.ts` ~L212).

So a tenant that finds the extension reconnects too often **raises its own idle TTL**
(up to 30 days) — no code change, no new crypto. The security trade-off is the tenant's
to make: a longer-lived token = larger leak window, **mitigated by DPoP sender-binding**
(a stolen token is unusable without the non-exportable IDB DPoP key). The absolute TTL is
the "force periodic re-auth" knob; loosening it is a deliberate policy choice.

> Do NOT raise the *default* (7d/30d) in code — that would silently relax every tenant's
> baseline. The conservative default is correct; per-tenant relaxation is the intended path.

### Levers NOT recommended

3. **Survive extension reload** (cases e, h) — would require persisting a recoverable
   wrapping key, which **weakens fail-secure** (today a stolen disk image cannot recover
   the token). NOT recommended.
4. **Biometric / quick vault re-unlock in the extension** — closes the iOS gap, but the
   extension has no equivalent of the iOS Secure-Enclave-backed bridge key; would need
   WebAuthn PRF (see the No-Go review of PRF auto-unlock,
   `docs/archive/review/extension-prf-vault-autounlock-plan.md`). Heavy; PRF users only;
   reviewed No-Go on trust-boundary grounds.

**Recommendation:** there is **no code change to make** for the "extension reconnects too
often" complaint — it is a tenant-policy adjustment (lever 1/2, already shipped). A tenant
raises its extension-token idle TTL to taste. Each avoided reconnect also avoids a vault
unlock, which is the user's actual pain. The heavier options (3/4) fight the fail-secure
design and are not recommended.
