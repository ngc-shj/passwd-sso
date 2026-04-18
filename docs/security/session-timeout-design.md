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
| [NIST SP 800-63B-4 §2.3.3 (AAL3 Reauthentication)](https://pages.nist.gov/800-63-4/sp800-63b.html) | 12h absolute OR 15min inactivity | WebAuthn/Passkey sessions clamp to AAL3 limits automatically |
| [NIST SP 800-207 §2.1 tenet #6](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf) | All resource authentication and authorization are dynamic and strictly enforced before access is allowed | Team-level override (strictest wins) |
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

Recomputed on every `auth()` call — not cached beyond the existing 60s team-policy cache. Team membership changes or policy edits propagate within the cache TTL.

## AAL3 Clamp

When the current session was established via WebAuthn / Passkey (discoverable or non-discoverable), the resolved limits are clamped to [NIST SP 800-63B-4 §2.3.3](https://pages.nist.gov/800-63-4/sp800-63b.html) AAL3 ceilings:

- `idle ≤ 15 min`
- `absolute ≤ 12h`

Rationale: a Passkey session is AAL3 only for as long as the reauthentication interval is AAL3-compliant. Letting a passkey session run for 30 days silently demotes it below its own authentication assurance.

## Extension Token Policy

The extension holds its own bearer token, distinct from the Auth.js cookie. This design treats the extension as a "Machine Identity" surface, parallel to MCP / SA / API keys.

- **Access token TTL** derived from `extensionTokenIdleTimeoutMinutes` — short enough that server-side revocation propagates within ≤5 min.
- **Refresh token** derived from `extensionTokenAbsoluteTimeoutMinutes` — rotated on every use, revoked as a family on replay (reusing `src/lib/mcp/token-rotation.ts` patterns).
- **Stolen-laptop defense is NOT TTL.** The real defense is requiring local unlock (PRF / biometric) on extension wake after N minutes of inactivity. That control is orthogonal to the token TTL and lives in the extension side.
- **"Sign out everywhere"** must enumerate and revoke the user's extension refresh-token families in addition to deleting web sessions.

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
