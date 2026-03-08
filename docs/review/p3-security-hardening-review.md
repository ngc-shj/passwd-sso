# Plan Review: p3-security-hardening
Date: 2026-03-08
Review rounds: 2

## Round 1 — Initial Review

### Functionality Findings

#### F1 [Major] Session limit scope mismatch — TeamPolicy is per-team but Session has no teamId
Session model has `userId` + `tenantId` scope, not team. When a user belongs to multiple teams with different limits, it's unclear which policy applies.
**Resolution**: Moved `maxConcurrentSessions` to Tenant level.

#### F2 [Major] Missing GET endpoint for individual personal history entry
Only list endpoint exists for personal history. PATCH re-encryption needs individual retrieval.
**Resolution**: Added `GET /api/passwords/[id]/history/[historyId]`.

#### F3 [Major] Redis package migration scope underestimated
Switching to `ioredis` requires migrating all call sites or maintaining two packages.
**Resolution**: Full `ioredis` migration specified (replace node-redis entirely).

#### F4 [Minor] Team history re-encryption has dual key version structure
**Resolution**: Specified `teamKeyVersion` + `itemKeyVersion` dual validation in plan.

#### F5 [Minor] Session eviction in Auth.js adapter has side-effect concerns
**Resolution**: Documented trade-off; kept in `createSession` for atomicity.

### Security Findings

#### S1 [Major] History re-encryption lacks compare-and-swap protection
PATCH accepts new blob without verifying old blob unchanged.
**Resolution**: Added SHA-256 hash of old blob as compare-and-swap requirement.

#### S2 [Major] Session eviction TOCTOU
Count + evict + create not in single transaction.
**Resolution**: Prisma interactive `$transaction` with `SELECT FOR UPDATE` row locking.

#### S3 [Minor] Redis Sentinel TLS missing
**Resolution**: Added `REDIS_SENTINEL_TLS=true` option.

#### S4 [Minor] Session eviction lacks client notification
**Resolution**: Added notification via existing system + IP/UA in audit metadata.

#### S5 [Minor] npm ci integrity documentation
**Resolution**: Noted as constraint; `npm ci` already verifies.

### Testing Findings

#### T1 [Major] No regression test plan for redis → ioredis migration
**Resolution**: Regression tests specified in testing strategy.

#### T2 [Major] History PATCH test design
**Resolution**: Blob format validation, keyVersion tests specified.

#### T3 [Minor] SESSION_EVICTED audit log pattern
**Resolution**: Standardized `logAudit` pattern tests specified.

#### T4 [Minor] Reproducible build verification
**Resolution**: Noted as optional CI enhancement.

## Round 2 — Incremental Review

All 6 Major findings from Round 1 confirmed resolved.

### New Findings (all Minor)

#### F6 [Minor] SELECT FOR UPDATE deadlock risk under concurrent logins
**Resolution**: Added `ORDER BY id` for consistent lock ordering. PostgreSQL auto-detects deadlocks; login flow retries naturally.

#### F7 [Minor] Session eviction notification timing
Evicted session may already be deleted when notification arrives.
**Resolution**: Implementation detail — notify before delete in transaction, or use app-level notification (not session-dependent).

#### F8 [Minor] Compare-and-swap SHA-256 target scope (blob only vs blob+overview)
History entries have only `encryptedBlob` (not overview), so single blob hash is sufficient.

#### F9 [Minor] REDIS_SENTINEL_TLS controls both sentinelTLS and tls in ioredis
Implementation detail — single flag enables both. Documented in plan.

#### N2 [Minor] Session limit migration (TeamPolicy → Tenant) — no residual references
New field on Tenant; TeamPolicy never had this field, so no migration needed.

#### N3 [Minor] Nested history endpoint dual-level authorization
Implementation detail — route handler must verify both entry ownership and history entry linkage.

#### N4 [Minor] Compare-and-swap HTTP status code (409 Conflict)
**Resolution**: Added to plan — PATCH returns 409 on hash mismatch.

#### N5 [Minor] Dual key version validation error messaging
Implementation detail — include expected/actual versions in error response.

## Summary

| Round | Critical | Major | Minor | Status |
|-------|----------|-------|-------|--------|
| 1     | 0        | 6     | 6     | All resolved in plan update |
| 2     | 0        | 0     | 8     | All Minor, implementable |

**Plan review complete** — no Critical or Major findings remain.
