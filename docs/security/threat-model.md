# Threat Model (STRIDE)

This document presents a systematic STRIDE-based threat analysis for passwd-sso.

Last updated: 2026-03-07

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
| Extension bearer token | High | DB + chrome.storage.session |
| WebAuthn credentials | High | DB (public key + credential ID) |
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

TB6: Client <-> WebAuthn Authenticator
     Browser mediates credential creation/assertion via navigator.credentials API.
     PRF extension provides vault key derivation material.
```

## 3. STRIDE Analysis

### 3.1 Spoofing

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S1: Attacker impersonates user via stolen session | TB1 | Auth.js database sessions with configurable expiry; HttpOnly Secure cookies; session invalidation on password change | Session theft via XSS (mitigated by CSP nonce + strict-dynamic) |
| S2: Attacker forges SSO assertion | TB4 | SAML signature validation by Jackson; OIDC token validation by Auth.js | Compromised IdP could issue valid tokens |
| S3: Attacker replays extension token | TB5 | Token hashed (SHA-256) before DB storage; expiry enforced; single-use refresh | Token window between issue and expiry |
| S4: Attacker spoofs WebAuthn assertion | TB6 | Origin and RP ID validation; challenge freshness; signature verification | None (WebAuthn protocol provides strong anti-spoofing) |
| S5: Cross-tenant data access | TB2 | FORCE ROW LEVEL SECURITY on all 39 tenant-scoped tables; tenant context via SET LOCAL | RLS bypass in 47 allowlisted files (CI-guarded) |

> **RLS enforcement**: The application runtime connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS), ensuring RLS policies are enforced in all environments including development. Migrations run as `passwd_user` (SUPERUSER) which owns the tables. The `app.bypass_rls` GUC is used by 47 allowlisted code paths for cross-tenant operations (CI-guarded). See [deployment guide](../operations/deployment.md) for production role setup.

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
| R1: User denies performing sensitive action | Server | Audit log records userId, action, IP, user-agent, timestamp for all sensitive operations | Audit log is fire-and-forget (may lose entries under DB outage) |
| R2: Admin denies modifying team membership | Server | Audit log with TEAM_MEMBER_ADD/REMOVE actions; extractRequestMeta captures IP/UA | Same as R1 |
| R3: Emergency access activation without consent | Server | Configurable waiting period; email notification on request; audit trail for approve/activate | Owner must actively monitor email |

### 3.4 Information Disclosure

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| I1: Server database breach exposes passwords | TB2 | All vault data is E2E encrypted client-side; server stores ciphertext only | Attacker with DB access sees encrypted blobs, not plaintext |
| I2: Memory dump reveals secret key | Client | Web Crypto non-extractable keys where possible; explicit zeroization on lock/unload | JavaScript GC timing is non-deterministic |
| I3: Extension persists vault key | TB5 | chrome.storage.session (browser-session scoped); cleared on lock/logout | Key survives SW restarts within browser session (deliberate UX trade-off) |
| I4: Sentry error tracking leaks sensitive data | Server | beforeSend hook recursively strips sensitive field patterns; opt-in only (no DSN = disabled) | Novel field names not matching patterns |
| I5: Side-channel timing attack on auth hash | TB1 | Auth hash comparison uses constant-time HMAC verification | PBKDF2/Argon2id timing is inherent (mitigated by rate limiting) |
| I6: Passphrase verifier reveals passphrase | TB2 | Domain-separated PBKDF2 derivation; server stores HMAC(pepper, verifierHash) | Offline brute force against verifier (mitigated by PBKDF2 cost) |

### 3.5 Denial of Service

| Threat | Component | Mitigation | Residual risk |
| --- | --- | --- | --- |
| D1: Brute force login attempts | TB1 | Redis-backed rate limiting on auth endpoints | Distributed attacks from many IPs |
| D2: Expensive KDF computation exhausts client | Client | Argon2id parameters tuned for target hardware; fallback to PBKDF2 on resource-constrained devices | User on very low-end device gets PBKDF2 (lower security) |
| D3: Large attachment upload exhausts storage | TB1 | File size limits enforced server-side; per-user storage quotas | Quota enforcement depends on billing/admin configuration |
| D4: API abuse via extension token | TB5 | Token scope limits operations; rate limiting applies equally | Token holder can make rapid requests within scope |

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
| CSP (nonce + strict-dynamic) | S1 (XSS mitigation) |
| Rate limiting (Redis) | D1, D4 |
| Audit logging | R1, R2, R3 |
| Sentry scrubbing | I4 |
| Extension token lifecycle | S3, E4 |

## 5. Residual Risks (Accepted)

1. **Extension vault key persistence**: `vaultSecretKey` hex survives in `chrome.storage.session` across service worker restarts. Accepted for UX; bounded by browser session lifetime.

2. **JavaScript GC non-determinism**: Secret key material in JS heap cannot be reliably zeroized. Mitigated by non-extractable CryptoKey usage and explicit clearing on lock events.

3. **Fire-and-forget audit logging**: Audit writes may be lost under DB outage. Acceptable for current deployment model; compliance-sensitive deployments should add durable queue.

4. **Compromised IdP**: A compromised Google/SAML identity provider could issue valid authentication tokens. Mitigated by vault passphrase requirement (IdP compromise alone does not decrypt vault data).

5. **Offline brute force against exported data**: An attacker with a database dump can attempt offline brute force against PBKDF2/Argon2id-protected wrapping keys. Mitigated by high iteration counts and memory-hard KDF (Argon2id).
