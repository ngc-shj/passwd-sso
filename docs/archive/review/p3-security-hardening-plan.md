# P3 Security Hardening Plan

## Objective

Implement the Phase 3 maturation items from the external security assessment roadmap.
Focus on code-implementable items; document-only items are scoped as documentation tasks.

## Scope Analysis

| # | Item | Type | In Scope |
|---|------|------|----------|
| 13 | History lazy re-encryption | Code | Yes — client-side re-encrypt on history access |
| 14 | Redis HA | Infrastructure | Partial — Docker Sentinel config + health check update |
| 15 | Concurrent session management | Code | Yes — max session limits via TeamPolicy |
| 16 | External security audit | Process/Cost | Documentation only — prep checklist |
| 17 | Bug bounty program | Process/Cost | Documentation only — SECURITY.md + policy |
| 18 | Reproducible builds | DevOps | Yes — Dockerfile pinning + build verification |

## Requirements

### Functional Requirements

1. **#13 History lazy re-encryption**: When a user views a history entry encrypted with an old key version, the client re-encrypts with the current key and PATCHes the record. Old key versions can eventually be cleaned up.

2. **#14 Redis HA**: Provide a `docker-compose.ha.yml` override with Redis Sentinel (1 master + 2 replicas + 3 sentinels). Update `src/lib/redis.ts` to support Sentinel connection strings. Update health check to report Sentinel topology.

3. **#15 Concurrent session management**: Enforce `Tenant.maxConcurrentSessions` (default: unlimited, tenant-level scope). On new session creation, if limit exceeded, evict oldest session. Add API endpoint for tenant admins to configure the limit. Add session count to session list response.

4. **#16 External security audit prep**: Create `docs/security/audit-preparation-checklist.md` documenting what to prepare before engaging an external auditor.

5. **#17 Bug bounty / SECURITY.md**: Create `SECURITY.md` with vulnerability disclosure policy and responsible disclosure guidelines.

6. **#18 Reproducible builds**: Pin all base images to digest in Dockerfile. Add `npm ci --ignore-scripts` verification. Document build reproduction steps in `docs/operations/reproducible-builds.md`.

### Non-Functional Requirements

- All changes must pass `npx vitest run` and `npx next build`
- No breaking changes to existing API contracts
- Redis HA must be opt-in (existing single-node Redis continues to work)
- Session limits must be backwards-compatible (unlimited by default)

## Technical Approach

### #13 History Lazy Re-encryption

**Architecture**: Client-side only. Server stores re-encrypted blob.

1. Add `PATCH /api/passwords/[id]/history/[historyId]` endpoint accepting re-encrypted blob
2. Add `GET /api/passwords/[id]/history/[historyId]` for individual history entry retrieval (personal side — team side already exists)
3. Client: on history view, if `keyVersion < currentKeyVersion`, re-encrypt and PATCH
4. Server validations:
   - Authenticate caller and verify ownership (personal) or team membership + permission (team)
   - Validate `newKeyVersion > oldKeyVersion` (prevent downgrade)
   - Validate blob format (non-empty ciphertext, 12-byte IV hex, 16-byte authTag hex)
   - **Compare-and-swap**: require SHA-256 hash of old `encryptedBlob` in request; server verifies match before overwriting (prevents injection of arbitrary ciphertext)
   - Rate limit: 20 req/60s per user (prevent abuse)
5. Team entries: `PATCH /api/teams/[teamId]/passwords/[id]/history/[historyId]` — validates both `teamKeyVersion` and `itemKeyVersion` (dual key hierarchy). Accepts updated `encryptedItemKey` alongside blob.
6. Audit log: `ENTRY_HISTORY_REENCRYPT` with old/new keyVersion metadata

**Security note**: The server cannot verify blob contents (E2E encrypted), but validates structure, ownership, and old-blob hash (compare-and-swap). The authTag in AES-GCM provides cryptographic integrity — a malformed blob will fail client-side decryption.

**Files**:

- `src/app/api/passwords/[id]/history/[historyId]/route.ts` (new — GET + PATCH)
- `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts` (add PATCH)
- `src/lib/constants/audit.ts` (add action)

### #14 Redis HA

**Architecture**: Opt-in Sentinel support via explicit `REDIS_SENTINEL` env var (not URL scheme detection).

1. `docker-compose.ha.yml` — Sentinel overlay (3 sentinels + 2 replicas)
2. `src/lib/redis.ts` — when `REDIS_SENTINEL=true`, parse `REDIS_SENTINEL_HOSTS` (comma-separated host:port) and `REDIS_SENTINEL_MASTER_NAME` to connect via Sentinel mode. Sentinel auth via `REDIS_SENTINEL_PASSWORD` env var.
3. `src/lib/health.ts` — add Sentinel info to readiness response when in Sentinel mode
4. `docs/operations/redis-ha.md` — setup, failover guide, and authentication configuration

**Decision**: Use explicit env vars (`REDIS_SENTINEL=true`) instead of custom URL scheme to avoid misdetection with standard Redis URLs. Fully migrate from `redis` (node-redis v4) to `ioredis` for both standard and Sentinel modes. This avoids maintaining two Redis packages and provides consistent API across all call sites (`rate-limit.ts`, `health.ts`). Standard `REDIS_URL` continues to work unchanged when `REDIS_SENTINEL` is not set. Optional `REDIS_SENTINEL_TLS=true` for TLS-encrypted Sentinel connections.

### #15 Concurrent Session Management

**Architecture**: Enforce at session creation time in auth adapter using atomic DB transaction. Scope at **Tenant level** (not TeamPolicy) because Sessions are scoped to `userId` + `tenantId`, not team.

1. Add `maxConcurrentSessions` to `Tenant` schema (nullable Int, null = unlimited)
2. In `createSession()` (`src/lib/auth-adapter.ts`): within a Prisma interactive `$transaction`:
   - Lock user's sessions with `SELECT ... FOR UPDATE` equivalent
   - Count active sessions for the user within the tenant
   - If `count >= maxConcurrentSessions`, delete oldest session(s)
   - Create new session
   - This prevents TOCTOU race conditions from concurrent logins
3. Add `GET /api/tenant/policy` and `PATCH /api/tenant/policy` for tenant admins (RBAC: tenant admin only)
4. Return `sessionCount` / `maxSessions` in `GET /api/sessions` response
5. Rate limit policy API: 10 req/60s
6. Audit log: `SESSION_EVICTED` when oldest session is force-evicted, including evicting session's IP/UA in metadata
7. Notify evicted user via existing notification system (non-blocking)

**Security note**: Session strategy is database-based (Auth.js v5 DB sessions, not JWT). Eviction deletes DB rows, immediately invalidating the session. Interactive transaction with row locking prevents race conditions. Use `ORDER BY id` in `SELECT FOR UPDATE` to ensure consistent lock ordering and prevent deadlocks. Transaction timeout: default 5s. PostgreSQL auto-detects deadlocks and returns error; Auth.js will retry the login flow.

**Compare-and-swap**: PATCH history re-encryption returns HTTP 409 Conflict when old-blob SHA-256 hash doesn't match (distinct from 400 validation errors). Client can refetch and retry.

**Files**:
- `prisma/schema.prisma` (add field to Tenant)
- `src/lib/auth-adapter.ts` (enforce limit with transaction + locking)
- `src/app/api/tenant/policy/route.ts` (new)
- `src/app/api/sessions/route.ts` (add count)
- `src/lib/constants/audit.ts` (add action)

### #16 External Security Audit Prep

Create `docs/security/audit-preparation-checklist.md` with:
- Scope definition (codebase, infrastructure, crypto)
- Required documentation (threat model, crypto whitepaper, architecture diagrams)
- Access provisioning checklist
- Pre-audit self-assessment items
- Suggested audit firms and engagement types

### #17 Bug Bounty / SECURITY.md

Create `SECURITY.md` (project root) with:
- Supported versions
- Reporting instructions (email, PGP key placeholder)
- Response timeline commitments
- Scope (in-scope / out-of-scope)
- Safe harbor statement

### #18 Reproducible Builds

1. Pin Docker base images to SHA256 digest
2. Add `package-lock.json` integrity verification step
3. Create `docs/operations/reproducible-builds.md` with reproduction steps
4. Add build metadata (git SHA, timestamp) to Next.js public env

**Files**:
- `Dockerfile` (pin images)
- `next.config.ts` (build metadata env)
- `docs/operations/reproducible-builds.md` (new)

## Implementation Steps

1. Add `maxConcurrentSessions` to Tenant schema + migration
2. Implement concurrent session enforcement in auth-adapter (interactive transaction + row locking)
3. Add tenant policy API endpoints (GET/PATCH with RBAC)
4. Add session count to sessions API
5. Add history re-encryption endpoints (GET individual + PATCH) for personal entries
6. Add history re-encryption PATCH for team entries (dual key version validation)
7. Add audit log actions (`ENTRY_HISTORY_REENCRYPT`, `SESSION_EVICTED`)
8. Migrate `redis` to `ioredis` (full replacement: redis.ts, rate-limit.ts, health.ts)
9. Add Sentinel support to ioredis client (env var driven, with TLS option)
10. Create `docker-compose.ha.yml` with Sentinel config
11. Update health check for Sentinel mode
12. Pin Dockerfile base images to digest
13. Add build metadata to Next.js config
14. Create `SECURITY.md`
15. Create `docs/security/audit-preparation-checklist.md`
16. Create `docs/operations/redis-ha.md`
17. Create `docs/operations/reproducible-builds.md`
18. Write tests for all new endpoints and logic (including redis migration regression)
19. Run `npx vitest run` and `npx next build`

## Testing Strategy

- **Unit tests**: Session enforcement logic (with transaction mocking), Redis Sentinel config detection, history re-encryption validation, compare-and-swap hash verification
- **API tests**: PATCH history endpoint (ownership check, keyVersion downgrade rejection, same-version rejection, blob format validation, compare-and-swap failure, rate limit), tenant policy CRUD (RBAC), session count response
- **Security tests**: Auth bypass attempts on new endpoints, invalid blob format rejection, unauthorized policy modification, team history dual key version validation
- **Regression tests**: All existing `rate-limit.test.ts` and `health.test.ts` pass after redis → ioredis migration; Sentinel connection failure falls back to in-memory
- **Integration**: Session eviction on limit exceed (atomic transaction with row locking), concurrent session counting
- **Audit log**: SESSION_EVICTED follows standardized `logAudit` pattern (scope, targetType, targetId, metadata with IP/UA)
- **Build**: Verify `npx vitest run` and `npx next build` both succeed

## Considerations & Constraints

- **Redis HA is opt-in**: Existing single-node deployments must not break
- **Session limits are tenant-scoped**: Moved from TeamPolicy to Tenant because Sessions have no team association. null = unlimited (backwards-compatible default)
- **History re-encryption is client-driven**: Server only stores blobs, never decrypts. Compare-and-swap protects against blob injection.
- **ioredis full migration**: Replace `redis` (node-redis) with `ioredis` across all call sites. Removes duplicate dependency.
- **No external audit engagement**: #16 is prep documentation only
- **Bug bounty**: #17 is policy documentation only, no platform integration
- **Reproducible builds**: Full reproducibility requires pinned npm registry; this phase pins Docker images only
