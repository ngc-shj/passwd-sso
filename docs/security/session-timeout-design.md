# Session Timeout Design

Rationale for the session-lifetime model used by the web app, team scope, and browser extension. This document records the target design. The migration work that gets us there is tracked separately in `docs/archive/review/*-plan.md`.

## Problem Statement

Before this design, session expiry was governed by three independent mechanisms:

1. Tenant `sessionIdleTimeoutMinutes` — nullable; null meant "disabled"
2. Auth.js `session.maxAge` — hardcoded 8 hours in `src/auth.ts`
3. Team `maxSessionDurationMinutes` — nullable; absolute cap from `session.createdAt`; strictest across user's teams wins

Symptoms:
- Tenant admins set idle timeout to "disabled" and still saw forced re-sign-in after ~8 hours because the Auth.js cap kept firing. The UI help text promised "no timeout when disabled."
- Tenant and team fields had mismatched semantics — tenant = rolling idle, team = absolute from `createdAt` — despite similar names.
- Absolute cap was missing at the tenant level, violating [OWASP ASVS 5.0 V7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v73-session-timeout).
- Extension token TTL was unrelated to any of the above, giving a single user three different expiry behaviors across surfaces.

## Design Principles

1. **Single source of truth per surface.** For a given surface (web / team scope / extension), one tenant-level field governs idle timeout and one governs absolute timeout. No hidden constants in code.
2. **Two-axis model everywhere.** Idle and absolute are independent controls. [ASVS 5.0 V7.3.1 + V7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v73-session-timeout) require both for L2 apps. A credential-storage product is L3 and inherits all L2 requirements.
3. **No "disabled" option for session timeouts.** Admins must choose a number. Limits are enforced at the schema, not by convention.
4. **Strictest-wins at team scope, with the same semantics as tenant.** Team fields mirror tenant fields one-for-one. `Math.min` of all non-null values across user's teams, clamped to ≤ tenant value at write time.
5. **Extension is a distinct credential class.** Extension token TTL is NOT governed by web session policy. It lives under the existing "Machine Identity" axis alongside MCP / SA / API-key TTLs.

## Standards Basis

| Standard | Requirement | This Design |
|----------|-------------|-------------|
| [OWASP ASVS 5.0 V7.3.1](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v73-session-timeout) | Inactivity timeout required (L2) | `sessionIdleTimeoutMinutes` non-null |
| [OWASP ASVS 5.0 V7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v73-session-timeout) | Absolute maximum session lifetime required (L2) | `sessionAbsoluteTimeoutMinutes` non-null |
| [NIST SP 800-63B-4 §2.3.3 (AAL3 Reauthentication)](https://pages.nist.gov/800-63-4/sp800-63b.html) | 12h absolute OR 15min inactivity | Sensitive actions MAY require fresh passkey verification without forcing the entire browser session into AAL3 timeouts |
| [NIST SP 800-207 §2.1 tenet 6](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf) | All resource authentication and authorization are dynamic and strictly enforced before access is allowed | Team-level override (strictest wins) |
| [OWASP Session Management Cheat Sheet § Session Expiration](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-expiration) | "It is mandatory to set expiration timeouts for every session" | Nullability removed |
| [RFC 9700 §2.2.2 (Refresh Tokens)](https://www.rfc-editor.org/rfc/rfc9700#name-refresh-tokens) | Refresh tokens for public clients MUST be sender-constrained or use refresh token rotation | Extension reuses the rotation/revocation machinery already built for MCP |

## Field Inventory

### Tenant (authoritative)

| Field | Type | Default | Max | Meaning |
|-------|------|---------|-----|---------|
| `sessionIdleTimeoutMinutes` | int, non-null | 480 (8h) | 1440 (24h) | Web session killed if `lastActiveAt` older than this |
| `sessionAbsoluteTimeoutMinutes` | int, non-null | 43200 (30d) | 43200 (30d) | Web session killed if `createdAt` older than this, regardless of activity |
| `extensionTokenIdleTimeoutMinutes` | int, non-null | 10080 (7d) | 43200 (30d) | Extension access token revoked if unused this long |
| `extensionTokenAbsoluteTimeoutMinutes` | int, non-null | 43200 (30d) | 43200 (30d) | Extension refresh-token family revoked after this long from issue |

### Team (stricter-than-tenant override)

| Field | Type | Constraint | Meaning |
|-------|------|------------|---------|
| `sessionIdleTimeoutMinutes` | int, nullable | ≤ tenant value at write time | Overrides tenant idle timeout for members of this team |
| `sessionAbsoluteTimeoutMinutes` | int, nullable | ≤ tenant value at write time | Overrides tenant absolute timeout for members of this team |

Team fields use **the same semantics as the tenant fields**. The old `maxSessionDurationMinutes` field (absolute, createdAt-based) is removed — its intent is now expressed by `sessionAbsoluteTimeoutMinutes`.

### Removed

- Auth.js hardcoded `session.maxAge: 8 * 60 * 60` — replaced by per-session `expires` computed from the resolved tenant/team policy at `createSession` / `updateSession` time.
- Team `maxSessionDurationMinutes` — superseded by `sessionAbsoluteTimeoutMinutes`.
- Tenant `sessionIdleTimeoutMinutes = null` semantic — nullability removed.

## Resolution Order

For every session check, the effective values are:

```
idle     = min(tenant.idle,     ...teams.idle.filter(non-null))
absolute = min(tenant.absolute, ...teams.absolute.filter(non-null))
```

Recomputed on every `auth()` call — the session-timeout resolver itself is recomputed each time; the 60s in-process team-policy cache continues to apply. Session validity itself is cached in Redis (see policy-enforcement.md §Cache Invalidation). Tombstones short-circuit revocation propagation under both the positive cache (`SESSION_CACHE_TTL_MS`) and the tombstone window (`TOMBSTONE_TTL_MS`). Team membership changes or policy edits propagate within the team-policy cache TTL (60s).

## Fresh Passkey Reauthentication

Personal passkey sign-in sessions now follow the ordinary tenant/team web-session policy envelope. High-assurance reauthentication is enforced separately through explicit session-scoped passkey freshness metadata:

- ordinary session expiry still uses tenant/team `idle` and `absolute` policy values
- sensitive routes MAY require `passkeyVerifiedAt` to be within a short freshness window
- successful in-session passkey reauthentication resets freshness without rotating the whole browser session family

Rationale: for personal bootstrap users, the normal browsing session is treated as an AAL2-style web session, while sensitive actions can still require a fresh passkey ceremony when stronger assurance is needed.

## Extension Token Policy

The extension (and, since the long-lived-client-login change, the iOS app)
holds its own bearer token, distinct from the Auth.js cookie. This design
treats both as a "Machine Identity" surface, parallel to MCP / SA / API keys.

- **Idle timeout** (`extensionTokenIdleTimeoutMinutes`, default 7d) is no
  longer reset by refresh activity. It is measured from **presence**: the
  timestamp of the last successful `POST /api/vault/unlock/verify` call, which
  resubmits the same `authHash` `/api/vault/unlock` verifies and proves the
  client still knows the passphrase (or, on iOS, the biometric-cached
  equivalent). A token that keeps refreshing itself on schedule, with no real
  unlock in between, still goes stale after `idle` — this is what bounds the
  **walk-up attacker** threat: an attacker who has the unlocked device but not
  the passphrase can keep the connection alive by refreshing, but the family
  dies `idle` after the owner's last genuine unlock regardless. See
  `docs/archive/review/long-lived-client-login-plan.md` §C2–C4 and
  `docs/architecture/client-reauth-timing.md`.
- **Absolute timeout** (`extensionTokenAbsoluteTimeoutMinutes`, default 30d)
  is unchanged in spirit: measured from family creation, never extended by
  refresh or by presence.
- Both fields are shared verbatim between the browser extension and the iOS
  app (`docs/architecture/ios-app.md`) — there is no separate iOS field.
- **Stolen-laptop / walk-up defense is NOT background refresh.** The real
  defense is requiring a genuine local unlock (passphrase, or biometric on
  iOS) to reset the idle clock; refresh alone cannot. That control is
  orthogonal to the absolute cap and lives in the presence mechanism above.
- **"Sign out everywhere"** must enumerate and revoke the user's extension and
  iOS token families in addition to deleting web sessions. A single-session
  web sign-out no longer affects either client's connection (extension refresh
  no longer depends on a web session at all).

## Migration Obligations

- Backfill existing tenants with `sessionIdleTimeoutMinutes = null` to the new defaults (`480` / `43200`).
- Send tenant-admin notification 30 days before enforcement of the new absolute cap.
- Old Auth.js `maxAge` constant removed in the same change that teaches `createSession` / `updateSession` to read from tenant policy.
- `getStrictestSessionDuration(userId)` removed; replaced by a resolver that returns both idle and absolute.

## Out of Scope

- MCP / SA / API key / JIT / delegation TTLs. These have their own fields and are documented in `docs/architecture/machine-identity.md`.
- Vault auto-lock (`vaultAutoLockMinutes`). This is a client-side timer for vault encryption state, not a session control — the server cannot see vault lock state. See `policy-enforcement.md`.
- Account lockout (`lockoutThreshold*`, `lockoutDuration*`). Separate concern.

## References

- [policy-enforcement.md](policy-enforcement.md) — where each tenant/team policy field is enforced in code
- [threat-model.md](threat-model.md) — STRIDE analysis
- [../architecture/machine-identity.md](../architecture/machine-identity.md) — SA / MCP / API key / JIT design
