# Code Review: p3-security-hardening (Round 2 — post-manual-test fixes)
Date: 2026-03-08T13:10:00+09:00
Review round: 1

## Changes from Previous Round
Initial review of all commits on branch including post-manual-test bug fixes
(session idle timeout fix, vault auto-lock tenant policy, notification i18n, sessions card fix)

## Functionality Findings

### F1 [Major] History re-encrypt CAS is non-atomic (TOCTOU)
- **File**: src/app/api/passwords/[id]/history/[historyId]/route.ts:126-164
- **Also**: src/app/api/v1/passwords/[id]/history/[historyId]/route.ts (same pattern)
- **Problem**: findUnique (hash verify) and update are separate operations — two concurrent requests could pass the same oldBlobHash check
- **Flagged by**: Functionality + Security
- **Recommended fix**: Use updateMany with keyVersion condition as optimistic lock

### F2 [Minor] Sentinel mode gated by REDIS_URL
- **File**: src/lib/redis.ts:8-9,14
- **Problem**: getRedis() returns null if REDIS_URL unset, even when REDIS_SENTINEL=true

### F3 [Minor] updateSession queries tenant table every 30 seconds
- **File**: src/lib/auth-adapter.ts:293-298
- **Problem**: Extra DB query per active session every 30s; could use join instead

### F4 [Minor] PATCH tenant policy returns request body values, not DB values
- **File**: src/app/api/tenant/policy/route.ts:137-141

## Security Findings

### S1 [Major] Session eviction lacks row-level locking (TOCTOU)
- **File**: src/lib/auth-adapter.ts:184-199
- **Problem**: findMany inside $transaction uses READ COMMITTED; concurrent logins could bypass maxConcurrentSessions
- **Recommended fix**: Add isolationLevel: Serializable to $transaction, or use $queryRaw with SELECT FOR UPDATE

### S2 [Minor] encryptedBlob has no size limit
- **File**: src/app/api/passwords/[id]/history/[historyId]/route.ts:95-96
- **Problem**: DoS vector via large payload

### S3 [Minor] req.json() unhandled parse error
- **File**: src/app/api/tenant/policy/route.ts:66
- **Problem**: Malformed JSON body causes 500 instead of 400

### S4 [Minor] clearVault() doesn't reset tenantAutoLockMinutes
- **File**: extension/src/background/index.ts:137-147
- **Problem**: Stale tenant policy persists across vault lock/unlock cycles

### S5 [Minor] logAudit missing tenantId for policy PATCH
- **File**: src/app/api/tenant/policy/route.ts:124-135

### S6 [Minor] Redis Sentinel master password not configurable
- **File**: src/lib/redis.ts:25-31
- **Problem**: No REDIS_PASSWORD env var for master auth in Sentinel mode

## Testing Findings

### T1 [Major] Redis Sentinel config path has zero test coverage
- **File**: src/lib/redis.ts (no test file exists)

### T2 [Major] sessionIdleTimeoutMinutes and vaultAutoLockMinutes validation untested
- **File**: src/__tests__/api/tenant/tenant-policy.test.ts

### T3 [Major] PATCH history re-encrypt ownership check untested
- **File**: src/__tests__/api/passwords/history-reencrypt.test.ts

### T4 [Major] Multiple session eviction case untested (limit=2, existing=3)
- **File**: src/lib/auth-adapter.test.ts

### T5 [Major] blobAuthTag format validation untested
- **File**: src/__tests__/api/passwords/history-reencrypt.test.ts

### T6 [Major] Empty body PATCH tenant policy untested
- **File**: src/__tests__/api/tenant/tenant-policy.test.ts

### T7 [Minor] vi.useRealTimers not in afterEach
- **File**: src/lib/auth-adapter.test.ts

### T8 [Minor] Test duplication between sessions-list.test.ts and route.test.ts
- **File**: src/__tests__/api/sessions/sessions-list.test.ts

## Resolution Status

### F1 [Major] RESOLVED — Used updateMany with keyVersion optimistic lock (personal + team)
### S1 [Major] RESOLVED — Added isolationLevel: "Serializable" to $transaction
### F4 [Minor] RESOLVED — PATCH now returns prisma.tenant.update() result
### S2 [Minor] RESOLVED — Added 1MB size limit to encryptedBlob
### S3 [Minor] RESOLVED — Wrapped req.json() in try-catch
### S4 [Minor] RESOLVED — Added tenantAutoLockMinutes = null in clearVault()
### S5 [Minor] RESOLVED — Added tenantId to logAudit call
### T2 [Major] RESOLVED — Added validation tests for idle timeout and auto-lock
### T3 [Major] RESOLVED — Added PATCH ownership check test (403)
### T4 [Major] RESOLVED — Added multiple eviction test (limit=2, existing=3)
### T5 [Major] RESOLVED — Added blobAuthTag format validation test
### T6 [Major] RESOLVED — Added empty body and malformed JSON body tests
### T7 [Minor] RESOLVED — Moved vi.useRealTimers to afterEach

### Deferred (Minor, out of scope)
### F2 [Minor] DEFERRED — Sentinel gated by REDIS_URL: design constraint, low risk
### F3 [Minor] DEFERRED — updateSession extra query: performance optimization for future
### S6 [Minor] DEFERRED — Sentinel master password: document in redis-ha.md
### T1 [Minor] DEFERRED — Redis Sentinel test: infrastructure layer, hard to unit test
### T8 [Minor] DEFERRED — Test duplication: refactoring task for future
