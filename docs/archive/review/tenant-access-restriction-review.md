# Plan Review: tenant-access-restriction

Date: 2026-03-10
Review round: 2

## Changes from Previous Round

Round 1 → Round 2 changes:

- Added `tailscaleTailnet` field to Tenant model for tailnet identity verification (F1)
- Redesigned integration: session auth in proxy, Bearer/API v1/SCIM in route handlers (S1, S2)
- `hasValidSession()` returns `{ valid, userId, tenantId }` with cache (F2)
- Fast path for unrestricted tenants (F2)
- IPv4-mapped IPv6 normalization in `extractClientIp()` (F3)
- IP validation + `new URL()` for WhoIs URL construction (S3)
- Unified IP extraction: all 5 call sites delegate to `extractClientIp()` (S5)
- Rightmost-untrusted X-Forwarded-For parsing (N1)
- WhoIs FQDN normalization: trailing dot, case-insensitive (N3)
- Expanded test cases for all auth paths, IP extraction, cache, WhoIs errors

## Round 1 Findings — Resolution Status

| ID | Severity | Status | Resolution |
| -- | -------- | ------ | ---------- |
| F1 | Critical | Resolved | `tailscaleTailnet` field + WhoIs `Node.Name` comparison |
| S1 | Critical | Resolved | IP check in route handlers for v1/SCIM, proxy for session auth |
| F2 | Major | Resolved | `hasValidSession()` extended + fast path |
| S2 | Major | Resolved | IP check in route handlers via `authOrToken()` |
| S3 | Major | Resolved | IP validation regex + `new URL()` |
| T4 | Major | Resolved | Test cases expanded (lockout, cache, auth paths) |
| F3 | Minor | Resolved | IPv4-mapped IPv6 normalization |
| S5 | Minor | Resolved | All 5 IP extraction sites unified to `extractClientIp()` |
| F4 | Minor | Noted | `confirmLockout` keeps simple flag (accepted risk) |
| S4 | Minor | Noted | DB recovery documented (accepted risk) |
| T5 | Minor | Resolved | IP extraction edge case tests added |
| T6 | Minor | Resolved | Cache eviction tests added |

## Round 2 Findings

### Functionality Findings

#### F5 [Major] `hasValidSession()` return type change impact — Resolved

Changing return from `boolean` to `{ valid, userId, tenantId }` affects 3 call sites and cache type.
Resolution: Plan specifies callers use `.valid` for boolean checks. Cache type updated accordingly.

#### F6 [Major] SCIM route IP restriction insertion point — Resolved

SCIM routes bypass proxy auth entirely. Plan now specifies IP restriction in SCIM route handlers after `validateScimToken()`, not in proxy.

#### F7 [Minor] Session cache TTL allows IP change bypass window (30s)

IP restriction check uses cached session result. VPN on/off or mobile IP change can bypass for up to 30s.
Decision: Accepted as performance tradeoff. IP restriction is checked fresh on cache miss.

#### F8 [Minor] Bearer token tenant resolution in proxy — Resolved

Plan moved Bearer IP restriction to route handlers via `authOrToken()`, avoiding proxy-layer token parsing.

### Security Findings

#### N1 [Major] X-Forwarded-For leftmost parsing vulnerable to spoofing — Resolved

Changed to rightmost-untrusted pattern in `extractClientIp()`.

#### N2 [Major] IP extraction inconsistency across 5 call sites — Resolved

All 5 sites now delegate to `extractClientIp()`. Passkey endpoints included.

#### N3 [Minor] Tailscale Node.Name FQDN normalization — Resolved

Added trailing dot strip, `.toLowerCase()`, empty `Node.Name` handling.

#### N4 [Minor] SCIM endpoint IP restriction insertion unclear — Resolved

Plan specifies route handler level after `validateScimToken()`.

#### N5 [Info] Session cache and IP restriction ordering

Recommendation to check IP before session cache. Decision: IP restriction runs after session validation (tenant ID needed), but is not cached — only session validity is cached.

### Testing Findings

#### T7 [Major] SCIM auth + IP restriction interaction test — Resolved

Added test cases: SCIM valid token + disallowed IP → 403, invalid token + allowed IP → 401.

#### T8 [Major] API v1 IP restriction implementation unclear — Resolved

Plan specifies route handler level after `validateApiKeyOnly()`.

#### T9 [Minor] `extractRequestMeta` / `extractClientIp` unification test

Added: verify both return identical IP for same request.

#### T10 [Minor] WhoIs timeout/error handling tests — Resolved

Added test cases: timeout, 5xx, invalid JSON, empty Node.Name, trailing dot.

#### T11 [Minor] Concurrent policy update race condition

Not added as explicit test. Accepted: last-write-wins is standard for policy updates.

## Summary

Round 2 produced 0 Critical, 0 unresolved Major findings. All Major items from both rounds are resolved.
Remaining Minor items (F7, T11) are accepted tradeoffs.

Plan is ready for finalization.
