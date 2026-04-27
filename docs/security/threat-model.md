# Threat Model (STRIDE)

This document presents a systematic STRIDE-based threat analysis for passwd-sso.

Last updated: 2026-04-28

---

## 1. Asset Inventory

| Asset | Sensitivity | Storage location |
| --- | --- | --- |
| Vault entries (passwords, notes, cards) | Critical | PostgreSQL (ciphertext only) |
| Secret key (256-bit AES) | Critical | Client memory only (never sent to server) |
| Wrapping key (derived from passphrase) | Critical | Ephemeral in client memory |
| Team symmetric key (TeamKey) | Critical | Wrapped per-member via ECDH; ciphertext in DB |
| ItemKey (per-entry key) | Critical | Wrapped by TeamKey; ciphertext in DB |
| ECDH private key | Critical | Wrapped by secretKey; ciphertext in DB |
| Recovery key | Critical | User-held (never stored on server) |
| Passphrase verifier hash | High | DB (HMAC-peppered) |
| Auth hash | High | DB (SHA-256 of HKDF-derived auth key) |
| Session tokens | High | DB + cookie |
| Extension bearer token | High | DB + chrome.storage.session (AES-256-GCM encrypted with ephemeral non-extractable key; blobs unreadable after SW restart) |
| CLI OAuth refresh token | High | DB + `$XDG_DATA_HOME/passwd-sso/credentials` (JSON, mode 0o600) |
| WebAuthn credentials | High | DB (public key + credential ID) |
| Extension passkey private keys | Critical | Encrypted in DB entry blob (AES-256-GCM, wrapped by vault secret key) |
| PRF-derived vault key | Critical | Ephemeral in client memory |
| Audit logs | Medium | PostgreSQL |
| Account salt | Low | DB (public parameter) |
| KDF parameters | Low | DB (public parameter) |

## 2. Trust Boundaries

```text
TB1: Client <-> Server
     Browser/Extension communicates with Next.js over HTTPS.
     Client performs all encrypt/decrypt; server sees ciphertext only.

TB2: Server <-> Database
     Next.js connects to PostgreSQL via TLS.
     Row Level Security (FORCE RLS) enforces tenant isolation.

TB3: Server <-> Redis
     Rate limiting and session caching.

TB4: Server <-> SAML Jackson
     BoxyHQ Jackson container provides SAML-to-OIDC bridge.
     Runs as a separate Docker container on internal network.

TB5: Extension <-> Web App
     Extension communicates with web app via extension token (Bearer).
     Token issued via Auth.js session, validated server-side per request.
     Token delivery uses window.postMessage (ISOLATED world content script).
     Because postMessage is observable by same-origin main-world scripts,
     this channel is treated as exposure-minimized but not confidentiality-isolated.

TB6: Client <-> WebAuthn Authenticator
     Browser mediates credential creation/assertion via navigator.credentials API.
     PRF extension provides vault key derivation material.

TB7: Extension Passkey Provider (MAIN world <-> content script <-> Service Worker)
     Extension intercepts navigator.credentials.get/create in the MAIN world.
     Messages cross two isolated world boundaries via postMessage (MAIN→ISOLATED)
     and chrome.runtime.sendMessage (ISOLATED→SW).
     rpId is validated against sender.tab.url at the SW boundary (not payload).
```

## 3. STRIDE Analysis

### 3.1 Spoofing

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S1: Attacker impersonates user via stolen session | TB1 | Auth.js database sessions with configurable expiry; HttpOnly Secure cookies; session invalidation on password change | Session theft via XSS (mitigated by CSP nonce + strict-dynamic) |
| S2: Attacker forges SSO assertion | TB4 | SAML signature validation by Jackson; OIDC token validation by Auth.js | Compromised IdP could issue valid tokens |
| S3: Attacker replays extension token | TB5 | Token hashed (SHA-256) before DB storage; expiry enforced; single-use refresh | Token window between issue and expiry |
| S4: Attacker spoofs WebAuthn assertion | TB6 | Origin and RP ID validation; challenge freshness; signature verification | None (WebAuthn protocol provides strong anti-spoofing) |
| S6: Malicious page spoofs rpId in passkey bridge message | TB7 | SW reads sender URL from Chrome runtime (`sender.tab.url`), not from message payload; `isSenderAuthorizedForRpId` validates rpId is a registrable suffix of page hostname | MAIN world attacker can send arbitrary postMessage payload — rpId payload is untrusted by design |
| S5: Cross-tenant data access | TB2 | FORCE ROW LEVEL SECURITY on all 52 tenant-scoped tables; tenant context via SET LOCAL | RLS bypass in 77 allowlisted files (CI-guarded) |

> **RLS enforcement**: The application runtime connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS), ensuring RLS policies are enforced in all environments including development. Migrations run as `passwd_user` (SUPERUSER) which owns the tables. The `app.bypass_rls` GUC is used by 77 allowlisted code paths for cross-tenant operations (CI-guarded by `scripts/checks/check-bypass-rls.mjs`). See [deployment guide](../operations/deployment.md) for production role setup.

### 3.2 Tampering

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1: Server modifies encrypted vault data | TB2 | AES-256-GCM provides authenticated encryption; AAD binds ciphertext to entry/user IDs | Server could delete entries (availability, not integrity) |
| T2: Attacker swaps ciphertext between entries | TB2 | AAD scopes (PV, OV, AT, IK) bind ciphertext to specific IDs; transplant detected on decrypt | None (AAD mismatch causes GCM auth failure) |
| T3: Attacker modifies KDF parameters in DB | TB2 | Client validates minimum iterations (600k for PBKDF2); kdfType validated against known values | Attacker could set iterations to minimum (600k) — acceptable floor |
| T4: Man-in-the-middle modifies API responses | TB1 | HTTPS with HSTS; CSP prevents mixed content | Compromised TLS CA |
| T5: Extension content script injection | TB5 | Content scripts use plain JS (no eval); manifest restricts host permissions | Compromised extension update (mitigated by Chrome Web Store review) |

### 3.3 Repudiation

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| R1: User denies performing sensitive action | Server | Audit log records actorId, action, IP, user-agent, timestamp for all sensitive operations; written via durable `audit_outbox` table in the same DB transaction as the originating business write, drained by `audit-outbox-worker` with exponential backoff capped at `max_attempts` (default 8); permanent failures emit an `AUDIT_OUTBOX_DEAD_LETTER` audit row + pino dead-letter log. See §5 bullet 3. | `lastError` in `AUDIT_OUTBOX_DEAD_LETTER` metadata bypasses `METADATA_BLOCKLIST` (256-char truncation; operator-diagnostics only) — scrubbing tracked as follow-up |
| R2: Admin denies modifying team membership | Server | Audit log with TEAM_MEMBER_ADD/REMOVE actions; extractRequestMeta captures IP/UA | Same as R1 |
| R3: Emergency access activation without consent | Server | Configurable waiting period; email notification on request; audit trail for approve/activate | Owner must actively monitor email |

### 3.4 Information Disclosure

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| I1: Server database breach exposes passwords | TB2 | All vault data is E2E encrypted client-side; server stores ciphertext only | Attacker with DB access sees encrypted blobs, not plaintext |
| I2: Memory dump reveals secret key | Client | Web Crypto non-extractable keys where possible; explicit zeroization on lock/unload | JavaScript GC timing is non-deterministic |
| I3: Extension persists vault key | TB5 | `token` and `vaultSecretKey` are AES-256-GCM encrypted with an ephemeral non-extractable `CryptoKey` before storage in `chrome.storage.session`; if the SW is terminated the in-memory key is lost → encrypted blobs become unreadable → user must re-authenticate | `vaultSecretKey` ciphertext persists while the browser session is active; readable only while the SW process holds the in-memory ephemeral key |
| I4: Sentry error tracking leaks sensitive data | Server | beforeSend hook recursively strips sensitive field patterns; opt-in only (no DSN = disabled) | Novel field names not matching patterns |
| I5: Side-channel timing attack on auth hash | TB1 | Auth hash comparison uses constant-time HMAC verification | PBKDF2/Argon2id timing is inherent (mitigated by rate limiting) |
| I6: Passphrase verifier reveals passphrase | TB2 | Domain-separated PBKDF2 derivation; server stores HMAC(pepper, verifierHash) | Offline brute force against verifier (mitigated by PBKDF2 cost) |

### 3.4.1 Header Trust

| Assumption | Detail | Residual risk |
| --- | --- | --- |
| XFF parsing position | `X-Forwarded-For` is parsed at a fixed trusted-proxy count (configured at deploy time). If the proxy count is misconfigured, a client-supplied XFF header can spoof the apparent source IP. | Operators must configure `TRUSTED_PROXY_COUNT` to match their reverse-proxy topology exactly. |
| Origin header presence | The proxy CSRF gate (`src/lib/proxy/csrf-gate.ts` → `src/lib/auth/session/csrf.ts:assertOrigin`) requires the `Origin` header on every cookie-bearing mutating request. A missing `Origin` is rejected with 403 (`if (!origin) return forbidden()`); cookieless / Bearer-only routes are intentionally outside this gate's scope. | A trusted server-to-server caller that deliberately sets `Origin` to the configured `APP_URL` is accepted by design. Three pre-auth, cookieless KEEP-inline `assertOrigin` exceptions remain (`/api/auth/passkey/options`, `/api/auth/passkey/options/email`, `/api/auth/passkey/verify`). |
| IP-bound rate-limit key derivation | Rate-limit keys are derived from the resolved client IP (after XFF parsing). IPv6 is bucketed at the /64 prefix to prevent subnet-rotation bypass (see D5). | Same as XFF misconfiguration above. |

### 3.5 Denial of Service

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| D1: Brute force login attempts | TB1 | Redis-backed rate limiting on auth endpoints | Distributed attacks from many IPs |
| D2: Expensive KDF computation exhausts client | Client | Argon2id parameters tuned for target hardware; fallback to PBKDF2 on resource-constrained devices | User on very low-end device gets PBKDF2 (lower security) |
| D3: Large attachment upload exhausts storage | TB1 | File size limits enforced server-side; per-user storage quotas | Quota enforcement depends on billing/admin configuration |
| D4: API abuse via extension token | TB5 | Token scope limits operations; rate limiting applies equally | Token holder can make rapid requests within scope |
| D5: IPv6 subnet rotation bypasses rate limiting | All IP-based rate limits | Rate limit keys use /64 prefix for IPv6 (treats entire subnet as one entity) | Attacker with /48 or larger allocation |
| D5a: Bearer-token caller bypasses tenant IP restriction | `/api/v1/*`, `/api/extension/*` | `checkAccessRestrictionWithAudit` in `src/lib/proxy/api-route.ts` enforces tenant `allowedCidrs` on Bearer-authenticated routes as well as session-cookie routes | Restriction only applies when `allowedCidrs` is configured; unconfigured tenants have no IP restriction on any route |
| D6: DCR endpoint abuse (mass registration) | /api/mcp/register | IP rate limit (20/hr, IPv6 /64), global cap (100 unclaimed), 24h auto-expiry | Distributed registration from many IPs |
| D7: OAuth consent form CSRF (localhost redirect) | /api/mcp/authorize | CSP `form-action` allows `http://localhost:*` and `http://127.0.0.1:*` in all environments. [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) specifies the loopback IP literal (`127.0.0.1` / `[::1]`) for native app OAuth callbacks and [§8.3](https://www.rfc-editor.org/rfc/rfc8252#section-8.3) explicitly marks `localhost` as NOT RECOMMENDED; the `localhost` form is a pragmatic accommodation for real clients (Claude Code/Desktop) that use it | XSS prerequisite; form-action alone cannot exfiltrate data without script execution |

### 3.6 Elevation of Privilege

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| E1: Regular user accesses admin functions | Server | Role-based access control; org-auth middleware validates membership and role | Logic bugs in role checks |
| E2: Team member escalates to owner role | Server | Team role changes require owner-level auth; audit logged | Compromised owner account |
| E3: Emergency access grantee exceeds granted scope | Server | Emergency access provides read-only vault export; no write access | Grantee can copy all vault data once activated |
| E4: Extension gains broader permissions than declared | TB5 | Manifest declares minimum required permissions; scope-limited bearer token | Chrome permission model is the trust anchor |

## 4. Key Mitigations Summary

| Control | Threats mitigated |
| --- | --- |
| E2E encryption (AES-256-GCM) | I1, T1 |
| AAD binding (per-scope) | T2 |
| PBKDF2 (600k) / Argon2id | I5, I6, D2 |
| Auth.js database sessions | S1 |
| WebAuthn / Passkey | S4 |
| FORCE RLS + tenant isolation | S5 |
| CSP (nonce + strict-dynamic; `form-action` localhost dev-only) | S1 (XSS mitigation), D7 |
| Rate limiting (Redis) | D1, D4 |
| Audit logging | R1, R2, R3 |
| Sentry scrubbing | I4 |
| Extension token lifecycle | S3, E4 |
| Extension session encryption (AES-256-GCM, ephemeral non-extractable key) | I3 |
| Passkey bridge rpId validation (sender.tab.url) | S6 |

## 5. Residual Risks (Accepted)

1. **Extension vault key persistence**: `token` and `vaultSecretKey` are AES-256-GCM encrypted with an ephemeral non-extractable `CryptoKey` held only in service worker memory before being written to `chrome.storage.session`. If the SW process is terminated, the in-memory key is lost and the stored ciphertext becomes permanently unreadable — re-authentication is required. Residual risk: the encrypted `vaultSecretKey` blob persists in storage while the browser session is active, but is readable only while the SW holds the in-memory ephemeral key. Bounded by browser session lifetime.

2. **JavaScript GC non-determinism**: Secret key material in JS heap cannot be reliably zeroized. Mitigated by non-extractable CryptoKey usage and explicit clearing on lock events.

3. **Audit pipeline (durable outbox)**: All application-emitted audit events flow through the durable `audit_outbox` Postgres table. `enqueueAudit*()` writes the outbox row in the same DB transaction as the originating business write, so commit atomicity guarantees no audit loss for successfully committed operations. A separate `audit-outbox-worker` process (`src/workers/audit-outbox-worker.ts`) drains pending rows, applying exponential backoff on failure capped at `max_attempts` (default 8); permanently failed rows are dead-lettered both as an `AUDIT_OUTBOX_DEAD_LETTER` audit row (via `writeDirectAuditLog()`) and via `deadLetterLogger.warn(...)` for external alerting. Worker meta-events (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_RETENTION_PURGED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_DELIVERY_DEAD_LETTER`) deliberately bypass the outbox via `writeDirectAuditLog()` to avoid R13 re-entrant dispatch loops — events about an outbox failure must not themselves require the outbox.

4. **Compromised IdP**: A compromised Google/SAML identity provider could issue valid authentication tokens. Mitigated by vault passphrase requirement (IdP compromise alone does not decrypt vault data).

5. **Offline brute force against exported data**: An attacker with a database dump can attempt offline brute force against PBKDF2/Argon2id-protected wrapping keys. Mitigated by high iteration counts and memory-hard KDF (Argon2id).
