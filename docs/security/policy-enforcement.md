# Security Policy Enforcement Matrix

This document records where each configurable security policy field is enforced, and the architectural constraints that determine the enforcement layer.

## Architectural Constraint: E2E Encryption Boundary

Password content (plaintext) is encrypted client-side before reaching the server. The server stores only ciphertext blobs. This means:
- **Password complexity rules** (length, character classes) CANNOT be enforced server-side
- **Password reuse checks** CANNOT be done server-side
- These are enforced **client-side by blocking form submission** before encryption
- A direct API call with a pre-encrypted blob bypasses these checks — this is an accepted limitation for all authenticated API clients

## Tenant Policy Fields

| Field | Enforcement | Layer | Location | Notes |
|-------|------------|-------|----------|-------|
| `maxConcurrentSessions` | Blocking | Server | `auth-adapter.ts` `createSession()` | Oldest sessions evicted atomically in Serializable tx |
| `sessionIdleTimeoutMinutes` | Blocking | Server | `auth-adapter.ts` `updateSession()` | Session deleted on every refresh if idle > timeout |
| `vaultAutoLockMinutes` | Timer | Client | `auto-lock-context.tsx` | Browser inactivity timer; server cannot know vault lock state |
| `allowedCidrs` | Blocking | Server | `proxy.ts` + `access-restriction.ts` | Middleware (Edge) + route handler (Node.js); 60s cache |
| `tailscaleEnabled` / `tailscaleTailnet` | Blocking | Server | `access-restriction.ts` | Two-stage: Edge (CGNAT heuristic) + Node.js (WhoIs verify) |
| `requireMinPinLength` | Blocking | Server | `webauthn/register/verify/route.ts` | Platform authenticators (Touch ID, etc.) exempt — they don't report PIN length |
| `requirePasskey` | Blocking/Advisory | Server | `proxy.ts` middleware | After grace period: redirect (blocking) + audit via `/api/internal/audit-emit`. Within grace: advisory banner via `/api/user/passkey-status` |
| `requirePasskeyEnabledAt` | — | Server | `proxy.ts` | Grace period start timestamp; set-once on `false→true` transition |
| `passkeyGracePeriodDays` | — | Server | `proxy.ts` | Grace period duration; used with `requirePasskeyEnabledAt` |
| `lockoutThreshold1/2/3` | Blocking | Server | `account-lockout.ts` `recordFailure()` | Per-tenant thresholds; 60s cache; 3 progressive tiers |
| `lockoutDuration1/2/3Minutes` | Blocking | Server | `account-lockout.ts` `recordFailure()` | Monotonic lock extension (never shortens active locks) |
| `passwordMaxAgeDays` | Advisory | Client | `use-watchtower.ts` | Watchtower scan flags expired entries; no forced password change. Personal scope only — team watchtower page does not supply policy at runtime |
| `passwordExpiryWarningDays` | Advisory | Client | `use-watchtower.ts` | Warning period before `passwordMaxAgeDays` threshold. Same personal-scope-only limitation |
| `auditLogRetentionDays` | Blocking | Server | `purge-audit-logs/route.ts` | Per-tenant enforcement: iterates all tenants, applies `max(requested, tenant.retentionDays)` |
| `tenantMinPasswordLength` | Blocking | Client | `use-personal-login-form-model.ts` | `getPolicyViolations()` blocks form submit; E2E encryption prevents server check |
| `tenantRequireUppercase` | Blocking | Client | `use-personal-login-form-model.ts` | Same |
| `tenantRequireLowercase` | Blocking | Client | `use-personal-login-form-model.ts` | Same |
| `tenantRequireNumbers` | Blocking | Client | `use-personal-login-form-model.ts` | Same |
| `tenantRequireSymbols` | Blocking | Client | `use-personal-login-form-model.ts` | Same |
| `jitTokenDefaultTtlSec` | Blocking | Server | `tenant/access-requests/[id]/approve/route.ts` | Default TTL for JIT access tokens; capped by `jitTokenMaxTtlSec` |
| `jitTokenMaxTtlSec` | Blocking | Server | `tenant/access-requests/[id]/approve/route.ts` | Hard ceiling for JIT token TTL; enforced via `Math.min()` |
| `delegationDefaultTtlSec` | Blocking | Server | `vault/delegation/route.ts` | Default TTL for delegation sessions |
| `delegationMaxTtlSec` | Blocking | Server | `vault/delegation/route.ts` | Hard ceiling for delegation TTL; enforced via `Math.min(requested, max)` |
| `saTokenMaxExpiryDays` | **Not enforced** | — | — | Defined in schema but no enforcement code references this field |

## Team Policy Fields

| Field | Enforcement | Layer | Location | Notes |
|-------|------------|-------|----------|-------|
| `minPasswordLength` | Blocking | Client | `use-team-login-form-state.ts` | `getPolicyViolations()` blocks form submit; login entry type only |
| `requireUppercase` | Blocking | Client | `use-team-login-form-state.ts` | Same |
| `requireLowercase` | Blocking | Client | `use-team-login-form-state.ts` | Same |
| `requireNumbers` | Blocking | Client | `use-team-login-form-state.ts` | Same |
| `requireSymbols` | Blocking | Client | `use-team-login-form-state.ts` | Same |
| `maxSessionDurationMinutes` | Blocking | Server | `auth-adapter.ts` `updateSession()` | `getStrictestSessionDuration(userId)` — minimum across all teams; 60s cache |
| `requireRepromptForAll` | Blocking | Client | `use-team-base-form-model.ts` | Forces `requireReprompt=true` on entries; reprompt gate is client-side |
| `allowExport` | Blocking | Server | `audit-logs/download/route.ts`, `audit-logs/export/route.ts` | `assertPolicyAllowsExport(teamId)` → 403 |
| `allowSharing` | Blocking | Server | `share-links/route.ts` | `assertPolicyAllowsSharing(teamId)` → 403 |
| `requireSharePassword` | Blocking | Server | `share-links/route.ts` | `assertPolicySharePassword(teamId, requirePassword)` → 400 |
| `passwordHistoryCount` | Blocking | Client | `use-team-login-form-state.ts` | Fetches + decrypts last N history entries; `checkPasswordReuse()` blocks submit |
| `inheritTenantCidrs` | Blocking | Server | `team-auth.ts` `requireTeamMember/Permission` | `withTeamIpRestriction()` called inside shared auth functions |
| `teamAllowedCidrs` | Blocking | Server | `team-auth.ts` `requireTeamMember/Permission` | Combined with tenant CIDRs when `inheritTenantCidrs=true` |

## Enforcement Levels

| Level | Meaning |
|-------|---------|
| **Blocking (Server)** | Request rejected with HTTP error; cannot be bypassed by client |
| **Blocking (Client)** | Form submission disabled; direct API calls bypass (E2E encryption constraint) |
| **Advisory** | Warning displayed; user can proceed |
| **Timer** | Client-side timer; no server enforcement |

## Cache Invalidation

| Cache | TTL | Invalidated by | Location |
|-------|-----|---------------|----------|
| Tenant access policy | 60s | `invalidateTenantPolicyCache(tenantId)` | `access-restriction.ts` |
| Lockout thresholds | 60s | `invalidateLockoutThresholdCache(tenantId)` | `account-lockout.ts` |
| Session duration (team) | 60s | TTL expiry only | `team-policy.ts` |
| Session info (proxy) | 30s | TTL expiry only | `proxy.ts` |
