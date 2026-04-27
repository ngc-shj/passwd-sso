# Plan: Session Cache Redesign (pre2 — revocation bypass window)

Date: 2026-04-27
Status: Phase 1 plan — under review
Source review: [sessioncache-redesign-pre2-prompt.md](./sessioncache-redesign-pre2-prompt.md)
Origin finding: [csrf-admin-token-cache-review.md](./csrf-admin-token-cache-review.md) — pre2

---

## Project context

- **Type**: web app (Next.js 16 App Router) + service (separate audit-outbox worker)
- **Test infrastructure**: unit + integration (vitest, real Postgres + Redis containers via `npm run test:integration`) + CI/CD (GitHub Actions; pre-PR script `scripts/pre-pr.sh`)
- Test framework: vitest. Mocks via `vi.mock`; real-DB integration tests live in `src/__tests__/integration/`.

Severity expectations: experts MAY raise Major/Critical for missing tests when the test infrastructure already exists for the surface (it does for proxy / Redis / session).

---

## Objective

Eliminate the in-process session cache's two functional defects without regressing the latency benefit it provides on the auth hot path:

1. **Revocation bypass window**: A session deleted via `DELETE /api/sessions/[id]` (or `invalidateUserSessions`) currently remains accepted for up to `SESSION_CACHE_TTL_MS` (30 s) on every Node worker that cached it.
2. **Plaintext token in process memory**: The cache key is the raw cookie value. Heap snapshots, debug logging, or any exfiltration of process memory leaks live, valid session tokens.

A third concern — multi-worker inconsistency — is a direct consequence of (1): once cache is correctly invalidated cross-worker, the inconsistency is gone.

---

## Requirements

### Functional

- **F-Req-1** Session revocation propagates to all workers within ≤ 1 second (P99) of `DELETE /api/sessions/[id]` or `invalidateUserSessions()` returning to its caller.
- **F-Req-2** `getSessionInfo()`'s public signature MUST remain unchanged (return type `Promise<SessionInfo>`, single `NextRequest` argument). All current callers (`src/lib/proxy/page-route.ts`, `src/lib/proxy/api-route.ts`) continue to work without modification.
- **F-Req-3** When Redis is unavailable, the system continues to serve protected requests (no hard dependency added on top of the existing rate-limit fallback contract). Behavior is **fail-closed for the cache, fail-open for auth**: cache miss → DB lookup via existing `/api/auth/session` fetch path. This is the same behavior as a cold cache today; nothing regresses.
- **F-Req-4** Cache hit must return data semantically equivalent to the current in-process cache (all `SessionInfo` fields populated identically).
- **F-Req-5** Tenant-scoped resolution (`resolveUserTenantId`) must NOT be re-run on cache hit. The full `SessionInfo` (including `tenantId`) is what's cached and what's served.

### Non-functional

- **NF-Req-1 (Latency)** Median added latency on cache-hit path ≤ 5 ms over the current in-process Map; P99 ≤ 10 ms. Measured against local Redis (1 RTT). Cache-miss path latency unchanged.
- **NF-Req-2 (Memory)** No new in-process unbounded structures. If an in-process L1 layer is added, it MUST keep the existing `SESSION_CACHE_MAX = 500` cap and TTL-then-FIFO eviction (already proven by tests in `src/__tests__/proxy.test.ts:557-633`).
- **NF-Req-3 (Observability)** Redis errors during cache operations log via the same throttled-logger pattern as `src/lib/security/rate-limit.ts:6-15` (no token leakage in error messages; ≤ 1 log per 30 s per worker).
- **NF-Req-4 (Compatibility)** No DB schema change. No change to `Session` table, no change to Auth.js cookie name/format, no change to `@auth/prisma-adapter` config.
- **NF-Req-5 (No new dependency)** Use existing `ioredis` client via `getRedis()`. No new npm package.

### Security

- **S-Req-1** Cache key MUST NOT be the raw session token. Use HMAC-SHA-256(token, sessionCacheHmacKey) — keyed hash so a Redis-WRITE attacker without the master key cannot pre-compute keys for arbitrary tokens. Sole rationale: defense against Redis-poisoning of arbitrary unknown tokens. (The "shared Redis across envs" rationale was removed after review — Redis is not shared across envs in this product per docker-compose.)
- **S-Req-2** Cache value MUST NOT contain the session token, the tenant master key, or any field not already present in `SessionInfo` today. **Cache value MUST be Zod-validated on every read** (`SessionInfoSchema.safeParse(JSON.parse(raw))`). On parse/schema failure, treat as cache miss AND `redis.del(key)` to evict the poisoned entry. The bare `as SessionInfo` cast at the boundary is forbidden.
- **S-Req-3** HMAC key is a non-rotating subkey derived from the MASTER key version 1 via HKDF-SHA-256, computed once at module load and memoized. Rotating the underlying master key V1 itself becomes an out-of-band operation requiring `redis-cli FLUSHDB` (documented in the rotation runbook).
   ```
   sessionCacheHmacKey = HKDF-SHA-256(
     ikm: getMasterKeyByVersion(1),
     salt: "session-cache-hmac-v1",
     info: "",
     length: 32,
   )
   ```
   Pinning to V1 + HKDF derivation eliminates: (a) the cross-version cache-key drift on rotation; (b) the per-call KeyProvider warm-up requirement that fails closed during cold start; (c) domain entanglement with share-link AES-GCM rotation cadence.
- **S-Req-4** When a session is revoked, its cache entry MUST be deleted on every worker before the user's next request reaches the proxy. Bound: ≤ 1 second propagation lag, contingent on Redis availability. Redis-down case widens to ≤ `SESSION_CACHE_TTL_MS` (same as today).
- **S-Req-5** Cache TTL is `min(SESSION_CACHE_TTL_MS, session.expires - now)`. **If `expires - now < 1000 ms`, do NOT cache** (entry would outlive the session row in the DB). Otherwise clamp `[1000, SESSION_CACHE_TTL_MS]` for Redis PX validity.
- **S-Req-6** Negative results (`valid: false`) MAY be cached but with a STRICT short TTL (`NEGATIVE_CACHE_TTL_MS = 5_000` ms; never longer). Rationale balance: a 30-s pin globalizes transient `/api/auth/session` faults across workers (S-8) and multiplies Redis-poisoning DoS blast; zero caching opens a brute-force amplifier against `/api/auth/session` (S-15 — there is no IP-rate-limit on that route at proxy level today). 5 s threads the needle: any DB-driven brute-force must hit Redis before the DB on the second + attempt within the window, while a transient 5xx pins for at most 5 s. The negative-cache shape `{ valid: false }` is distinct from the tombstone shape `{ tombstone: true }` — see C1 Implementation notes.
- **S-Req-7** Cache value MUST NOT be returned to the proxy as a stale tenant-policy snapshot. When `requirePasskey` (or `requirePasskeyEnabledAt`, `passkeyGracePeriodDays`) is changed via `PATCH /api/tenant/policy`, all cached sessions for that tenant MUST be invalidated. See C3 row #9.

---

## Technical approach

### Decision matrix (orientation; final selection driven by Phase 1 expert review)

| Option | Revocation propagation | Latency vs. today | Implementation cost | Failure mode if Redis down |
|---|---|---|---|---|
| (a) TTL shortening only (30 s → 5 s) | Still 5 s window per worker | Same | Trivial | N/A — purely in-memory |
| (b) Redis-backed cache + hashed key + active invalidation | Immediate (single source of truth) | +1-2 ms (1 RTT to Redis) | Medium | Cache miss → DB lookup (current cold-cache behavior) |
| (c) In-process cache + Redis Pub/Sub broadcast for invalidation | ~Pub/Sub jitter (10-100 ms) | Same as today | High (Pub/Sub miss handling, multi-subscriber lifecycle) | In-process still works; missed invalidation = revocation gap |
| (d) Remove cache entirely | Immediate | Significantly worse (DB on every request) | Trivial | N/A |

**Recommended: (b) Redis-backed cache with hashed keys**, with an optional thin in-process L1 (≤ 1 second TTL) as a tail-latency optimization. (c) is rejected because Pub/Sub miss recovery is harder to reason about than a single-source-of-truth model and the on-paper "minimal change" turns into a more complex correctness story. (a) does not solve S-Req-1. (d) blows the latency budget.

The expert review rounds may revisit this; the recommendation is anchored, not committed.

### Architecture (option b, recommended)

```
┌───────────────────────────────────────────────────────────────┐
│  Request → proxy → getSessionInfo(req)                         │
│                                                                 │
│  0. (one-time at module load) sessionCacheHmacKey =             │
│     HKDF-SHA256(getMasterKeyByVersion(1), "session-cache-hmac-v1") │
│  1. cacheKey = HMAC-SHA256(token, sessionCacheHmacKey).hex      │
│  2. Redis GET sess:cache:<cacheKey>                             │
│     - hit → JSON.parse → SessionInfoSchema.safeParse            │
│        - schema OK → return SessionInfo                          │
│        - schema fail → redis.del(key); fall through to miss     │
│     - miss → fetch /api/auth/session                            │
│        - valid: true && userId → SET with PX TTL                │
│        - valid: false → DO NOT CACHE                            │
│        - return SessionInfo to caller                           │
│  3. On Redis error: log throttled (with err.code), fall through │
└───────────────────────────────────────────────────────────────┘

  Revocation path:
    DELETE /api/sessions/[id] / invalidateUserSessions(userId) /
    passkey verify rotation / Auth.js deleteSession / etc.
       ↓
    [DB transaction commits]   ← MUST come first
       ↓
    For each affected sessionToken: Redis SET sess:cache:<HMAC(token)>
       JSON.stringify({ tombstone: true }) PX 30_000   ← write tombstone (see C3 last block)
       ↓
    Audit log write (existing flow)
```

**Sequencing invariant**: cache invalidation runs in `await` sequence AFTER the corresponding `withBypassRls` / `$transaction` resolves successfully — NEVER in parallel via `Promise.all` with the delete. The DB write must be observable before cache eviction, otherwise a TOCTOU window reopens.

### Components

#### C1. `src/lib/auth/session/session-cache.ts` (new)

Single module that owns the Redis-backed cache. Public surface:

```ts
export interface SessionInfo {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  hasPasskey?: boolean;
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
}

/** Zod schema for runtime validation on cache reads. Mirrors SessionInfo exactly. */
export const SessionInfoSchema: z.ZodType<SessionInfo>;

/** HMAC-SHA-256(token, sessionCacheHmacKey).hex — 64 hex chars. Pure function. */
export function hashSessionToken(token: string): string;

/** Get cached SessionInfo or null on miss / Redis error / schema-fail (auto-evicts poisoned). */
export async function getCachedSession(token: string): Promise<SessionInfo | null>;

/** Set cache. NO-OP when info.valid is false, info.userId is missing, or expires-now < 1000ms. */
export async function setCachedSession(token: string, info: SessionInfo, ttlMs: number): Promise<void>;

/** Invalidate cache by token. Best-effort, never throws. */
export async function invalidateCachedSession(token: string): Promise<void>;

/** Constants — re-exported from validations/common.server.ts (single source). */
export { SESSION_CACHE_TTL_MS, SESSION_CACHE_KEY_PREFIX } from "@/lib/validations/common.server";
```

**Module-level state (memoized lazy-init):**

```ts
let _sessionCacheHmacKey: Buffer | null = null;
function getSessionCacheHmacKey(): Buffer {
  if (_sessionCacheHmacKey) return _sessionCacheHmacKey;
  // Pin to V1 forever; rotation of V1 itself is an out-of-band op requiring redis FLUSHDB.
  // Note: hkdfSync returns ArrayBuffer; Buffer.from() wraps zero-copy.
  // Salt-vs-info convention follows RFC 5869 idiom (salt empty for static-domain keys, info as context).
  const ikm = getMasterKeyByVersion(1);
  const okm = crypto.hkdfSync("sha256", ikm, /*salt*/ "", /*info*/ "session-cache-hmac-v1", 32);
  _sessionCacheHmacKey = Buffer.from(okm);
  return _sessionCacheHmacKey;
}
```

The first call resolves the master key (warming the KeyProvider if needed via `validateKeys()` having run at startup). Subsequent calls are pure memory reads. Resolves S-2, S-5, S-11. (F-10: hkdfSync return type → `Buffer.from` wrap; S-16: salt empty / info as context per RFC 5869 idiom.)

**Constants placement**: `SESSION_CACHE_MAX = 500` already lives in `src/lib/validations/common.server.ts:52`. `SESSION_CACHE_MAX` becomes effectively dead after the in-process Map is removed — delete it in the same PR (R23 cleanup) since no consumer remains. Add `SESSION_CACHE_TTL_MS = 30_000` and `SESSION_CACHE_KEY_PREFIX = "sess:cache:"` to the same module.

**Implementation notes:**
- `hashSessionToken` uses `crypto.createHmac("sha256", getSessionCacheHmacKey()).update(token).digest("hex")`.
- `getCachedSession` flow (ORDER MATTERS — S-12):
  1. `GET key` → if `null` return `null`.
  2. `JSON.parse` (try/catch). On parse error: `redis.del(key)` AND return `null` — invalid bytes get evicted.
  3. **Tombstone-shape pre-check FIRST** (before schema validation): if parsed object has `tombstone === true`, return `null` and DO NOT delete the key. The tombstone must be preserved so concurrent populates remain blocked. This is critical — checking schema before tombstone-shape would schema-fail the tombstone and DEL it (re-opening the race).
  4. `NegativeCacheSchema.safeParse(parsed)` (matches `{ valid: false }` exactly): on success return `{ valid: false }`.
  5. `SessionInfoSchema.safeParse(parsed)`: on success return; on failure `redis.del(key)` (poison evict) and return `null`.
- `setCachedSession` flow:
  - When `info.valid === true && info.userId`: clamp `ttlMs` to `[1000, SESSION_CACHE_TTL_MS]`; if `ttlMs < 1000` early-return (S-Req-5). Otherwise `redis.set(key, JSON.stringify(info), "PX", ttlMs, "NX")` — NX prevents overwriting tombstones (F-1).
  - When `info.valid === false`: write a short-lived NEGATIVE-cache entry — `redis.set(key, JSON.stringify({ valid: false }), "PX", NEGATIVE_CACHE_TTL_MS, "NX")` where `NEGATIVE_CACHE_TTL_MS = 5_000` (5 seconds). This restores natural rate-limiting against `/api/auth/session` brute-force traffic (S-15) while bounding S-8 DoS-poisoning blast to 5 s instead of 30 s. Negative cache is asymmetric to positive: 5 s ceiling vs 30 s ceiling.
- `invalidateCachedSession(token)` writes a tombstone, NOT a `DEL`:
  - `redis.set(key, JSON.stringify({ tombstone: true }), "PX", TOMBSTONE_TTL_MS)`. `TOMBSTONE_TTL_MS = 5_000` (5 s) — sufficient to cover the populate window (NF-Req-1 ≤10 ms typical, ≤5 s p99 even under DB stress) without amplifying tombstone keyspace under sustained revoke pressure (S-14).
- `NegativeCacheSchema` and `TombstoneShape` are exported from `session-cache.ts` so tests can construct them as typed literals (T-14, T-17).
- All three async functions catch Redis errors and log via the throttled logger with the Redis error code (S-10 fix). Best-effort semantics: never throws to caller. Token is never logged.

**Note on F-9 / S-14 tombstone TTL choice (5 s vs 30 s)**: Round 1 design used 30 s (matching SESSION_CACHE_TTL_MS). Round 2 review surfaced two issues — (a) F-9: a slow `/api/auth/session` straddling revocation could outlast a 30 s tombstone TTL; (b) S-14: tombstone keyspace can grow under sustained revoke pressure. Lowering to 5 s addresses both: (a) is treated as residual hazard documented in Failure semantics — `/api/auth/session` p99 must stay below 5 s for the guarantee; (b) keyspace shrinks 6×. Operators monitoring `session-cache.redis.fallback` AND `/api/auth/session` p99 latency will see this. Out-of-budget auth fetches (>5 s) are themselves a service-degradation event the operator must address.

**Throttled error logger**: the `lastRedisErrorLog` + 30-second-interval pattern in `src/lib/security/rate-limit.ts:7-15` is duplicated. Extract to `src/lib/logger/throttled.ts`:

```ts
export function createThrottledErrorLogger(intervalMs: number, message: string): (errCode?: string) => void;
```

The factory closes over `lastLogAt`. The returned logger accepts an optional `errCode` (e.g., `"ECONNREFUSED"`, `"NOAUTH"`) and emits `getLogger().error(message, { code: errCode ?? "unknown" })`. Both `rate-limit.ts` and `session-cache.ts` consume it. Resolves S-10. New file ships with `src/lib/logger/throttled.test.ts` (asserts: fires once per interval, fires again after interval, message string is fixed).

#### C2. `src/lib/proxy/auth-gate.ts` (modify)

- Remove the in-process `Map<string, ...>` cache and `setSessionCache()`.
- Re-export `SessionInfo` and `SESSION_CACHE_TTL_MS` from `session-cache.ts` for backward compatibility (existing test imports continue to work).
- `getSessionInfo()` body becomes:
  1. Extract token (existing `extractSessionToken`).
  2. `getCachedSession(token)` → if hit, return.
  3. Fetch from `/api/auth/session`, build `SessionInfo`, then `setCachedSession(token, info, ttlMs)`.
  4. `ttlMs` derivation: parse `data.expires` (ISO 8601 from Auth.js) → `min(SESSION_CACHE_TTL_MS, expires - now)`. If parse fails, use `SESSION_CACHE_TTL_MS`.

#### C3. Session-deletion / policy-change sites — enumerated invalidation (R3 sweep)

**Pattern propagation obligation**: every site that mutates `Session` rows OR mutates tenant fields cached in `SessionInfo` MUST invalidate the cache for the affected token(s). A single missed site re-introduces the bug. The complete inventory:

| # | File:line | Trigger | Tokens to invalidate | Notes |
|---|---|---|---|---|
| 1 | `src/app/api/sessions/[id]/route.ts:58` | User revokes one session by id | `target.sessionToken` (already loaded for "current session" check) | — |
| 2 | `src/app/api/sessions/route.ts:100` | "Sign out everywhere" — deletes all sessions except current | `SELECT sessionToken WHERE userId AND not currentToken` before delete | — |
| 3 | `src/app/api/auth/passkey/verify/route.ts:105` | Passkey rotation — deletes ALL prior sessions for user atomically | `SELECT sessionToken WHERE userId` inside the same `tx`, before deleteMany | invalidate AFTER `$transaction` resolves |
| 4 | `src/lib/auth/session/user-session-invalidation.ts:19` | Team member removal / SCIM deactivation | `SELECT sessionToken WHERE userId AND tenantId` before deleteMany | — |
| 5 | `src/lib/auth/session/auth-adapter.ts:277` | Concurrent-session-limit eviction in `createSession` | sessionTokens of evicted rows | **type propagation required** — see below |
| 6 | `src/lib/auth/session/auth-adapter.ts:401` | Auth.js `deleteSession(token)` (sign-out flow, expired-session GC) | the input parameter `sessionToken` | — |
| 7 | `src/lib/auth/session/auth-adapter.ts:473,484` | Idle / absolute timeout deletion in `updateSession` | the input parameter `session.sessionToken` | — |
| 8 | `src/lib/auth/session/auth-adapter.ts:382` `deleteUser` | Auth.js account deletion → Postgres cascades to Session rows | `SELECT sessionToken FROM Session WHERE userId = $1` BEFORE `prisma.user.delete` | F-A-4. Cascade does NOT invoke per-row `deleteSession`. Capture tokens, then user.delete, then invalidate. |
| 9 | `src/app/api/tenant/policy/route.ts` (PATCH) | Tenant admin changes `requirePasskey` or `passkeyGracePeriodDays` (the route derives `requirePasskeyEnabledAt` server-side from the requirePasskey transition; not a separate client field — F-12) | `SELECT sessionToken FROM Session WHERE tenantId = $1 AND expires > now()` after the policy update transaction commits, before responding 200. Fires only when the resolved updateData actually mutates `requirePasskey` or `passkeyGracePeriodDays` — compare against the existing `currentTenant` already loaded for set-once logic at policy/route.ts:566-593. | S-Req-7 / S-3. **Synchronous (S-13)**: invalidation MUST complete before the 200 response — no fire-and-forget. **Pipelined**: use `redis.pipeline()` for the bulk SET tombstones (single round-trip even for thousands of sessions) so the route latency stays bounded for enterprise tenants. |

**Type propagation for site #5 (F-2)**: at `src/lib/auth/session/auth-adapter.ts:262-272`, `tx.session.findMany` selects `{ id, ipAddress, userAgent }`. Add `sessionToken` to the select. The escaping local `evictionInfo.evicted` (line ~329-330) is shaped `{ id, ipAddress, userAgent }[]` — widen the cast/inferred type to `{ id, sessionToken, ipAddress, userAgent }[]`. The downstream consumer (`for (const ev of evicted)` block, ~line 350+) MUST then call `invalidateCachedSessions([...evicted.map(e => e.sessionToken)])` AFTER the audit + notification block that currently uses `evictionInfo`. Implementation step lists this explicitly.

**Helper to centralize the pattern**: introduce `src/lib/auth/session/session-cache-helpers.ts`:

```ts
/** Best-effort cache invalidation for an array of session tokens.
 *  Failure is logged via the throttled logger; never throws. */
export async function invalidateCachedSessions(tokens: ReadonlyArray<string>): Promise<void>;
```

Each of sites 1-9 calls `invalidateCachedSessions([...tokens])` AFTER the DB write commits. Sites 5, 6, 7 lift the token without an extra SELECT (already at hand). Sites 2, 3, 4, 8, 9 need one extra SELECT each — acceptable since these are infrequent revocation/policy paths, not the per-request hot path.

**TOCTOU populate-after-invalidate guard (F-1)**: a request whose `getSessionInfo` is in-flight when revocation fires can `setCachedSession` AFTER `invalidateCachedSession` ran (racing on Redis), restoring a stale entry for up to 30 s. Defense: **per-token tombstone with NX-protected populate**:

1. `invalidateCachedSession(token)` writes a tombstone instead of plain `DEL`:
   ```
   redis.set(key, JSON.stringify({ tombstone: true }), "PX", SESSION_CACHE_TTL_MS)
   ```
2. `setCachedSession(token, info, ttlMs)` uses `redis.set(key, val, "PX", ttlMs, "NX")` — fails if any value (including a tombstone) is present. The populate-after-invalidate write is rejected; cache stays empty (or stays tombstoned) until tombstone TTL.
3. `getCachedSession(token)` parses the value and treats `{tombstone: true}` as a cache miss (no schema validation needed for tombstone — it's a dedicated shape). On tombstone hit the function does NOT delete (let it TTL out — concurrent populates need it to remain).

This bounds the race to "tombstone TTL ≤ SESSION_CACHE_TTL_MS = 30 s of NO caching for that token", which is correctness-preserving (next request DB-fetches every time during that window). After tombstone TTL expires, normal populate works again.

#### C4. Tests

See "Testing strategy" below.

### Concrete data shapes

Cache value (Redis SET payload, JSON):
```json
{
  "valid": true,
  "userId": "uuid-v4",
  "tenantId": "uuid-v4-or-null",
  "hasPasskey": true,
  "requirePasskey": false,
  "requirePasskeyEnabledAt": null,
  "passkeyGracePeriodDays": null
}
```

Redis key shape: `sess:cache:<64-hex-chars>` — the prefix is fixed so that `evictAll` operations (future) can use `SCAN MATCH sess:cache:*` if needed; not part of this plan.

### Why HMAC and not plain SHA-256

Plain SHA-256 of a session token (which has ≥ 256 bits of entropy from Auth.js) would also be defensible — and is the codebase precedent (`hashToken` in `src/lib/crypto/crypto-server.ts:165`, used by SCIM/SA/API key/extension token storage). Choosing HMAC for **this specific surface** anchors a server-side secret in the hash to defeat one attack class:

- **Redis poisoning of arbitrary unknown tokens**: an attacker with Redis WRITE but without the master key cannot pre-compute keys for tokens they have not observed and seed fake `valid: true` entries. (Note: an attacker who *has observed* a specific token via a separate leak can still tamper with the existing entry's value — that is the threat S-Req-2 / Zod validation addresses, not S-Req-1.)

The "cross-environment hash equality" rationale was removed after review: in this product Redis is per-deployment-stack (docker-compose `internal` network). It is not shared across envs.

Cost: a single HMAC operation per request is negligible (~ 1 µs).

### Cross-tenant safety invariant

Cache safety relies on Auth.js's invariant that session tokens are globally unique (256-bit `crypto.randomBytes(32)` per `src/auth.ts`). Two tenants cannot collide on a session token, so a token-only cache key is safe. **If the token-generation path is ever changed** (e.g., to per-tenant scoping or a deterministic algorithm), this cache MUST be re-keyed to include `tenantId` in the HMAC input. This is a load-bearing assumption — comment it in `session-cache.ts`.

### Optional in-process L1 (deferred)

A 1-second in-process L1 above the Redis cache would reduce P50 latency further on burst traffic from the same user. Out of scope for this plan — adds complexity (per-worker invalidation needs Pub/Sub again to keep L1 fresh on revocation, contradicting the simplicity goal of choice (b)). Re-evaluate if measured Redis-cache-hit latency exceeds NF-Req-1.

---

## Implementation steps

1. **Move constants** to `src/lib/validations/common.server.ts`: add `SESSION_CACHE_TTL_MS = 30_000` and `SESSION_CACHE_KEY_PREFIX = "sess:cache:"`. **Delete `SESSION_CACHE_MAX`** (in-process Map removed; constant becomes dead code — R23).
2. **Extract throttled error logger** to `src/lib/logger/throttled.ts` (`createThrottledErrorLogger(intervalMs, message): (errCode?: string) => void`). Update `src/lib/security/rate-limit.ts:7-15` to consume it (now logs `{ code: err?.code ?? "unknown" }`). Add `src/lib/logger/throttled.test.ts` (3 tests: fires once, fires again after interval, message string is fixed).
3. **Add `src/lib/auth/session/session-cache.ts`**: `SessionInfoSchema` (Zod), memoized `getSessionCacheHmacKey()` via HKDF from V1, `hashSessionToken`, `getCachedSession`, `setCachedSession`, `invalidateCachedSession` (writes tombstone), with the populate-after-invalidate guard (NX populate, tombstone-on-invalidate). Unit-test in isolation (mocked `getRedis`).
4. **Add `src/lib/auth/session/session-cache-helpers.ts`**: `invalidateCachedSessions(tokens)`.
5. **Modify `src/lib/proxy/auth-gate.ts`**:
   - Remove in-process Map and `setSessionCache`. Remove `_sessionCache` / `_setSessionCache` exports.
   - Replace doc-comment header (currently lines 1-12) with the new architecture summary; remove the "Future improvement: migrate to a shared Redis cache" sentence (now done).
   - Re-export `SessionInfo` and `SESSION_CACHE_TTL_MS` from `session-cache.ts` for back-compat with current test imports.
   - `getSessionInfo`: extract token → `getCachedSession` → on hit return; on miss, fetch `/api/auth/session`. If response is `valid: false` (no user), return `{ valid: false }` WITHOUT caching (S-Req-6).
   - For positive results, derive `ttlMs` from `data.expires` (parse ISO 8601 → `Math.max(0, expires - now)`; on parse failure use `SESSION_CACHE_TTL_MS`). Pass `ttlMs` to `setCachedSession`, which is responsible for the `< 1000ms → no-op` and clamp logic (S-Req-5).
6. **Update test surface in `src/__tests__/proxy.test.ts`**:
   - Replace `_sessionCache` / `_setSessionCache` direct-Map manipulation with `vi.mock("@/lib/auth/session/session-cache", ...)` and assertions against the mocked helpers.
   - **Delete in-process eviction tests entirely** (lines 557-633). Redis TTL replaces both passes; no per-Map eviction behavior to preserve (F-6 plan-clarity fix).
   - **Rename** the TTL test (line 924+) from "re-fetches session after `SESSION_CACHE_TTL_MS` expires" to "re-fetches session on Redis cache miss". Remove `vi.useFakeTimers()` scaffolding — Redis TTL is real-time, fake timers don't advance it. The actual TTL math (clamp + `< 1000ms` no-op) moves to `session-cache.test.ts` (T-8).
7. **Update all 9 sites in C3 inventory** to invalidate cache via `invalidateCachedSessions`. For sites 2, 3, 4, 8, 9 add the SELECT-tokens step. For site 5, propagate `sessionToken` through the type widening described in C3. Sequencing: invalidation runs in `await` order AFTER the DB write commits, never via `Promise.all` with the delete (S-6).
8. **Update each of the 9 sites' existing route/adapter tests** to assert that `invalidateCachedSessions` was called with the expected token list AFTER the DB delete mock resolved (T-7). For sites 4 (SCIM, team-member-removal), replace `vi.mock("@/lib/auth/session/user-session-invalidation", ...)` with `importOriginal()`-style partial mocks so the new SELECT-then-DEL behavior is exercised, OR add a separate non-mocked unit test for `user-session-invalidation` itself (T-11-A). **Extract two shared helpers** (T-16) — `expectInvalidatedAfterCommit(invalidateSpy, dbSpy, expectedTokens)` and `expectNotInvalidatedOnDbThrow(invalidateSpy, dbSpy)` — and have all 9 site tests consume them. Avoids 18 ad-hoc snippets (one positive + one negative per site).
9. **Add unit tests in `src/lib/auth/session/session-cache.test.ts`** (mocked Redis). Fixtures are constructed as TYPED LITERALS (no `as SessionInfo` casts, no spread from production helpers) — when `SessionInfo` gains a field, every fixture site fails to compile until updated (T-17 exact-shape obligation).
   - `hashSessionToken` is deterministic + 64-hex output.
   - `hashSessionToken` differs across master keys (ikm change → different output).
   - **Subkey identity invariant** (corrected per T-12): mock `getMasterKeyByVersion` (NOT `getCurrentMasterKeyVersion`); call `hashSessionToken("X")`. Assert: (a) `getMasterKeyByVersion` was called with the literal argument `1`, (b) the spy's call count is 1 across multiple `hashSessionToken("X")` calls (memoization). Then in a second test (use `vi.resetModules()` between cases): change the mock so `getMasterKeyByVersion(2)` returns DIFFERENT bytes — `hashSessionToken("X")` STILL returns the original hash, because the implementation pins to V1 and V1 bytes did not change. Replaces T-5.
   - `getCachedSession` returns `null` on Redis null.
   - `getCachedSession` returns parsed `SessionInfo` on valid JSON + schema entry.
   - `getCachedSession` returns `{ valid: false }` on a NegativeCache shape (`{ valid: false }`).
   - **`getCachedSession` returns `null` on tombstone shape AND does NOT call `redis.del`** (T-14 / S-12 correct ordering test). Verify by spying on `redis.del` and asserting it was NOT called when the GET returned `JSON.stringify({tombstone: true})`.
   - `getCachedSession` evicts (`redis.del`) AND returns `null` on a malformed JSON string (parse error eviction).
   - `getCachedSession` evicts AND returns `null` on a JSON-valid but schema-fail value that is NEITHER a tombstone NOR a NegativeCache (e.g., `{tombstoned: true}` typo OR `{userId: 123}` wrong type).
   - `setCachedSession({ valid: true, userId, ... }, ttlMs=2000)` calls `redis.set(key, JSON.stringify(info), "PX", 2000, "NX")` exactly (string-level — T-4 mock-reality guard).
   - `setCachedSession` clamps `ttlMs > SESSION_CACHE_TTL_MS` to `SESSION_CACHE_TTL_MS`.
   - `setCachedSession` is a no-op when `ttlMs < 1000` (S-Req-5).
   - `setCachedSession({ valid: false })` writes `JSON.stringify({ valid: false })` with `PX = NEGATIVE_CACHE_TTL_MS` and `NX` (S-Req-6 / S-15 short-TTL negative cache).
   - `setCachedSession` does NOT overwrite a tombstone — when Redis returns `null` from the NX `set` (NX rejection), no error is propagated.
   - `invalidateCachedSession` writes the tombstone (`redis.set(key, JSON.stringify({tombstone:true}), "PX", TOMBSTONE_TTL_MS)`) and does NOT issue a `DEL`. Assert exact stringified payload.
   - `invalidateCachedSession` is a no-op on Redis error (caught + throttled logger fired).
   - All three async functions catch synchronous throws from `hashSessionToken` / `getRedis` and never propagate to the caller.

   `src/lib/logger/throttled.test.ts` (T-13 specifics):
   - **Test (1) fires once per interval**: construct logger with constructor message `"M1"`; spy on `getLogger().error`; call returned function 5 times back-to-back; assert spy was called exactly once with `("M1", { code: "unknown" })`.
   - **Test (2) fires again after interval**: same setup; call once → advance fake timers by `intervalMs + 1` → call again. Assert spy was called twice, both with `"M1"`.
   - **Test (3) message is bound at construction, not per-call** (the high-value invariant): construct two loggers — `loggerA = createThrottledErrorLogger(intervalMs, "MA")`, `loggerB = createThrottledErrorLogger(intervalMs, "MB")`. Trigger each. Assert spy receives `"MA"` for loggerA and `"MB"` for loggerB. The factory closes over its own `lastLogAt` AND the message. Additionally, a TypeScript-level check (e.g., `expectTypeOf<Parameters<ReturnType<typeof createThrottledErrorLogger>>>().toEqualTypeOf<[string?]>()`) — the returned function's only optional parameter is `errCode?: string`. Future addition of a `message` parameter would be a compile error.
10. **Add integration test** `src/__tests__/db-integration/session-revocation-cache.integration.test.ts` (real Redis + Postgres, `npm run test:integration`) — name and path match `vitest.integration.config.ts` `*.integration.test.ts` glob (T-1):
    - **Scenario A — single revoke**: warm cache → `DELETE /api/sessions/[id]` → next `getSessionInfo` returns `{valid:false}` AND a direct `redis.get` of the cache key returns the tombstone JSON, asserted with `toStrictEqual<TombstoneShape>({ tombstone: true })` against a typed literal (T-14 — symmetric mock-reality guard for the tombstone path).
    - **Scenario B — sign-out-everywhere**: warm cache for two tokens, hit `DELETE /api/sessions` → both cache keys are tombstoned.
    - **Scenario C — bulk via `invalidateUserSessions`**: 5 sessions for user → `invalidateUserSessions` → all 5 cache keys tombstoned.
    - **Scenario D — passkey verify rotation**: warm cache → call passkey verify route → previous tokens tombstoned.
    - **Scenario E — Auth.js deleteSession adapter**: warm cache → `auth-adapter.deleteSession(token)` → cache key tombstoned.
    - **Scenario F — deleteUser cascade (site #8)**: warm cache for a user with 2 sessions → call `auth-adapter.deleteUser(userId)` → both cache keys tombstoned.
    - **Scenario G — tenant policy change (site #9)**: 3 sessions across the tenant → `PATCH /api/tenant/policy` flips `requirePasskey` → all 3 keys tombstoned.
    - **Scenario H — Redis fail-open**: stop the Redis container mid-test → `getSessionInfo` still resolves (DB fallback). Restart Redis → cache resumes.
    - **Scenario I — populate-after-invalidate guard** (implementation contract per T-15):
      1. Replace `globalThis.fetch` with a `vi.fn()` that returns a manually-constructed `Promise<Response>` whose `resolve` is captured (`let resolveFetch; const p = new Promise<Response>(r => { resolveFetch = r; })`). Restore in `afterEach`.
      2. Call `getSessionInfo(req)` and store the returned promise (do NOT await).
      3. Synchronously `await invalidateCachedSession(token)` — the tombstone is now written.
      4. Call `resolveFetch(new Response(JSON.stringify({user: {...}}), {status:200}))` to release the auth fetch.
      5. Await the original `getSessionInfo` promise.
      6. Assert: direct `redis.get(key)` returns the tombstone JSON (typed literal compare), NOT a SessionInfo. Wrap the deferred promise in `Promise.race([p, timeoutReject(5_000)])` so a hung auth-fetch fails the test fast instead of hanging the suite.
    - **Scenario J — eviction policy independence (T-3)**: assert every `redis.set` from `setCachedSession` includes a `PX` argument with `SESSION_CACHE_TTL_MS` upper bound. Per-key TTL guarantees memory bound regardless of `maxmemory-policy`.
    - **Scenario K — real-Redis JSON round-trip (T-4 mock-reality guard)**: `setCachedSession(token, fixture, 30_000)` → `redis.get(key)` directly → `JSON.parse` → `toStrictEqual<SessionInfo>(fixture)`. Catches "forgot to JSON.stringify" / "forgot to JSON.parse" bugs.
    - All tests import `SESSION_CACHE_TTL_MS` and `SESSION_CACHE_KEY_PREFIX` from `@/lib/validations/common.server` — no hardcoded `30_000` or `"sess:cache:"` literals (T-10).
    - **Note on "multi-worker"**: this test exercises shared-Redis read-after-invalidate semantics (two callers sharing one Redis client). It does NOT spawn child processes; the comment in the test file MUST state this honestly (T-2).
11. **Update the auth-gate.ts module-doc comment** to reflect the new design (S-R23 documentation drift).
12. **Run `npx vitest run`, `npx next build`, `scripts/pre-pr.sh`** — all must pass before PR.

---

## Local LLM pre-screening responses (recorded for transparency)

Pre-screen output (Step 1-3) and disposition:

| Severity | Finding | Disposition |
|---|---|---|
| Major | Other revocation paths (signout, SCIM, future endpoints) need invalidation | **Adopted**. C3 now enumerates 9 sites. R3 propagation. |
| Minor M1 | Throttled-error-logger duplicated rather than shared | **Adopted**. Extracted to `src/lib/logger/throttled.ts`; rate-limit migrated. |
| Minor M2 | Negative/zero `ttlMs` would error from Redis | **Adopted**. `setCachedSession` early-returns when `<1000ms`, otherwise clamps to `[1000, SESSION_CACHE_TTL_MS]`. |
| Minor M3 | Constants should live in shared config module | **Adopted**. Moved to `src/lib/validations/common.server.ts`. `SESSION_CACHE_MAX` deleted (dead). |

## Round 1 expert review responses (Phase 1 triangulation)

Full findings: [`sessioncache-redesign-review.md`](./sessioncache-redesign-review.md). Disposition summary:

### Critical
- **T-2** "Multi-worker simulation" via two callers in one process is a false-positive — **Adopted**. Renamed Scenario B; integration test comments now state shared-Redis-consistency framing. Cross-process test deferred to Out of scope.

### Major (all addressed)
- **F-1** Populate-after-invalidate race — **Adopted**. Tombstone-on-invalidate + NX-protected populate added (C3 last block).
- **F-2** Site #5 type propagation across $transaction boundary — **Adopted**. C3 now lists explicit type-widening note + implementation step 7 references it.
- **F-3 / S-2 / S-5 / S-11** Master key reference doesn't exist + rotation orphans + KeyProvider warm-up race — **Adopted as consolidated Opus fix**. HKDF subkey from V1 memoized at module load (S-Req-3 + C1 module-level state).
- **F-A-4** `deleteUser` cascade not in inventory — **Adopted**. Added as C3 row #8.
- **S-1** JSON.parse without Zod schema → cache poisoning — **Adopted**. `SessionInfoSchema.safeParse` in `getCachedSession`; poison-eviction on schema fail.
- **S-3** Tenant policy change has no invalidation site — **Adopted**. Added as C3 row #9. (Alternative "drop policy fields from cache" rejected: page-route.ts:157-161 needs them on cache hits.)
- **T-1** Integration test path/suffix wrong → never runs — **Adopted**. Renamed to `src/__tests__/db-integration/session-revocation-cache.integration.test.ts`.
- **T-3** No test that PX TTL is engaged → unbounded growth risk — **Adopted**. Scenario J asserts every `set` has PX bound.
- **T-4** Mock-reality guard does not test divergence — **Adopted**. (1) Unit-level: assert `redis.set` receives `JSON.stringify(fixture)` exactly (string-level). (2) Integration Scenario K: real-Redis round-trip via `redis.get` directly.
- **T-5** No test for master-key-rotation path — **Adopted in obsoleted form**: replaced by "subkey identity invariant" test (proves rotation does NOT change cache subkey, since we pin to V1).
- **T-6** No test for sequencing (invalidation after DB commit) — **Adopted**. Added negative tests per site (mock DB to throw → assert `invalidateCachedSessions` NOT called).
- **T-7** Existing route tests not updated → R3 propagation has no coverage — **Adopted**. Step 8 adds per-site assertion + step 8 also updates SCIM/team test mocks.

### Minor (all addressed)
- **F-5** + **S-8** Cache `valid:false` globalized → DoS poison — **Adopted**. S-Req-6: positive results only.
- **F-6** Step 7 vs Testing strategy phrasing drift — **Adopted**. Reworded step 6 in Implementation steps.
- **F-7** TTL floor contradicts S-Req-5 — **Adopted**. `<1s → no cache` rule (S-Req-5 strengthened).
- **F-8** Dev REDIS_URL absence → no caching — **Adopted**. New "Dev environment" subsection in Out of scope.
- **S-4** HMAC vs plain hash inconsistency — **Adopted**. "Why HMAC" rewritten; cross-env claim removed.
- **S-6** Sequencing must be sequential — **Adopted**. Architecture diagram + C3 explicitly state "await sequence, never Promise.all".
- **S-7** "Strictly an improvement" framing — **Adopted**. Rewritten in Failure semantics + new operational coupling note.
- **S-9** Token-uniqueness invariant undocumented — **Adopted**. New "Cross-tenant safety invariant" subsection.
- **S-10** Throttled logger over-redacts — **Adopted**. Logger factory accepts `errCode`, allowlists Redis error codes.
- **T-8** Fake-timer no-op against Redis — **Adopted**. Step 6 renames test + removes `vi.useFakeTimers`.
- **T-9** No tests for new throttled logger — **Adopted**. New `src/lib/logger/throttled.test.ts` with 3 tests.
- **T-10** Hardcoded constants in tests — **Adopted**. "Constants in tests" subsection in Testing strategy.
- **T-11-A** Existing `vi.mock("user-session-invalidation")` shadows new behavior — **Adopted**. Step 8 calls out `importOriginal` partial mock or unit test.

### Adjacent findings routed
- **F-A-4** routed to Functionality (own scope, addressed as C3 row #8).
- **T-11-A** routed to Testing (addressed in step 8).

## Round 2 expert review responses (Phase 1 triangulation, second pass)

### Major (all addressed)
- **F-9** Tombstone TTL vs slow auth-fetch reopens race after 30 s — **Adopted via `TOMBSTONE_TTL_MS = 5_000`** (S-14 keyspace bound + p99 budget for auth-fetch). Residual hazard documented in Failure semantics: `/api/auth/session` p99 must stay < 5 s.
- **F-10** `hkdfSync` returns `ArrayBuffer` not `Buffer` — **Adopted**. C1 module-level state now uses `Buffer.from(crypto.hkdfSync(...))` (zero-copy wrap).
- **F-11** Tenant policy route is PATCH not PUT — **Adopted**. All references corrected.
- **S-12** Schema-fail eviction defeats tombstone guard — **Adopted**. C1 read pipeline now: tombstone-shape pre-check FIRST, NegativeCache match SECOND, SessionInfo schema THIRD. `redis.del` only fires on parse-fail OR genuinely-malformed schema, never on tombstones.
- **S-13** Tenant policy invalidation timing for large tenants — **Adopted**. C3 row #9 now mandates synchronous invalidation via `redis.pipeline()` BEFORE response 200; no fire-and-forget.
- **S-14** Tombstone keyspace amplification — **Adopted**. Tombstone TTL reduced to 5 s; operational guidance added in "Adversarial Redis" subsection (`maxmemory-policy=volatile-lru`, alert on `sess:cache:*` keyspace).
- **S-15** Removing valid:false cache opens DoS amplifier on `/api/auth/session` — **Adopted via 5-s negative cache** (asymmetric: 30 s positive ceiling, 5 s negative ceiling). S-Req-6 rewritten to permit short-TTL negative cache; documented as a balanced solution to S-8 (DoS-poisoning blast) and S-15 (brute-force protection).
- **T-12** Subkey identity test mocks wrong function — **Adopted**. Test description corrected to mock `getMasterKeyByVersion` (not `getCurrentMasterKeyVersion`); asserts (a) called with literal `1`, (b) memoization (call count == 1).
- **T-14** Scenario K asymmetric tombstone coverage — **Adopted**. Scenario A now asserts `toStrictEqual<TombstoneShape>({ tombstone: true })` against typed literal. Unit test added for tombstone-shape preservation on read.
- **T-15** Scenario I implementation contract gap — **Adopted**. Step 10 Scenario I now lists 6 explicit substeps including `Promise.race([..., timeoutReject(5_000)])` to fail-fast on hung fetches.

### Minor (all addressed)
- **F-12** Site #9 "compare old vs new" precision — **Adopted**. C3 row #9 reworded; only `requirePasskey` and `passkeyGracePeriodDays` are client-side-mutable; `requirePasskeyEnabledAt` is server-derived.
- **F-13** Architecture diagram says DEL but C3 says tombstone — **Adopted**. Diagram updated to show `SET sess:cache:<HMAC> '{tombstone:true}' PX 30_000`.
- **F-14** Disposition log claimed S-3 adopted but PUT/PATCH bug kept it open — **Adopted in cascade with F-11** (route verb corrected).
- **S-16** HKDF salt/info inversion vs RFC 5869 idiom — **Adopted via swap to NIST idiom** (salt empty, info as context). Greenfield-safe (no production V1 entries exist yet). Comment in C1 records the choice.
- **S-17** HMAC subkey heap-dump exposure — **Documented** in "Adversarial Redis" subsection. Same threat-model class as existing KeyProvider-cached keys.
- **S-18** Sustained schema-fail amplification under Redis-WRITE attacker — **Documented** in "Adversarial Redis" subsection. Operational defense: Redis ACL deny on `sess:cache:*` for non-app principals.
- **T-13** Throttled-logger "fixed message" assertion under-specified — **Adopted**. Step 9 throttled.test.ts now lists explicit Test (3): two loggers with distinct constructor messages, plus a TypeScript-level type assertion that the returned function signature is `(errCode?: string) => void`.
- **T-16** Per-site test helper unspecified (18 ad-hoc snippets) — **Adopted**. Step 8 mandates `expectInvalidatedAfterCommit` and `expectNotInvalidatedOnDbThrow` helpers consumed by all 9 site tests.
- **T-17** Round-trip fixture construction unspecified — **Adopted**. Step 9 leading paragraph mandates "TYPED LITERALS (no `as SessionInfo` casts, no spread from production helpers)".
- **T-18** Acceptance criterion grep brittle — **Adopted**. Criterion #2 now requires `--reporter=verbose` and explicit verification that the file ran AND every scenario was green.

---

## Testing strategy

### Unit tests (vitest, mocked Redis)

The full test list for `src/lib/auth/session/session-cache.test.ts` lives in Implementation step 9 above (15 tests). Highlights addressing review findings:

- **S-1 / RT1 / mock-reality**: integration test (Scenario K) drives the JSON round-trip against real Redis; unit test asserts `redis.set` receives `JSON.stringify(fixture)` exactly (string-level), not just an object-equality round-trip.
- **S-2 / T-5 obsoleted by HKDF pinning**: the test is "subkey identity invariant" — same hash regardless of `getCurrentMasterKeyVersion`.
- **F-1 populate-after-invalidate guard**: `setCachedSession` after `invalidateCachedSession` MUST NOT overwrite (NX rejection); the existing tombstone survives.
- **S-Req-6 / F-5 / S-8 negative-cache**: `setCachedSession({valid: false, ...})` is a no-op.

`src/lib/logger/throttled.test.ts` — fires once per interval, fires again after, message string is fixed (T-9).

### Integration tests (real Redis + Postgres)

Path: `src/__tests__/db-integration/session-revocation-cache.integration.test.ts` (matches `vitest.integration.config.ts` glob — T-1).

Scenarios A-K listed in Implementation step 10. Scenarios F (deleteUser cascade) and G (tenant policy change) cover sites 8-9. Scenario I exercises the populate-after-invalidate guard with a deferred Promise. Scenario J asserts every cache write carries a PX TTL bound. Scenario K is the real-Redis mock-reality guard.

**Multi-worker honesty (T-2)**: the integration test uses two `getSessionInfo` callers sharing the singleton Redis client in one process. The test's leading comment MUST state this is shared-Redis-consistency verification, NOT cross-process worker coverage. A real cross-process test (e.g., `child_process.fork`) is out of scope for this plan — the read-after-invalidate semantic is sufficiently exercised by the deferred-promise race in Scenario I.

### Existing route-test updates

For each of the 9 sites in C3 inventory, the existing route/adapter test gets one new assertion: `invalidateCachedSessions` was called with the expected token list AFTER the DB delete mock resolved (T-7). This verifies the R3 propagation guarantee per-site.

For sites 4 (SCIM, team-member-removal) — the existing `vi.mock("@/lib/auth/session/user-session-invalidation", ...)` shadows the new SELECT-then-DEL behavior. Migrate to `importOriginal()`-style partial mock OR add a separate non-mocked unit test for `user-session-invalidation` that exercises the real function (T-11-A).

For each of the 9 sites, add an additional negative test that mocks the DB delete to throw → asserts `invalidateCachedSessions` was NOT called (T-6 sequencing invariant).

### Constants in tests (T-10)

All new and existing tests touching the session cache MUST `import { SESSION_CACHE_TTL_MS, SESSION_CACHE_KEY_PREFIX } from "@/lib/validations/common.server"`. Hardcoded `30_000` or `"sess:cache:"` literals in any test file that touches session-cache are forbidden.

---

## Considerations & constraints

### Failure semantics summary

| Condition | Behavior | Reason |
|---|---|---|
| Redis available, cache hit (valid SessionInfo) | Serve cached SessionInfo | Hot path |
| Redis available, cache hit (tombstone) | Treat as miss → DB fetch; no populate (NX rejected) | F-1 populate-after-invalidate guard |
| Redis available, cache hit (poisoned/schema-fail) | `redis.del` evict, treat as miss | S-1 Zod validation |
| Redis available, cache miss | Fetch `/api/auth/session`. On `valid: true` populate; on `valid: false` no populate | S-Req-6 |
| Redis unavailable on read | Treat as cache miss, fall back to DB fetch | Fail-open for auth correctness |
| Redis unavailable on write | Skip cache write, log throttled with err.code, return SessionInfo to caller | Cache is best-effort |
| Redis unavailable on invalidate | Log throttled with err.code, return success to caller. Cache will TTL-expire within ≤ SESSION_CACHE_TTL_MS | Documented residual risk |

**Operational coupling note (S-7 framing)**: Revocation latency now depends on Redis availability. Steady-state behavior (≤ 1 s propagation) is a strict improvement over today's 30 s per-worker window. **However**, during a Redis outage that coincides with a revocation, behavior reverts to today's TTL-expiry model (≤ 30 s). Today's revocation works regardless of Redis state; after this plan, revocation correctness is coupled to Redis availability. This is an operational dependency to monitor (alerting on `session-cache.redis.fallback` log lines) and to factor into the Redis SLO.

### Rolling-idle session.update interaction

`auth-adapter.ts updateSession` (around line 460+) advances `Session.expires` on every authenticated request. The cache stores `ttlMs` derived from the `expires` value at fetch time. After a subsequent `updateSession` advances `expires`, the cached entry's PX TTL may be SHORTER than the new DB expires — this causes an early cache miss + refresh on the next request after the cached PX elapses, not a correctness issue (the new fetch picks up the new `expires` and re-caches with a longer PX). No invalidation is required on this path.

### Master key rotation behavior

Because the HMAC subkey is derived from `getMasterKeyByVersion(1)` and memoized at module load (S-Req-3), routine bumping of `SHARE_MASTER_KEY_CURRENT_VERSION` (V1 → V2) does NOT change the cache subkey or invalidate cache entries — V1 raw bytes never change (rotation adds V2; V1 stays). The cache is therefore rotation-stable.

**The exception**: if V1 itself is ever rotated (which is not the standard rotation flow — rotation normally appends V2, V3, … without changing V1), all existing cache entries become orphans (the new HKDF output differs). Operators MUST `redis-cli FLUSHDB` (or `SCAN MATCH sess:cache:* | xargs DEL`) as part of any V1-replacement runbook. Document this in the rotation runbook alongside `scripts/rotate-master-key.sh`.

### Migration / rollout

- No DB schema change → no migration.
- No env var change required.
- Behavior diff only: cache becomes shared instead of per-worker. Single-worker dev deploys see no behavioral change apart from revocation correctness.
- No feature flag — the change is small enough and the existing in-process Map has no public API beyond the test export. Adding a flag adds complexity for no real rollback safety (rolling back is a single-PR revert).

### Out of scope

- Auth.js database session strategy itself (`@auth/prisma-adapter` unchanged).
- Session token format (`authjs.session-token` cookie unchanged).
- Session DB schema (`Session` table unchanged).
- L1 in-process cache (deferred — see Technical approach).
- Pub/Sub broadcasting (rejected — option (c) above).
- Cross-process worker coverage in tests (the integration test exercises shared-Redis read-after-invalidate via two callers in one process; a real `child_process.fork` test is deferred — Scenario I's deferred-promise race covers the populate-after-invalidate failure mode).
- Adversarial Redis (poisoning by privileged Redis-side attacker is mitigated by HMAC keying for unknown tokens AND Zod schema validation for known-key value tampering; full Byzantine Redis with master-key access is out of threat model — same as current rate-limit / delegation modules).
- Master key V1 replacement (rotating V1 itself, distinct from appending V2): out-of-band runbook step is to `redis-cli FLUSHDB`.

### Adversarial Redis (Round 2 expansion)

- **Heap-dump exposure of HMAC subkey (S-17)**: the memoized `_sessionCacheHmacKey` lives in process heap for the lifetime of the worker. A heap-dump exposes it, and combined with Redis-WRITE access an attacker can pre-compute cache keys for any token they observe later. Same threat-model class as KeyProvider-cached `share-master`/`verifier-pepper` keys; defense relies on host isolation. Documented as residual.
- **Sustained schema-fail amplification (S-18)**: an attacker with Redis-WRITE who continuously poisons a victim's cache key drives extra `redis.del` + `redis.set` cycles per victim request. Bounded by the attacker already having Redis-WRITE (a Major-class compromise). Operational defense: Redis ACL deny on the `sess:cache:*` key prefix for non-app principals.
- **Tombstone keyspace amplification (S-14)**: each revoke writes a tombstone with PX=`TOMBSTONE_TTL_MS` (5 s). Sustained revoke loops can pump keyspace; bounded since each user's revokable surface is small (≤ max-sessions-per-user). Operators should set `maxmemory-policy = volatile-lru` so non-TTL keys (delegation indices, rate-limit counters with TTL) are NOT evicted ahead of session-cache tombstones; the 5-s TTL gives natural turnover. Add an alert on `sess:cache:*` key count exceeding 10 × concurrent-active-users baseline.
- **Brute-force amplifier against `/api/auth/session` (S-15)**: there is no IP rate-limit on this route at the proxy or route handler level today. Removing the negative cache would let an attacker spam invalid cookies and force a DB query per attempt. Plan retains a 5-s negative cache (S-Req-6) to preserve this implicit rate-limit while bounding the S-8 DoS-poisoning blast. Operators should also consider adding an IP-level rate limiter to `/api/auth/session` as a paired hardening — out-of-scope for this plan but tracked as a TODO.

### Dev environment without REDIS_URL (F-8)

When `REDIS_URL` is unset (dev-only, since `validateRedisConfig()` requires it in production), `getRedis()` returns `null` and every `getSessionInfo` call round-trips to `/api/auth/session`. This is a small per-request DB cost (typically < 5 ms locally); auth correctness is preserved. NF-Req-1 latency requirements assume Redis is configured.

### Resolved decision points (post-Round-1 review)

1. **TTL clamping (F-7)**: `setCachedSession` clamps `[1000, SESSION_CACHE_TTL_MS]` AND additionally early-returns when `expires - now < 1000ms`. The `< 1s → no cache` rule preserves S-Req-5 (cached entry never outlives DB row).
2. **`invalidateUserSessions` cost**: 1 SELECT per call. Acceptable for typical user (1-3 sessions); SCIM bulk deactivation pays it per-user. Out of scope to optimize.
3. **Master key access (S-2 / S-5 / S-11 fix)**: HMAC subkey via HKDF from V1, memoized at module load. Eliminates rotation drift, KeyProvider warm-up race, and per-call cost. See S-Req-3.
4. **HMAC vs plain hash (S-4)**: HMAC retained; Redis-poisoning-of-arbitrary-unknown-tokens defense is the sole rationale. Cross-env claim removed.

---

## User operation scenarios

### Scenario 1 — Self-revoke from another device

User has 2 active sessions (laptop, mobile). On laptop, opens Settings → Sessions and revokes the mobile session.
- **Today**: mobile may continue to load `/dashboard` for up to 30 s.
- **After fix**: mobile's next request is rejected within 1 s (cache invalidated synchronously at revoke time).

### Scenario 2 — Admin force-logout via SCIM

IT admin deactivates a user via SCIM `PATCH /api/scim/v2/Users/[id]`. `invalidateUserSessions` runs.
- **Today**: any worker that cached the user's session keeps serving for up to 30 s.
- **After fix**: every worker sees the invalidation immediately (Redis is single source of truth).

### Scenario 3 — Team member removal (existing path)

A team admin removes a member; `invalidateUserSessions` runs (user-session-invalidation.ts:10).
- Same improvement as scenario 2.

### Scenario 4 — Redis briefly unavailable

Redis container restarts during deploy.
- **Reads**: cache miss → DB fetch (slow but correct).
- **Writes**: cache write skipped (next read still works, just slower).
- **Invalidations during outage**: queued only on the worker(s) that received the revoke — the cached entry on other workers TTL-expires within 30 s.
- The worst case during a Redis outage is identical to today's steady-state, so this is an improvement bracketed by an existing baseline.

### Scenario 5 — Session expires naturally

User leaves a tab open past `session.expires`.
- Cached entry's `ttlMs = expires - now` → entry self-expires from Redis at the same moment the DB session expires.
- No "ghost" sessions surviving past their DB expiry.

### Scenario 6 — Edge: TOCTOU between read and revocation

Window-of-1-RTT: request A reads cache (hit, valid) at T=0; revoke at T=2ms; request B reads cache (miss after invalidate) at T=4ms.
- This is the same TOCTOU as today's DB pattern (revoke is not transactionally tied to the request handler).
- Not in scope to eliminate. The fix bounds the *steady-state* window from 30 s down to ~ 1 RTT.

---

## Estimated effort

- Plan creation + 2 review rounds: 1.5 hours (Phase 1)
- Implementation (C1-C4 + tests): 2.5 hours (Phase 2)
- Code review + iterations: 1.5 hours (Phase 3)
- Total: ~ 5.5 hours, in line with the prompt's 5+ hour estimate.

---

## Acceptance criteria

A reviewer can mark this complete when:
1. `npx vitest run` and `npx next build` pass.
2. Run `npm run test:integration -- session-revocation-cache.integration --reporter=verbose`. Verbose output MUST list `session-revocation-cache.integration.test.ts ✓` and each of Scenarios A–K green (T-18). A green-suite signal alone is insufficient — verify the file actually executed and every scenario ran.
3. Manual: run `docker compose up`, sign in, revoke session from another tab, verify within 1 s the revoked tab is logged out.
4. `scripts/pre-pr.sh` passes.
5. Code review (Phase 3) returns "No findings" from all three experts.
