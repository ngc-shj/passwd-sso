# Rate Limiting Review
Date: 2026-03-25
Review round: 1 (code review only — no plan/branch, existing code assessment)

## Summary

Rate limiting implementation covers ~30 endpoints but leaves ~80 endpoints unprotected. The core `createRateLimiter()` library is well-structured (Redis primary + in-memory fallback, pipeline optimization), but has architectural gaps: no centralized middleware, inconsistent response headers, silent Redis failure degradation, and missing coverage on security-sensitive endpoints.

## Functionality Findings

### F1 — Major: `redisConfigValidated` global flag can be silently bypassed

**File:** `src/lib/rate-limit.ts:24`
**Problem:** `redisConfigValidated` is a module-level boolean shared across all `createRateLimiter()` instances. If the first `check()` call comes from a limiter whose Redis pipeline errors and falls through to in-memory, the flag is set to `true` and all subsequent limiters skip `validateRedisConfig()`.
**Impact:** In production with a misconfigured Redis, the system silently falls back to per-process in-memory maps without any operator signal.
**Recommended action:** Call `validateRedisConfig()` once at application startup (e.g., in `instrumentation.ts`) rather than lazily inside `check()`. Remove the module-level flag.

### F2 — Major: Silent Redis failure degrades to per-process in-memory without alerting

**File:** `src/lib/rate-limit.ts:55`
**Problem:** `checkRedis()` catches all Redis errors and returns `null` (fallback to in-memory) without logging. In a horizontally scaled deployment, each process has its own Map — rate limits are not shared.
**Impact:** Vault unlock (5/5min), passphrase change (3/15min), and other brute-force-sensitive endpoints become bypassable by load-balancer round-robin during Redis outages.
**Recommended action:** Log Redis errors at `error` level in the catch block. Consider surfacing Redis availability in the readiness probe (`/api/health/ready`).

### F3 — Major: `/api/vault/admin-reset` has no rate limiter

**File:** `src/app/api/vault/admin-reset/route.ts`
**Problem:** This destructive endpoint (deletes all vault data) has no rate limit, while the equivalent `/api/vault/reset` has 3/15min.
**Impact:** Unbounded DB load from rapid requests. Asymmetric protection with its counterpart.
**Recommended action:** Apply `createRateLimiter({ windowMs: 15 * 60_000, max: 3 })` keyed on `userId`.

### F4 — Major: `/api/vault/unlock/data` returns encrypted key material without rate limit

**File:** `src/app/api/vault/unlock/data/route.ts`
**Problem:** Returns encrypted secret key, account salt, KDF parameters, and ECDH private key with no throttle. The server-side passphrase verification endpoint (`/api/vault/unlock`) is limited to 5/5min, but the data endpoint is unlimited.
**Impact:** A compromised session can exfiltrate encrypted key material at high frequency for offline attack.
**Recommended action:** Apply rate limiter (e.g., 20/5min) keyed on `userId`.

### F5 — Major: Recovery key flow shares a single rate-limit budget across verify+reset

**File:** `src/app/api/vault/recovery-key/recover/route.ts`
**Problem:** Both `verify` and `reset` steps consume the same 5/15min budget. No `clear()` on success.
**Impact:** At most 2 complete recovery round-trips per window. A user locked in active recovery could wait 15 minutes unnecessarily.
**Recommended action:** Separate rate-limit keys for verify (10/15min) and reset (3/15min), or clear on successful reset.

### F6 — Minor: Key prefix inconsistency

**Problem:** Most limiters use `rl:` prefix, but WebAuthn routes use `webauthn:` prefix. CSP report endpoint uses a hand-rolled Map instead of `createRateLimiter()`.
**Recommended action:** Standardize all keys to `rl:` prefix. Refactor CSP report to use `createRateLimiter()`.

### F7 — Minor: `retryAfterMs` computed but discarded in most 429 responses

**Problem:** REST API v1 routes return `Retry-After` header correctly. All other routes (~25 endpoints) return 429 without the header, despite `retryAfterMs` being available.
**Recommended action:** Create a shared helper `rateLimitedResponse(retryAfterMs)` and use it universally.

## Security Findings

### S1 — Major: No rate limit on credential/token creation endpoints

**Files:** `src/app/api/api-keys/route.ts`, `src/app/api/tenant/scim-tokens/route.ts`
**Problem:** API key creation (POST) and SCIM token creation (POST) have no rate limits. API keys provide long-lived access to `/api/v1/*` that survives session termination.
**Impact:** A compromised session can rapidly generate persistent access tokens up to `MAX_API_KEYS_PER_USER`, establishing backdoor access.
**Recommended action:** Apply per-userId limiter (5/60min) for API keys, per-tenantId limiter (5/60min) for SCIM tokens.

### S2 — Major: `/api/directory-sync/[id]/run` unbounded sync trigger

**File:** `src/app/api/directory-sync/[id]/run/route.ts`
**Problem:** No rate limit on manual directory sync trigger. Each sync is network/DB-intensive.
**Impact:** A compromised admin can trigger continuous sync cycles causing resource exhaustion against both the application DB and external IdP.
**Recommended action:** Add per-configId limiter (1/60s).

### S3 — Major: File upload endpoint lacks rate limit

**File:** `src/app/api/passwords/[id]/attachments/route.ts` (and team equivalent)
**Problem:** Attachment upload has no rate limit. Per-entry attachment count cap exists but no per-user frequency throttle.
**Impact:** Storage exhaustion attacks. Orphaned blob objects from failed DB inserts.
**Recommended action:** Apply per-userId limiter (30 uploads/min). Consider adding per-user aggregate storage quota.

### S4 — Minor: Fixed-window algorithm allows boundary burst

**Problem:** All limiters use fixed-window counter. An attacker can send 2N requests at the window boundary.
**Impact:** Vault unlock allows 10 attempts in ~0 seconds at the boundary (vs intended 5/5min). Account lockout partially compensates.
**Recommended action:** For high-sensitivity endpoints (vault unlock, passkey verify, recovery key), consider sliding-window algorithm.

### S5 — Minor: Magic link silent drop is unlogged

**File:** `src/auth.config.ts`
**Problem:** When magic link rate limit is hit, the request is silently dropped (anti-enumeration), but no log is emitted.
**Impact:** An attacker exhausting the limit for a legitimate user is undetectable in audit logs.
**Recommended action:** Log a warn-level event (without email address) when the limiter drops a request.

### S6 — Minor: Team key rotation has no rate limit

**File:** `src/app/api/teams/[teamId]/rotate-key/route.ts`
**Problem:** No throttle on team key rotation (each rotation locks DB for up to 60s and forces all members to re-download keys).
**Impact:** Business logic DoS targeting team availability.
**Recommended action:** Add per-teamId limiter (1/5min).

## Testing Findings

### T1 — Major: Duplicate test files with inconsistent mock patterns for verify-access

**Files:** `src/app/api/share-links/verify-access/route.test.ts` vs `src/__tests__/api/share-links/verify-access.test.ts`
**Problem:** Both test the same route. `route.test.ts` correctly uses `callCount` to differentiate IP and token limiters. `__tests__` version shares a single mock for both, making it impossible to test "IP passes but token blocks" scenarios.
**Recommended action:** Remove the `__tests__` version or unify the mock pattern.

### T2 — Major: `redisConfigValidated` not reset between tests

**File:** `src/__tests__/lib/rate-limit.test.ts`
**Problem:** Module-level `redisConfigValidated` is set to `true` after the first `check()` call and never reset. Test execution order may affect `validateRedisConfig()` behavior.
**Recommended action:** Use `vi.resetModules()` in the relevant describe block or isolate the validateRedisConfig tests.

### T3 — Major: `Retry-After` header not asserted in non-v1 route tests

**Problem:** Only REST API v1 tests verify the `Retry-After` header. Non-v1 routes (vault, emergency access, tenant, etc.) don't assert header presence even when `retryAfterMs` is set in mocks.
**Recommended action:** Add `Retry-After` assertions to all 429 response tests.

### T4 — Minor: In-memory eviction logic (10,000 cap) untested

**File:** `src/lib/rate-limit.ts:75-82`
**Problem:** The `RATE_LIMIT_MAP_MAX_SIZE` eviction path and `store.clear()` fallback have no tests.
**Recommended action:** Add tests with a small override of `RATE_LIMIT_MAP_MAX_SIZE` to verify eviction behavior.

### T5 — Minor: Rate-limit files excluded from coverage report

**Problem:** `vitest.config.ts` `coverage.include` doesn't include `src/lib/rate-limit.ts` or `src/lib/redis.ts`.
**Recommended action:** Add to coverage include list.

### T6 — Minor: `callCount` mock pattern fragile in verify-access test

**File:** `src/app/api/share-links/verify-access/route.test.ts:39-48`
**Problem:** Closure variable `callCount` isn't reset between tests. Works now but will break if `vi.resetModules()` is added later.
**Recommended action:** Use `vi.fn().mockReturnValueOnce(...)` chain instead.

## Adjacent Findings

### [Adjacent] S→F: `validateRedisConfig()` exception propagates as unhandled error

**Source:** Security expert → Functionality scope
**Problem:** If `validateRedisConfig()` throws (production, no REDIS_URL), the exception propagates out of `check()`. Most callers don't wrap rate-limit checks in try/catch, so the behavior depends on the route's error boundary — potentially returning 500 (DoS) or failing open.
**Recommended action:** Wrap `validateRedisConfig()` in try/catch inside `check()` and fall back to in-memory with error log, or validate at startup.

## Findings Summary

| ID | Severity | Category | Problem |
|----|----------|----------|---------|
| F1 | Major | Functionality | `redisConfigValidated` global bypass |
| F2 | Major | Functionality | Silent Redis failure, no alerting |
| F3 | Major | Functionality | `/api/vault/admin-reset` no rate limit |
| F4 | Major | Functionality | `/api/vault/unlock/data` no rate limit |
| F5 | Major | Functionality | Recovery key shared budget |
| F6 | Minor | Functionality | Key prefix inconsistency |
| F7 | Minor | Functionality | `retryAfterMs` discarded in responses |
| S1 | Major | Security | API key / SCIM token creation no rate limit |
| S2 | Major | Security | Directory sync trigger no rate limit |
| S3 | Major | Security | File upload no rate limit |
| S4 | Minor | Security | Fixed-window boundary burst |
| S5 | Minor | Security | Magic link silent drop unlogged |
| S6 | Minor | Security | Team key rotation no rate limit |
| T1 | Major | Testing | Duplicate test files with mock inconsistency |
| T2 | Major | Testing | `redisConfigValidated` test isolation |
| T3 | Major | Testing | Missing `Retry-After` assertions |
| T4 | Minor | Testing | Eviction logic untested |
| T5 | Minor | Testing | Coverage config incomplete |
| T6 | Minor | Testing | Fragile callCount mock |
| Adj | Major | Adjacent | `validateRedisConfig` unhandled exception |

**Totals:** Critical: 0 / Major: 12 / Minor: 8
