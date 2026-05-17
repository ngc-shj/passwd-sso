# Rate-Limit Fail-Closed-on-Redis-Error — Implementation Plan

## Project context

- **Type**: web app (Next.js 16 App Router multi-tenant password manager)
- **Test infrastructure**: unit (vitest) + integration (real Postgres) + CI/CD via GitHub Actions (`scripts/pre-pr.sh`)
- **Stack relevance**: Redis (ioredis) used for distributed rate-limit counters; falls back to in-memory `Map` per process when Redis is unavailable
- **Base branch**: `main` at `5ecacced` (PR `#470` + `#472` follow-up merged)

## Objective

Add opt-in fail-closed behaviour to `createRateLimiter` so that, on a configurable subset of authentication / credential / token-issuance routes, a Redis outage causes the route to respond `503 Service Unavailable + Retry-After: 30` instead of silently switching to per-process in-memory counters.

Rationale: in multi-process / serverless / autoscale deployments, in-memory fallback weakens the effective rate-limit ceiling by a factor equal to the active instance count. For attack-surface endpoints (passphrase verify, passkey verify, token mint, share-link verify), the attacker can spread retries across instances and bypass the documented protection.

## Requirements

### Functional

1. `createRateLimiter` gains opt-in `failClosedOnRedisError: boolean` (default `false`).
2. Fail-closed signal MUST flow through every limiter wrapper (notably `checkIpRateLimit`) without being stripped.
3. Opt-in routes MUST translate the signal to the **appropriate HTTP 503 envelope for that route's contract**:
   - Routes currently using `rateLimited()` → use new helper `serviceUnavailable()`.
   - OAuth/DCR routes (`/api/mcp/*`) → use new helper `oauthTemporarilyUnavailable()` returning RFC 6749 `{ error: "temporarily_unavailable" }`.
   - Custom-shape routes (`vault/delegation/check`) → emit a route-local 503 body preserving the route's prior contract.
4. Each 503 emission on routes with a resolvable tenant context MUST write one throttled `RATE_LIMIT_FAIL_CLOSED` audit log entry per (scope, actor-key) per 5 minutes.
5. Pre-auth routes (no userId AND no tenant context resolvable without a DB lookup) MUST NOT emit audit; the structured warn log `rate-limit.redis.fallback` is the sole observability signal. (Avoids `logAuditAsync` dead-letter for `tenantId=null` and avoids adding DB latency to a fast-fail 503 path.)
6. The structured warn log MUST continue to fire on every fail-closed path (unchanged from today).

### Non-functional

- Backward compatibility: existing callers that do not opt in see no behavioural change. Public `RateLimitResult` shape gains an optional field; required field set unchanged.
- Type-safety: opt-in callers can branch on a tagged property without runtime casts.
- Performance: no extra round-trip per check; no DB latency on the 503 path.
- Observability: existing throttled logger continues to fire; audit emission is throttled per (scope, actor-key); webhook fan-out suppressed for this action class (Considerations-3).
- Docker / CI compatibility: dev (no `REDIS_URL`) and CI (typically no Redis container in unit-test profile) continue to use in-memory fallback for all opt-OUT callers.

### Out of scope

- Migrating non-target rate-limit call sites (~120 source-file sites).
- Adding a metric exporter (Prometheus / OpenTelemetry). The throttled log + audit rows are the observability surface.
- Replacing the in-memory fallback for opt-OUT routes.
- New env var to globally force `failClosedOnRedisError`. Break-glass procedure is documented in Considerations-11.

## Technical approach

### Check flow

1. `createRateLimiter` checks `options.failClosedOnRedisError`.
2. `checkRedis()` returns `null` on no-client / pipeline error (unchanged).
3. New `check()` body:
   - Try Redis → `redisResult: RateLimitResult | null`.
   - If non-null → return as-is.
   - If null AND `failClosedOnRedisError: true` → return `{ allowed: false, redisErrored: true }`.
   - If null AND `failClosedOnRedisError: false` → fall back to in-memory (current behaviour).
4. Caller at each opt-in route inspects `result.redisErrored`:
   - `true` → emit throttled audit (post-auth only) + return route-appropriate 503.
   - `false && !allowed` → return existing rate-limit response (429).
   - `false && allowed` → proceed.

### New helpers

- `serviceUnavailable(retryAfterMs?: number)` in `src/lib/http/api-response.ts` — canonical envelope `{ error: "SERVICE_UNAVAILABLE" }` + 503 + `Retry-After` (default 30 s).
- `oauthTemporarilyUnavailable(retryAfterMs?: number, description?: string)` in `src/lib/http/api-response.ts` — RFC 6749 envelope `{ error: "temporarily_unavailable", error_description?: string }` + 503 + `Retry-After` (default 30 s). Used by `/api/mcp/*` routes only.
- `emitRateLimitFailClosed({ req, scope, userId, tenantId })` in `src/lib/security/rate-limit-audit.ts` — internally throttled by `(scope, userId ?? ipBucket)` per 5 min. Action `RATE_LIMIT_FAIL_CLOSED`. **ActorType `ANONYMOUS` when userId null; `HUMAN` when userId present.** Skips emission entirely when `tenantId == null` (logs a warn instead of going to dead-letter). Fire-and-forget; never throws.

### Schema / constant additions

- `prisma/schema.prisma`: add `RATE_LIMIT_FAIL_CLOSED` to `AuditAction` enum.
- New Prisma migration `add_audit_action_rate_limit_fail_closed` via `npm run db:migrate`.
- `src/lib/constants/audit/audit.ts`:
  - Add `RATE_LIMIT_FAIL_CLOSED` to `AUDIT_ACTION` const.
  - Add to `AUDIT_ACTION_VALUES` array.
  - Add to `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MAINTENANCE]` (system-health event; matches `AUDIT_DELIVERY_FAILED` / `AUDIT_OUTBOX_DEAD_LETTER` siblings).
  - Add to `WEBHOOK_DISPATCH_SUPPRESS` set (avoid webhook storms during outage; operators monitor via SIEM / logs).
- `src/lib/constants/audit/audit-target.ts`: add `RATE_LIMITER: "RateLimiter"` to `AUDIT_TARGET_TYPE` (used as `targetType` so SIEM can group by limiter scope).
- `messages/en/AuditLog.json`: `"RATE_LIMIT_FAIL_CLOSED": "Rate limit fail-closed (Redis unavailable)"`.
- `messages/ja/AuditLog.json`: `"RATE_LIMIT_FAIL_CLOSED": "レート制限フェイルクローズ（Redis 障害）"`.

### Wrapper widening

- `src/lib/security/ip-rate-limit.ts`: change return type from `Promise<{ allowed: boolean; retryAfterMs?: number }>` to `Promise<RateLimitResult>` so `redisErrored` flows through structurally. Add unit test asserting passthrough.

### Docker / CI

- `docker-compose.yml`: existing `redis:7` service has healthcheck (verify during Phase 2).
- `scripts/pre-pr.sh`: no change. Vitest mocks `getRedis()`; integration tests already require Postgres + Redis.
- New `scripts/checks/check-fail-closed-routes-have-test.sh` (T1 mitigation): fails CI when a route source file containing `failClosedOnRedisError: true` lacks a sibling test file that references the route handler. Coverage gate rather than authoring 35 new test files in this PR.

### Documentation

- `docs/operations/runbook-redis-outage.md` (new): operator playbook (see C6).

## Contracts

### C1 — `createRateLimiter` options + result shape

**Signature**:
```ts
// src/lib/security/rate-limit.ts
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /**
   * When true, Redis errors cause check() to return
   * { allowed: false, redisErrored: true } instead of falling back to
   * the in-memory Map. Caller must translate to a 503 response.
   * Default: false (preserves current fail-open in-memory fallback).
   */
  failClosedOnRedisError?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Present when allowed=false. Milliseconds until reset. */
  retryAfterMs?: number;
  /**
   * True ONLY when failClosedOnRedisError=true triggered fail-closed.
   * Always absent (not even false) when option is false.
   * Caller branches:
   *   redisErrored===true       → 503 (route-specific envelope)
   *   !allowed && !redisErrored → 429
   */
  redisErrored?: true;
}
```

**Invariants**:
- I1.1: `redisErrored` is set only when `failClosedOnRedisError: true` AND Redis returned null.
- I1.2: When `redisErrored: true`, `allowed` is `false` and `retryAfterMs` is undefined.
- I1.3: Existing callers destructuring `{ allowed, retryAfterMs }` continue to work identically.
- I1.4: `clear()` in fail-closed mode does NOT throw if Redis is down; it still attempts `store.delete(key)` as best-effort in-memory cleanup. (Deliberate asymmetry: `check()` refuses in-memory in fail-closed mode; `clear()` performs no-op cleanup since the value would otherwise be a permanent orphan.)
- **I1.5: `checkIpRateLimit` wrapper return type MUST be `Promise<RateLimitResult>` — the wrapper MUST NOT narrow the result shape. The optional `redisErrored` field flows through structurally. The wrapper's internal `RateLimitProbe.check` type (currently an inline anonymous interface) MUST be widened to `Promise<RateLimitResult>` in lockstep — preferably by importing the canonical type instead of redeclaring inline. (F17)**

**Forbidden patterns**:
- `pattern: redisErrored\?:\s*boolean` — reason: must be literal-true type for discriminator semantics.
- `pattern: failClosedOnRedisError:\s*false` — reason: explicit `false` defeats readability; omit instead.
- `pattern: redisErrored:\s*false` inside any `*.test.ts` — reason: literal-true type rejects `false`; use omission. (T9)
- `pattern: Promise<\{\s*allowed:\s*boolean;\s*retryAfterMs\?:` inside `src/lib/security/ip-rate-limit.ts` — reason: outer wrapper AND inner `RateLimitProbe.check` MUST both return `Promise<RateLimitResult>`. (F4/T7/F17)

**Acceptance criteria**:
- AC1.1: Existing test `falls back to in-memory when pipeline exec() throws` still passes unchanged.
- AC1.2: `createRateLimiter({ ..., failClosedOnRedisError: true })` with pipeline exec rejecting returns `{ allowed: false, redisErrored: true }` and DOES NOT touch the in-memory Map.
- AC1.3: `createRateLimiter({ ..., failClosedOnRedisError: true })` when `getRedis()` returns `null` returns `{ allowed: false, redisErrored: true }`.
- AC1.4: `clear()` on a fail-closed limiter when Redis is down does not throw; in-memory `store.delete(key)` attempted as no-op cleanup.
- **AC1.5 (NEW)**: Unit test on `checkIpRateLimit` confirms it propagates `redisErrored: true` from the inner limiter mock to the caller.

**Consumer-flow walkthrough**:

- *Consumer R1 (opt-in route handlers — see C4)* reads `{ allowed, retryAfterMs, redisErrored }`. Branches: `redisErrored===true` → emit audit (when applicable) + return route-appropriate 503; else `!allowed` → return 429; else proceed. All three fields present.
- *Consumer R2 (`src/lib/security/ip-rate-limit.ts`)* — wrapper return type widened to `Promise<RateLimitResult>` (I1.5). Reads `{ allowed }` for branching, returns full result object. `redisErrored` flows through. AC1.5 verifies.
- *Consumer R3 (~120 opt-OUT callers)* reads `{ allowed, retryAfterMs }`. Since their limiter has default `failClosedOnRedisError: false`, `redisErrored` is never set; behaviour unchanged.
- *Consumer R4 (unit tests `src/__tests__/lib/rate-limit.test.ts`)* — AC1.2/AC1.3 read `result.redisErrored`. ~47 existing test files mock `createRateLimiter`; the optional additive field does not break their shape compatibility. (T10 corrected count.)

### C2 — `serviceUnavailable` response helper (canonical envelope)

**Signature**:
```ts
// src/lib/http/api-response.ts
export const serviceUnavailable: (retryAfterMs?: number) => NextResponse;
```

**Invariants**:
- I2.1: Status: 503.
- I2.2: Body: `{ error: "SERVICE_UNAVAILABLE" }` (canonical envelope).
- I2.3: Header: `Retry-After: <seconds>` where seconds = `retryAfterMs > 0 ? ceil(retryAfterMs/1000) : 30`. Default 30 s. **NOTE**: this differs from `rateLimited(0)` which omits `Retry-After` — 503 requires a hint per operator playbook; 429 may omit if the limiter cannot compute one. Comment in source explains.
- I2.4: Does NOT include any internal token in the body (R37); no `redis` string, no internal failure code beyond `SERVICE_UNAVAILABLE`.

**Forbidden patterns**:
- `pattern: "redis"\s*:\s*true` in api-response.ts — reason: do not leak internal failure-mode tokens.
- `pattern: details:\s*\{\s*message:\s*"Redis` — reason: same.
- **`pattern: errorResponse\(API_ERROR\.SERVICE_UNAVAILABLE` is checked against a documented exception allowlist (NOT a blanket ban). Pre-existing call sites that use `errorResponse(SERVICE_UNAVAILABLE, ...)` for non-Redis configuration / RP_ID / lockout / entropy / infra reasons are allowlist exceptions, with rationale "differs from Redis fail-closed semantic". Allowlist (re-verified at plan revision by grep across `src/`; reviewer MUST re-grep at Phase 2 to confirm no drift): (S6, S11, S14)**
  - `src/lib/http/api-response.ts` (helper definitions)
  - `src/app/api/vault/unlock/route.ts:96-101` (lock_timeout — R31 lock-contention)
  - `src/app/api/webauthn/register/options/route.ts:33` (RP_ID / config unavailable)
  - `src/app/api/webauthn/register/verify/route.ts:65,86` (config unavailable)
  - `src/app/api/auth/passkey/options/route.ts:41,46` (RP_ID unavailable)
  - `src/app/api/auth/passkey/options/email/route.ts:75,80` (RP_ID unavailable) (S14 — line numbers added)
  - `src/app/api/webauthn/credentials/[id]/prf/options/route.ts:54` (config unavailable)
  - `src/app/api/webauthn/authenticate/options/route.ts:38` (config unavailable)
  - `src/app/api/auth/passkey/reauth/options/route.ts:34,38` (config unavailable)
  - `src/app/api/auth/passkey/reauth/verify/route.ts:85-86` (config unavailable — **invoked via computed `code` variable, so the literal-prefix forbidden-pattern regex does NOT catch this; documented here for completeness**) (S14)
  - `src/app/api/api-keys/route.ts:96` (entropy-strip safety net — distinct from Redis fail-closed; **WILL coexist with the new `serviceUnavailable()` redisErrored branch added by row 25 in C4** — Phase 2 implementer MUST add `if (rl.redisErrored) return serviceUnavailable()` ABOVE the existing `:96` call, leaving both helpers in the same file) (S14)
  - `src/app/api/tenant/breakglass/route.ts:132` (generic infra-fault catch in personalLogAccessGrant create; not Redis-specific) (S14)
  - `src/app/api/tenant/breakglass/[id]/logs/route.ts:174` (existing breakglass infra-unavailable; not in opt-in table)

  Any NEW `errorResponse(SERVICE_UNAVAILABLE, ...)` call site outside this allowlist must either use `serviceUnavailable()` instead OR be added to this allowlist with rationale.

**Acceptance criteria**:
- AC2.1: `serviceUnavailable()` returns 503 + `Retry-After: 30`.
- AC2.2: `serviceUnavailable(15_000)` returns 503 + `Retry-After: 15`.
- AC2.3: `serviceUnavailable(0)` returns 503 + `Retry-After: 30` (default). Documented divergence from `rateLimited(0)`. (T8)
- AC2.4: Body equals `{ error: "SERVICE_UNAVAILABLE" }`.
- AC2.5: `vault/unlock` lock_timeout path remains unchanged (still uses `errorResponse(SERVICE_UNAVAILABLE, ...)`); a test asserts this path is unaffected by the new helper. (F6)

### C2b — `oauthTemporarilyUnavailable` response helper (RFC 6749 envelope)

**Signature** (S12 resolution — drop optional `description` param; YAGNI):
```ts
// src/lib/http/api-response.ts
export const oauthTemporarilyUnavailable: (retryAfterMs?: number) => NextResponse;
```

**Invariants**:
- I2b.1: Status: 503.
- I2b.2: Body: exactly `{ error: "temporarily_unavailable" }` (RFC 6749 §5.2). No `error_description` field. (S12 — reduces information-disclosure surface to OAuth clients. If a future use case requires a description, add the param with a Forbidden Pattern barring interpolated error-message strings.)
- I2b.3: Header: `Retry-After: <seconds>` same default rules as `serviceUnavailable`.
- I2b.4: Used ONLY by `/api/mcp/*` routes (and any future OAuth/OIDC endpoint). NOT used by routes returning the canonical `MainApiErrorBody` envelope.

**Forbidden patterns**:
- `pattern: serviceUnavailable\(` inside `src/app/api/mcp/` — reason: OAuth routes MUST use `oauthTemporarilyUnavailable`.
- `pattern: error_description` inside `oauthTemporarilyUnavailable` body construction — reason: S12 minimization.

**Acceptance criteria**:
- AC2b.1: `oauthTemporarilyUnavailable()` returns 503 + body `{ error: "temporarily_unavailable" }` + `Retry-After: 30`.
- AC2b.2: `oauthTemporarilyUnavailable(15_000)` returns body `{ error: "temporarily_unavailable" }` + `Retry-After: 15`. Body MUST NOT contain `error_description`.

### C3 — `emitRateLimitFailClosed` audit helper

**Signature**:
```ts
// src/lib/security/rate-limit-audit.ts (new file)
export async function emitRateLimitFailClosed(args: {
  req: NextRequest;
  scope: string;                       // route-specific limiter scope
  userId: string | null;               // null when pre-auth
  tenantId: string | null | undefined; // null when pre-auth or unresolvable
}): Promise<void>;

// Test-only exports
export function __resetThrottleForTests(): void;
export function __getThrottleStateForTests(): { size: number; has(key: string): boolean }; // T16
```

**Invariants**:
- I3.1: Throttles by `(scope, userId ?? ipBucket)` — at most one emission per 5 min per key.
- I3.2: Throttle map uses **LRU eviction** (oldest-first by `resetAt`); does NOT clear-all when full. Cap `RATE_LIMIT_MAP_MAX_SIZE` from `@/lib/validations/common.server`. (S4 — must not reuse the clear-all pattern from `rate-limit.ts:84-90`.)
- I3.3: Action: `AUDIT_ACTION.RATE_LIMIT_FAIL_CLOSED`.
- I3.4: Scope: always `AUDIT_SCOPE.TENANT`. Plan does NOT emit PERSONAL audit rows. (F7)
- I3.5: ActorType: `ACTOR_TYPE.ANONYMOUS` when `userId` is null; `ACTOR_TYPE.HUMAN` when present. **NEVER `SYSTEM`** (S1; matches established pattern in `share-links/verify-access/route.ts:84-107`).
- I3.6: When `userId` is null, `userId` field passed to logger is `ANONYMOUS_ACTOR_ID` sentinel.
- I3.7: When `tenantId` is null AND `userId` is non-null, the helper attempts `resolveUserTenantId(userId)` (cheap indexed tenantMember lookup, wrapped in withBypassRls) to derive tenantId. If resolution succeeds, audit emission proceeds normally. If resolution fails (returns null OR throws) OR userId is also null, the helper skips audit emission and writes a single throttled warn log (`rate-limit.fail_closed.pre_auth_skip`). The DB lookup runs INSIDE the fire-and-forget helper — callers `void emitRateLimitFailClosed(...)`, so the lookup does NOT block the 503 hot path. (F8 resolution + Phase 3 F1/S1 fix — recovers post-auth audit observability for routes that have userId but don't carry tenantId at the limiter-check point.)
- I3.8: `targetType`: `AUDIT_TARGET_TYPE.RATE_LIMITER` (new const value). `targetId`: the `scope` string. Enables SIEM grouping. (S7)
- I3.9: Metadata: `{ scope, ip, ipBucket }`. `ip` is raw client IP (matches `share-links/verify-access:99` precedent for SIEM continuity); `ipBucket` is `rateLimitKeyFromIp(ip)` normalised key (IPv6 /64 etc.). (S10)
- I3.10: scope arg MUST match regex `/^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,2}$/`. Reject mismatched scope by warn-log + skip emission (do not throw — fail-safe). (S3)
- I3.11: All errors swallowed internally — never throws. Fire-and-forget contract.

**Forbidden patterns**:
- `pattern: throw\s+new\s+Error\(` inside `rate-limit-audit.ts` — reason: emission must be fire-and-forget.
- `pattern: ipBucket:\s*args\.req\.headers` — reason: never bypass `rateLimitKeyFromIp` normalisation.
- `pattern: ACTOR_TYPE\.SYSTEM` inside `rate-limit-audit.ts` — reason: pre-auth events MUST use ANONYMOUS per S1.

**Acceptance criteria**:
- AC3.1: First call within a 5-min window with non-null `tenantId` invokes `logAuditAsync` with action `RATE_LIMIT_FAIL_CLOSED`, targetType `RATE_LIMITER`, targetId == scope, scope `AUDIT_SCOPE.TENANT`.
- AC3.2: Second call within the same window for the same (scope, key) does NOT invoke `logAuditAsync`. Test uses `__resetThrottleForTests()` in `beforeEach` to ensure fresh state. (T4)
- AC3.3: When `logAuditAsync` rejects, the helper still resolves (does not propagate).
- AC3.4: When `userId` is null, actorType is `ACTOR_TYPE.ANONYMOUS` and userId field is `ANONYMOUS_ACTOR_ID`.
- AC3.5: Metadata contains `scope`, `ip`, `ipBucket`. Does NOT contain raw email, token fragments, or other sensitive fields.
- AC3.6 (Phase 3 F1/S1 fix — updated): When `userId` is null AND `tenantId` is null (true pre-auth, e.g., passkey options), `logAuditAsync` is NOT called; a throttled warn log fires instead. When `userId` is present AND `tenantId` is null (post-auth route that doesn't carry tenantId at the limiter-check point), the helper attempts `resolveUserTenantId(userId)`: success → audit emission proceeds; null/throw → fall back to warn-log. When `tenantId` is provided directly by the caller, no DB lookup is attempted.
- AC3.7: scope arg failing the regex skips emission and logs a warn; helper still resolves.
- AC3.8 (T16/T18 — corrected to actually exercise LRU eviction): Under sustained pressure (>10_000 distinct keys — i.e., over the `RATE_LIMIT_MAP_MAX_SIZE` cap), oldest entries are evicted (LRU); recently-touched legitimate-user state is preserved. Test pattern: (1) inject the `t0_key` first; (2) inject 10_001 distinct synthetic `(scope, key)` pairs in order; (3) BETWEEN each batch of ~100 synthetic inserts, re-touch `t0_key` (to mark it recently-used); (4) assert `__getThrottleStateForTests().has(t0_key) === true` AND `__getThrottleStateForTests().has(first_synthetic_key) === false` — proves eviction fired AND was LRU-ordered. A clear-all-on-full implementation (the S4 anti-pattern) would fail this test because `t0_key` would be wiped along with everything else on the 10_001st insert.

**Consumer-flow walkthrough**:

- *Each opt-in route handler* calls `void emitRateLimitFailClosed({ req, scope, userId, tenantId })` immediately before returning 503. Reads no return (void). `req` used for `extractClientIp`; `scope` used for throttle key + audit metadata; `userId`/`tenantId` for actor + scope selection.
- *Pre-auth route handlers* (passkey options, webauthn options, etc.) pass `userId: null, tenantId: null` → I3.7 fires (audit skipped, warn log only). Operations runbook (C6) documents this.
- *Tests* — `src/__tests__/lib/rate-limit-audit.test.ts` (new): `beforeEach(() => __resetThrottleForTests())`; covers AC3.1-AC3.8 with mocked `logAuditAsync`.

### C4 — Opt-in route table

The following routes opt in (`failClosedOnRedisError: true` on every limiter in the route file). Response envelope column indicates which 503 helper / shape to use.

```
Before (canonical 429 route):
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

After (canonical 429 route):
  if (rl.redisErrored) {
    void emitRateLimitFailClosed({ req: request, scope: "<route-scope>", userId, tenantId });
    return serviceUnavailable();
  }
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

Before (OAuth/DCR route, custom envelope already):
  if (!rl.allowed) return NextResponse.json({ error: "slow_down" }, { status: 429, ... });

After (OAuth/DCR route):
  if (rl.redisErrored) {
    void emitRateLimitFailClosed({ ... });
    return oauthTemporarilyUnavailable();
  }
  if (!rl.allowed) return NextResponse.json({ error: "slow_down" }, ...);
```

Route table (NN = canonical envelope `serviceUnavailable()`; OA = OAuth envelope `oauthTemporarilyUnavailable()`; CS = custom shape preserving route-local contract):

| # | Route | scope | Envelope | Reason |
|---|-------|-------|----------|--------|
| 1 | `src/app/api/vault/unlock/route.ts` | `vault.unlock` | NN | passphrase verify boundary |
| 2 | `src/app/api/vault/unlock/data/route.ts` | `vault.unlock_data` | NN | encrypted-key fetch |
| 3 | `src/app/api/vault/setup/route.ts` | `vault.setup` | NN | initial passphrase commit |
| 4 | `src/app/api/vault/reset/route.ts` | `vault.reset` | NN | last-resort destruction |
| 5 | `src/app/api/vault/change-passphrase/route.ts` | `vault.change_passphrase` | NN | re-key boundary |
| 6 | `src/app/api/vault/admin-reset/route.ts` | `vault.admin_reset` | NN | admin destruction |
| 7 | `src/app/api/vault/recovery-key/recover/route.ts` (2 limiters: `verifyLimiter`, `resetLimiter`) | `vault.recovery_recover_verify` / `vault.recovery_recover_reset` | NN | recovery-key verify + reset |
| 8 | `src/app/api/vault/recovery-key/generate/route.ts` | `vault.recovery_generate` | NN | recovery-material write |
| 9 | `src/app/api/vault/rotate-key/route.ts` | `vault.rotate_key` | NN | key rotation begin |
| 10 | `src/app/api/vault/rotate-key/data/route.ts` | `vault.rotate_key_data` | NN | bulk entry fetch |
| 11 | `src/app/api/vault/delegation/route.ts` | `vault.delegation` | NN | delegation CRUD |
| 12 | `src/app/api/vault/delegation/check/route.ts` | `vault.delegation_check` | **CS**: `{ authorized: false, reason: "service_unavailable" }` + 503 + Retry-After: 30 | CLI agent contract preserved (F3) |
| 13 | `src/app/api/auth/passkey/verify/route.ts` | `auth.passkey_verify` | NN | passkey discoverable auth (PRE-AUTH — audit skipped per I3.7) |
| 14 | `src/app/api/auth/passkey/options/route.ts` | `auth.passkey_options` | NN | passkey challenge gen (PRE-AUTH) |
| 15 | `src/app/api/auth/passkey/options/email/route.ts` | `auth.passkey_options_email` | NN | email-based passkey challenge (PRE-AUTH) |
| 16 | `src/app/api/auth/passkey/reauth/verify/route.ts` | `auth.passkey_reauth_verify` | NN | AAL2 step-up |
| 17 | `src/app/api/auth/passkey/reauth/options/route.ts` | `auth.passkey_reauth_options` | NN | AAL2 challenge |
| 18 | `src/app/api/webauthn/authenticate/verify/route.ts` | `webauthn.auth_verify` | NN | WebAuthn auth verify |
| 19 | `src/app/api/webauthn/authenticate/options/route.ts` | `webauthn.auth_options` | NN | WebAuthn auth options (PRE-AUTH) |
| 20 | `src/app/api/webauthn/register/verify/route.ts` | `webauthn.reg_verify` | NN | WebAuthn reg verify |
| 21 | `src/app/api/webauthn/register/options/route.ts` | `webauthn.reg_options` | NN | WebAuthn reg options |
| 22 | `src/app/api/webauthn/credentials/[id]/prf/route.ts` | `webauthn.prf` | NN | PRF material bind |
| 23 | `src/app/api/webauthn/credentials/[id]/prf/options/route.ts` | `webauthn.prf_options` | NN | PRF challenge |
| 24 | `src/app/api/share-links/verify-access/route.ts` (2 limiters: `ipLimiter`, `tokenLimiter`) | `share.verify_access_ip` / `share.verify_access_token` | NN | share-link unlock (PRE-AUTH IP-limiter; tenantId available from share record for token-limiter) |
| 25 | `src/app/api/api-keys/route.ts` (POST only) | `apikey.create` | NN | API key mint |
| 26 | `src/app/api/tenant/access-requests/route.ts` (POST only) | `access_request.create` | NN | JIT request creation |
| 27 | `src/app/api/tenant/access-requests/[id]/approve/route.ts` | `access_request.approve` | NN | JIT token issue |
| 28 | `src/app/api/tenant/access-requests/[id]/deny/route.ts` | `access_request.deny` | NN | JIT denial |
| 29 | `src/app/api/mcp/token/route.ts` (2 limiters: `tokenRateLimiter`, `ipRateLimiter`) | `mcp.token` / `mcp.token_ip` | **OA** | OAuth token exchange |
| 30 | `src/app/api/mcp/authorize/route.ts` | `mcp.authorize` | **OA** | OAuth consent |
| 31 | `src/app/api/mcp/register/route.ts` | `mcp.dcr_register` | **OA** | Dynamic Client Registration |
| 32 | `src/app/api/mcp/revoke/route.ts` | `mcp.revoke` | **OA** | RFC 7009 token revocation |
| 33 | `src/app/api/extension/token/route.ts` | `extension.token` | NN | extension token mint |
| 34 | `src/app/api/extension/token/exchange/route.ts` | `extension.token_exchange` | NN | bridge-code → token |
| 35 | `src/app/api/extension/token/refresh/route.ts` | `extension.token_refresh` | NN | extension refresh-rotation |
| 36 | `src/app/api/extension/bridge-code/route.ts` | `extension.bridge_code` | NN | one-time-use code mint |
| 37 | `src/app/api/mobile/token/route.ts` (S2) | `mobile.token` | NN | PKCE token mint (DPoP-bound) |
| 38 | `src/app/api/mobile/token/refresh/route.ts` (S2) | `mobile.token_refresh` | NN | mobile refresh rotation |
| 39 | `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.ts` (2 limiters; S2) | `vault.admin_reset_approve` / `vault.admin_reset_approve_target` | NN | second-admin vault-reset approval |
| 40 | `src/app/api/share-links/[id]/content/route.ts` (S2) | `share.content` | NN | share-content delivery (post-token) |
| 41 | `src/app/api/emergency-access/accept/route.ts` (S2) | `emergency_access.accept_token` | NN | emergency-grant token redemption (PRE-AUTH; tenantId resolvable from grant record post-lookup, but lookup gated by Redis-down → audit skipped) |
| 42 | `src/app/api/teams/invitations/accept/route.ts` (S2) | `teams.invitation_accept_token` | NN | team invitation acceptance |

**Final counts (F10/T2/F20/F21 fix)**:
- 42 routes total. Provenance: 13 user-supplied + 23 adjacent-credential routes added per user instruction + 6 S2 additions = 42. See Considerations-4 for the verbatim 13 and full provenance breakdown.
- Limiter instantiations: 38 single-limiter route files × 1 + 4 double-limiter route files × 2 = **46 `createRateLimiter({ ..., failClosedOnRedisError: true })` instantiations**. (F20: corrected formula — the previous "42 − 38 − 4 + 8" expression was incorrect; the math is plainly 38 + 4×2 = 46.)
- Double-limiter files (verified by grep): `vault/recovery-key/recover` (verifyLimiter + resetLimiter), `share-links/verify-access` (ipLimiter + tokenLimiter), `mcp/token` (tokenRateLimiter + ipRateLimiter), `tenant/members/[userId]/reset-vault/[resetId]/approve` (approveLimiter + approveTargetLimiter).
- **F21 note**: `src/app/api/tenant/members/[userId]/reset-vault/route.ts` (the *initiate* endpoint for admin vault reset, distinct from row 6 `vault/admin-reset/route.ts` which is the operator's own reset) is **deliberately excluded from the opt-in table** because the initiate endpoint requires session+role gating and the existing limiter design already constrains spread sufficiently for cross-instance scenarios; the destructive moment is the `approve` (row 39) which IS in the table. Re-evaluate if a future security review surfaces it.

**Excluded credential boundaries (with rationale)** (S5):
- `/api/auth/[...nextauth]` OAuth callback (60/min per IP): single-use auth code at IdP side (Google enforces) + IdP-side rate limiting in front; Redis fail-open low-risk. Re-evaluate next OAuth review.
- `/api/sessions/*`, `/api/notifications/*`: session/UX endpoints with no credential boundary semantics.
- Service-account token CRUD (`/api/tenant/service-accounts/*`): admin-session-gated; rate limit is anti-abuse, not credential boundary; in-memory fallback acceptable.

**Invariants**:
- I4.1: Every route in this table MUST have BOTH `failClosedOnRedisError: true` AND `if (rl.redisErrored) { ...; return <envelope-helper>(); }` branch.
- I4.2: Audit emission `void emitRateLimitFailClosed(...)` on the 503 branch. (Pre-auth routes pass null tenantId → I3.7 skips audit but the helper call is still present.)
- I4.3: Routes NOT in this table MUST NOT be changed in this PR.
- I4.4: Custom-envelope routes (#12 vault/delegation/check + #29-32 OAuth/DCR) MUST use the correct envelope per the table — NOT `serviceUnavailable()` for OAuth, NOT canonical envelope for `vault/delegation/check`.

**Forbidden patterns** (grep after Phase 2 completes):
- `pattern: failClosedOnRedisError:\s*true` outside the 42 files in this table — reason: scope creep.
- `pattern: rl\.redisErrored` outside the 42 files — reason: same.
- `pattern: if\s*\(!rl\.allowed\)\s*return\s*rateLimited` in any file in this table on a line where `rl.redisErrored` is NOT first-checked above it — reason: missed fail-closed branch.
- `pattern: serviceUnavailable\(` inside `src/app/api/mcp/` — reason: must use `oauthTemporarilyUnavailable`. (F2)

**Acceptance criteria**:
- AC4.1 (T1 mitigation — reduced scope): for the **subset of opt-in routes that already have a route-handler unit test today** (mcp/authorize and any tests added in Phase 2 implementation), a test case mocks the limiter to return `{ allowed: false, redisErrored: true }` and asserts the route returns the correct envelope per the table.
- AC4.2: Existing 429 rate-limit-exceeded test paths continue to pass — fail-closed addition must not regress in-bound rate-limit case.
- AC4.3 (S13/T15/F22/T17 — concrete spec, corrected): `scripts/checks/check-fail-closed-routes-have-test.sh` (new) runs in `scripts/pre-pr.sh`. Behaviour:
  1. Enumerate every file under `src/app/api/**/route.ts` whose body contains `failClosedOnRedisError: true`.
  2. Compute the expected sibling test path (T17 — precise rule, code-equivalent):
     ```
     route_path  = "src/app/api/<X>/route.ts"
     test_path   = "src/__tests__/api/<X>.test.ts"
     ```
     where `<X>` is everything between `src/app/api/` and `/route.ts`. Examples:
     - `src/app/api/mcp/authorize/route.ts` → `src/__tests__/api/mcp/authorize.test.ts`
     - `src/app/api/vault/recovery-key/recover/route.ts` → `src/__tests__/api/vault/recovery-key/recover.test.ts`
     - `src/app/api/api-keys/route.ts` → `src/__tests__/api/api-keys.test.ts`
     Note: existing tests use ad-hoc names in some places (`team-invitations.test.ts`, `members.test.ts`, `folder-by-id.test.ts`) that do NOT follow this rule. For those cases, the gate accepts an alternative match: any `*.test.ts` file under `src/__tests__/api/<X without trailing segment>/` that imports the route handler from `@/app/api/<X>/route` AND contains the literal token `redisErrored`.
  3. Require BOTH (a) the expected-path OR alternative-match test file exists AND (b) the test file contains the literal token `redisErrored` (asserting a fail-closed test case is present) OR the route file path appears in `scripts/checks/fail-closed-test-debt.txt` (debt allowlist committed in this PR).
  4. Exit 1 with structured stderr `MISSING_FAIL_CLOSED_TEST: <route-path> (expected: <test-path>)` listing every miss; exit 0 if all opt-in routes are covered or allowlisted.

  This PR commits an initial `fail-closed-test-debt.txt` listing the opt-in routes that lack a fail-closed test case today (one entry per route file); future PRs MUST remove an entry from the debt file when adding the fail-closed test case for that route. Routes with existing tests (e.g., `mcp/authorize.test.ts`) get the fail-closed test case added in this PR. Debt file rationale documented at the top as a comment.
- AC4.4: Grep enumeration confirms `failClosedOnRedisError: true` count = 46 in production code outside tests.
- AC4.5: Grep enumeration confirms `rl.redisErrored` branch count = 46.

**Mock pattern (F9)**: existing route tests that mock `createRateLimiter` at module scope use `vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn(() => ({ check: mockCheck, clear: vi.fn() })) }))`. To add a fail-closed test case in such a file, expose `mockCheck` and per-test set `mockCheck.mockResolvedValueOnce({ allowed: false, redisErrored: true })`. No global mock changes required.

### C5 — Audit action enum + i18n + constants

**Changes**:
1. `prisma/schema.prisma`: append `RATE_LIMIT_FAIL_CLOSED` to `AuditAction` enum.
2. New migration `prisma/migrations/<ts>_add_audit_action_rate_limit_fail_closed/migration.sql` via `npm run db:migrate`. Migration script form: `ALTER TYPE "AuditAction" ADD VALUE 'RATE_LIMIT_FAIL_CLOSED';` (Postgres-native; no env-specific values per R15).
3. `src/lib/constants/audit/audit.ts`:
   - Append to `AUDIT_ACTION`.
   - Append to `AUDIT_ACTION_VALUES` array (F1).
   - Register in `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MAINTENANCE]` (system-health event sibling of `AUDIT_DELIVERY_FAILED`).
   - Add to `WEBHOOK_DISPATCH_SUPPRESS` set (S4 — prevent webhook storm during outage).
4. `src/lib/constants/audit/audit-target.ts`: add `RATE_LIMITER: "RateLimiter"` to `AUDIT_TARGET_TYPE` (S7).
5. `messages/en/AuditLog.json`: add label.
6. `messages/ja/AuditLog.json`: add label.
7. Re-check `OUTBOX_BYPASS_AUDIT_ACTIONS` — action MUST NOT be on it (we WANT the audit row written through outbox).

**Invariants**:
- I5.1: Every enumeration consumer updated. Concrete list:
  - `AUDIT_ACTION` const (audit.ts:17)
  - `AUDIT_ACTION_VALUES` array (audit.ts:197)
  - `AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE]` (audit.ts:664)
  - `WEBHOOK_DISPATCH_SUPPRESS` set (audit.ts ~200)
  - `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`
  - `prisma/schema.prisma` enum
  - `src/lib/audit/audit-action-label.ts`: no change (default branch handles it).
  - `src/components/audit/audit-action-icons.test.tsx`: verify the existing `VAULT_UNLOCK_FAILED` sentinel test still asserts an unmapped action (still unmapped; no change needed).
  - Tests touched by enumeration coverage: `src/__tests__/audit-action-group-coverage.test.ts` (auto-passes once registered); `audit-i18n-coverage` if present.
  - `ACTOR_TYPE.ANONYMOUS` and `ANONYMOUS_ACTOR_ID` — existing constants (used by `src/app/api/share-links/verify-access/route.ts:84-107`); no schema/const change. (F19)
- I5.2: JSON files preserve trailing-comma validity.
- I5.3: New enum value appended at the end of `AuditAction` enum (matches existing convention; do NOT sort alphabetically — would break migration determinism).

**Forbidden patterns**:
- `pattern: RATE_LIMIT_FAIL_CLOSED` inside `OUTBOX_BYPASS_AUDIT_ACTIONS` definition.
- `pattern: TODO.*RATE_LIMIT_FAIL_CLOSED` or any placeholder.

**Acceptance criteria**:
- AC5.1: `npm run db:migrate` applies cleanly against dev DB with real data (per memory `feedback_run_migration_on_dev_db.md`).
- AC5.2: `npx prisma generate` regenerates Prisma Client with new enum value.
- AC5.3: `npx vitest run` passes including `audit-action-group-coverage.test.ts` and any other exhaustive-enum tests.
- AC5.4 (T5 + T13 split): two acceptance criteria covering the write half and the drain half:
  - **AC5.4a (write — committed in this PR)**: integration test `src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts` exercises `emitRateLimitFailClosed` against the real DB and asserts a row appears in `audit_outbox` with `status='PENDING'`, `action='RATE_LIMIT_FAIL_CLOSED'`, `metadata` containing scope/ip/ipBucket, plus the correct `actorType`/`tenantId` per the test scenario. Does NOT mock `logAuditAsync` (uses the real path). Mocks `getRedis` to force the redisErrored branch.
  - **AC5.4b (drain — manual test, NOT new automated test)**: drain-side verification is covered by the **Manual test plan Scenario A SQL query** which queries `audit_logs` (the drained table, not `audit_outbox`). This requires the operator to have started the outbox worker via `npm run worker:audit-outbox` per pre-conditions. Rationale: confirmed at plan revision that `src/__tests__/integration/` currently has 4 tests (audit-and-isolation, jit-workflow, mcp-oauth-flow, sa-lifecycle) and **none drain the outbox** — so AC5.4b would require building new test infrastructure (spawning a worker subprocess from vitest, etc.). Defer to a follow-up PR; in v1, manual-test Scenario A is the drain proof. AC5.4a alone is sufficient to prove the Prisma enum acceptance (T13 resolution accepts this trade-off rather than building cross-process worker test infra in this PR).
- AC5.5 (T11): `git status prisma/migrations/` after `npm run db:migrate` shows the new migration committed alongside the schema change.

### C6 — Operations runbook

**File**: `docs/operations/runbook-redis-outage.md` (new)

**Required sections**:
1. **Symptom**: 503 spike on the routes listed in C4 + `rate-limit.redis.fallback` log entries.
2. **Root cause check**: `redis-cli ping`; `docker compose ps redis`; sentinel/managed-Redis status.
3. **Impact**: enumerated routes return 503 → users cannot unlock vault, complete passkey login, mint tokens. Other routes continue with in-memory fallback (degraded but functional).
4. **Recovery**: restore Redis; no app restart required.
5. **Audit verification**: SQL example to count `RATE_LIMIT_FAIL_CLOSED` rows per scope per hour. Note: pre-auth routes (per C4 column / I3.7) emit warn-log only, NOT audit rows; SIEM query for `rate-limit.fail_closed.pre_auth_skip` covers those.
6. **Alerting**: example alertmanager rule (rate > N 503/min on listed paths for 2+ min); example log-based rule (count of `rate-limit.redis.fallback` > M per 5 min).
7. **Break-glass procedure** (S9): if Redis cannot be restored within the operational tolerance window AND immediate access to vault-unlock/token-mint is essential, the documented escape is to revert this PR's merge commit on `main` and deploy. `failClosedOnRedisError` is a no-op when removed. **There is no env-toggle disable in v1** to preserve the "no silent disable in production" guarantee.
8. **Why fail-closed**: brief security rationale + link to this plan / PR.

**Forbidden patterns** (RS4):
- `pattern: claude\.ai@` or any personal email.
- `pattern: \b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` IPs other than RFC 1918 / RFC 5737 documentation ranges.

**Acceptance criteria**:
- AC6.1: Runbook lists all 42 routes (or links to C4 table) with the envelope they emit; operator can execute every step against a dev cluster.
- AC6.2: RS4 grep returns no personal data.
- AC6.3: Break-glass procedure (§7) is reproducible: a Phase 2 manual test verifies the revert deploys cleanly.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `createRateLimiter` options + result shape + wrapper widening | locked |
| C2 | `serviceUnavailable` canonical 503 helper | locked |
| C2b | `oauthTemporarilyUnavailable` OAuth 503 helper | locked |
| C3 | `emitRateLimitFailClosed` audit helper (pre-auth skip, LRU, ANONYMOUS actor, RATE_LIMITER target, ip+ipBucket metadata, scope regex) | locked |
| C4 | Opt-in route table — 42 routes / 46 limiters / envelope-per-route column | locked |
| C5 | Audit action enum + i18n + AUDIT_ACTION_VALUES + AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE] + WEBHOOK_DISPATCH_SUPPRESS + AUDIT_TARGET_TYPE.RATE_LIMITER + integration test | locked |
| C6 | Operations runbook + break-glass procedure | locked |

## Testing strategy

### Unit (vitest)

1. `src/__tests__/lib/rate-limit.test.ts` — extend with AC1.2 / AC1.3 / AC1.4 / AC1.5. Mock `getRedis` to return null and to reject pipeline.exec.
2. `src/__tests__/lib/ip-rate-limit.test.ts` (extend or new section) — AC1.5: wrapper propagates `redisErrored: true`.
3. `src/__tests__/lib/rate-limit-audit.test.ts` (new) — AC3.1-AC3.8. `beforeEach` calls `__resetThrottleForTests()`.
4. `src/__tests__/lib/api-response.test.ts` — extend with AC2.1-AC2.5 (serviceUnavailable) and AC2b.1-AC2b.2 (oauthTemporarilyUnavailable).
5. For opt-in routes that ALREADY have a route-handler unit test (mcp/authorize.test.ts + any added during Phase 2), add a "503 on redisErrored" test case using `mockCheck.mockResolvedValueOnce({ allowed: false, redisErrored: true })`.

### Integration

- `src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts` (new, AC5.4) — happy-path round-trip of `emitRateLimitFailClosed` to audit_logs via outbox.
- Existing integration tests under `src/__tests__/integration/` (vault unlock, passkey, MCP flows) continue to pass through normal Redis path; no regression expected.

### Schema migration verification (per memory `feedback_run_migration_on_dev_db.md`)

- Run `npm run db:migrate` against dev DB with real data before opening PR.
- Confirm `npx prisma generate` produces the new enum value.
- Confirm the new migration file is committed alongside `prisma/schema.prisma` (T11 — grep `add_audit_action_rate_limit_fail_closed` in `prisma/migrations/`).

### Build verification

- `npx vitest run` — all tests pass.
- `npx next build` — production build succeeds (per project memory `feedback_run_pre_pr_before_push.md`).
- `bash scripts/pre-pr.sh` — full CI-equivalent check (includes new `check-fail-closed-routes-have-test.sh`).

### Coverage gap analysis

- **AC4.1 reduced scope** (T1): only routes with existing tests get a per-route case. The `check-fail-closed-routes-have-test.sh` CI gate (AC4.3) records the coverage gap for future PRs to fill.
- E2E not added — project has no E2E framework wired into CI.
- Manual test plan in `docs/archive/review/rate-limit-fail-closed-on-redis-manual-test.md` (R35 Tier-2 — auth flows touched).

## Manual test plan (R35 Tier-2)

File: `docs/archive/review/rate-limit-fail-closed-on-redis-manual-test.md` (created in Phase 2).

### Pre-conditions

- Dev cluster up: `npm run docker:up`.
- Test users (placeholders — operator substitutes locally per RS4):
  - `<test-user-A-email>` in tenant A with passkey + vault setup.
  - `<test-user-B-email>` in tenant B with passkey + vault setup.
- Dev MCP client registered via DCR.
- `psql` access to dev DB.

### Steps

1. **Vault unlock — Redis up**: `curl -X POST .../api/vault/unlock` with valid creds → 200.
2. **Vault unlock — Redis stopped**: `docker compose stop redis`; repeat → expect 503 + `Retry-After: 30` + body `{"error":"SERVICE_UNAVAILABLE"}`. Then `docker compose start redis`; repeat → 200.
3. **Passkey verify — Redis stopped**: same shape; no session created.
4. **MCP token exchange — Redis stopped**: expect 503 + body `{"error":"temporarily_unavailable"}` (RFC 6749 envelope); no token issued.
5. **OAuth callback (`/api/auth/[...nextauth]`) — Redis stopped**: NOT in opt-in list — callback still functions via in-memory fallback as today; confirms degradation isolation.
6. **Audit verification (post-auth)** (T19 — Prisma camelCase fields map to snake_case Postgres columns; use unquoted snake_case in psql): after step 2 with valid logged-in user, run:
   ```sql
   SELECT action, scope, actor_type, target_type, target_id, metadata
   FROM audit_logs
   WHERE action='RATE_LIMIT_FAIL_CLOSED' AND created_at > NOW() - INTERVAL '5 min';
   ```
   Expect ≥1 row per scope; `target_type='RateLimiter'`, `target_id='vault.unlock'`, `actor_type='HUMAN'`, `metadata` contains `scope`, `ip`, `ipBucket`.
7. **Audit verification (pre-auth)**: after step 3, run the same query — expect ZERO rows (I3.7 skips). Instead grep dev logs: `grep 'rate-limit.fail_closed.pre_auth_skip' <log-file>` → ≥1 line.
8. **Throttle verification**: trigger step 2 ten times in 30 s from one logged-in user; the audit row count for that (scope, userId) should be 1 (not 10).
9. **LRU eviction verification (S4)**: trigger step 3 from 10_000+ distinct pre-auth requests (use `xargs -P 50` with synthetic IPs via X-Forwarded-For — note: requires `TRUST_PROXY_HEADERS=true` in dev). Confirm legitimate post-auth (step 2) audit row count for one user is preserved (NOT cleared).

### Expected result

- 503 emitted with correct envelope per route class.
- No session/token issued during outage.
- Audit emitted (throttled, post-auth only).
- Pre-auth: warn log emitted, NO audit row.
- Redis recovery requires no app restart.

### Rollback

- Revert the merge commit; `failClosedOnRedisError` is no-op when option is removed.

### Adversarial scenarios (Tier-2 mandatory, T6 — actionable)

**Scenario A: Cross-tenant audit isolation**

- Pre-conditions: user A in tenant A, user B in tenant B, both logged in.
- Stop Redis. User A triggers vault unlock 1x. User B triggers vault unlock 1x.
- SQL assertion (F18/T19 fix — query individual rows; use snake_case Postgres column names):
  ```sql
  SELECT tenant_id, user_id, metadata->>'ip' AS ip, metadata->>'scope' AS scope
  FROM audit_logs
  WHERE action='RATE_LIMIT_FAIL_CLOSED' AND created_at > NOW() - INTERVAL '5 min'
  ORDER BY tenant_id;
  ```
- Pass: exactly 2 rows; row for `tenant_A_id` has `user_A_id` + user A's IP; row for `tenant_B_id` has `user_B_id` + user B's IP. Fail: any row has `tenant_id` mismatched against the `user_id`'s actual tenant.

**Scenario B: Token replay during outage (MCP)**

- Pre-conditions: valid MCP refresh token from a prior session.
- Stop Redis. Submit refresh token to `/api/mcp/token` 3 times.
- SQL assertion (T19 — snake_case columns):
  ```sql
  SELECT action, COUNT(*) FROM audit_logs
  WHERE action IN ('MCP_REFRESH_TOKEN_ROTATE','MCP_REFRESH_TOKEN_REPLAY','MCP_REFRESH_TOKEN_FAMILY_REVOKED','RATE_LIMIT_FAIL_CLOSED')
   AND created_at > NOW() - INTERVAL '5 min'
  GROUP BY action;
  ```
- Pass: 3 RATE_LIMIT_FAIL_CLOSED rows (throttled to 1) + zero ROTATE/REPLAY/FAMILY_REVOKED (route 503'd before token logic). Fail: any ROTATE/REPLAY row → token logic ran despite Redis being down → refresh family at risk.

**Scenario C: Audit storm DoS suppression**

- Pre-conditions: shell with `siege`/`ab`/`hey` installed; one logged-in user; dev cluster.
- Stop Redis. Generate 1000 requests in 60 s to vault/unlock from one user.
- SQL assertion (T19 — snake_case columns):
  ```sql
  SELECT COUNT(*) FROM audit_logs
  WHERE action='RATE_LIMIT_FAIL_CLOSED' AND created_at > NOW() - INTERVAL '2 min';
  ```
- Pass: ≤ 1 row (throttle holds). Fail: > 1 → throttle broken or evicted.

**Scenario D: Scope-elevation attempt (MCP)** (T14 — replace non-existent `MCP_AUTHZ_DENIED` assertion with positive-side verification; T19 snake_case columns)

- Pre-conditions: MCP token with `credentials:list` scope only; an existing delegation session record from a prior successful unlock.
- Stop Redis. Token holder attempts `credentials:decrypt` via `/api/mcp` (or directly via `/api/mcp/token` exchange).
- HTTP assertion: response status 503 with body `{"error":"temporarily_unavailable"}` (OA envelope per C4).
- SQL assertion (verify route 503'd BEFORE any token/scope logic ran):
  ```sql
  SELECT action, COUNT(*) FROM audit_logs
  WHERE action IN ('MCP_REFRESH_TOKEN_ROTATE','MCP_REFRESH_TOKEN_REPLAY','MCP_CONSENT_GRANT')
   AND created_at > NOW() - INTERVAL '5 min'
  GROUP BY action;
  -- and also:
  SELECT COUNT(*) FROM delegation_sessions
   WHERE created_at > NOW() - INTERVAL '5 min';
  ```
- Pass: zero `MCP_REFRESH_TOKEN_*` / `MCP_CONSENT_GRANT` rows AND no new `delegation_sessions` rows in the window (route 503'd before token logic, no protected resource access). Fail: any ROTATE/REPLAY/CONSENT row → token logic ran despite Redis being down, or a new delegation session was created.

## Considerations & constraints

### Considerations-1: in-memory throttle map sizing

LRU eviction (I3.2) keeps map within `RATE_LIMIT_MAP_MAX_SIZE = 10_000`. Botnet-style flooding is bounded by the cap; legitimate state is preserved (S4 fix).

### Considerations-2: tenant resolution + pre-auth fallback

Two cases for the audit emission decision (set in `emitRateLimitFailClosed`):

1. **Caller passes tenantId** (e.g., `vault/delegation` already resolves it; `share-links/verify-access tokenLimiter` derives it from the share record): helper uses the provided value, no DB lookup.
2. **Caller passes `tenantId: null`** but provides `userId`: helper invokes `resolveUserTenantId(userId)` (tenantMember PK-indexed lookup, withBypassRls). Success → audit row emitted. Resolution failure (null OR throw) → warn-log only.
3. **Caller passes both `userId: null` and `tenantId: null`** (true pre-auth, e.g., passkey/options): no lookup attempted, warn-log only.

Why this is safe on the 503 hot path: callers `void emitRateLimitFailClosed(...)`, so the await on `resolveUserTenantId` does NOT block the response. The DB lookup costs ~1ms async, not blocking. (Phase 3 F1/S1 fix supersedes the prior "skip-on-null-tenant" design that silently downgraded 23 post-auth routes to warn-log-only.)

Operations runbook (C6 §5) updated: post-auth routes WILL produce audit rows; pre-auth and resolution-failed routes appear only in the `rate-limit.fail_closed.pre_auth_skip` warn-log stream.

### Considerations-3: webhook fan-out during Redis outage — SUPPRESSED

`RATE_LIMIT_FAIL_CLOSED` IS added to `WEBHOOK_DISPATCH_SUPPRESS` (S4). Operators monitor via SIEM / logs / audit rows directly. Webhook subscribers do not receive these events (avoids storm during outage).

### Considerations-4: opt-in route inventory expanded

Plan covers 42 routes (46 limiter instantiations across the 38 single + 4 double-limiter files).

Provenance arithmetic (F16 fix — corrected count):
- 13 routes from the verbatim user-supplied list below.
- 23 adjacent-credential routes added per user instruction "明らかに同類の隣接 routes も含める" (vault/setup, vault/reset, vault/change-passphrase, vault/admin-reset, vault/recovery-key/{recover,generate}, vault/rotate-key, vault/rotate-key/data, vault/unlock/data, vault/delegation, vault/delegation/check, auth/passkey/reauth/{verify,options}, webauthn/authenticate/options, webauthn/register/options, webauthn/credentials/[id]/prf, webauthn/credentials/[id]/prf/options, tenant/access-requests/{[id]/approve,[id]/deny}, mcp/register, mcp/revoke, extension/token/exchange, extension/bridge-code).
- 6 routes added per S2 (mobile/token, mobile/token/refresh, tenant/members/.../reset-vault/[resetId]/approve, share-links/[id]/content, emergency-access/accept, teams/invitations/accept).
- Total: 13 + 23 + 6 = 42.

User-supplied list (verbatim from task prompt) for traceability (13 routes):
> /api/vault/unlock, /api/auth/passkey/verify, /api/auth/passkey/options, /api/auth/passkey/options/email, /api/webauthn/authenticate/verify, /api/webauthn/register/verify, /api/share-links/verify-access, /api/api-keys, /api/tenant/access-requests, /api/mcp/token, /api/mcp/authorize, /api/extension/token, /api/extension/token/refresh.

### Considerations-5: wrapper widening LOCKED in C1 invariant I1.5

No longer deferred. AC1.5 verifies.

### Considerations-6: parallel naming `rateLimited` / `serviceUnavailable` / `oauthTemporarilyUnavailable`

Three helpers coexist in `api-response.ts`. Future PRs may consolidate; out of scope.

### Considerations-7: `vault/unlock` lock_timeout 503 path preserved

The ad-hoc `errorResponse(SERVICE_UNAVAILABLE, ..., { "Retry-After": "1" })` at `vault/unlock/route.ts:96-101` is documented exception in C2 forbidden patterns. Different semantic (lock contention vs Redis fail-closed). NOT migrated. AC2.5 asserts unchanged.

### Considerations-8: backward-compat for existing route tests

~47 existing test files mock `createRateLimiter` (T10 corrected count). Optional additive `redisErrored?: true` field does not break shape compatibility. Test authors MUST omit `redisErrored: false` (literal-true type rejects `false`; forbidden pattern in C1).

### Considerations-9: pre-pr.sh + CI checks

Pre-pr adds `scripts/checks/check-fail-closed-routes-have-test.sh` (AC4.3). Migration drift caught by existing `scripts/checks/check-migration-drift.mjs` (verify exists during Phase 2).

### Considerations-10: PR cadence

Per memory `feedback_pr_cadence_aggregate.md`: this is ONE PR. Coverage gap (AC4.3) is documented and tracked by the new CI gate — future PRs author missing per-route tests.

### Considerations-11: sustained-outage break-glass (S9)

No env-toggle to disable fail-closed (preserves "no silent disable in production"). Operator escape valve: revert this PR's merge commit and deploy. Runbook §7 documents step-by-step. Trade-off accepted: if Redis is unavailable for hours during a deployment freeze, operators have a documented but heavyweight remediation path. Re-evaluate in 6 months based on real-world outage data.

## User operation scenarios

(See Manual test plan above — Scenarios A-D are the user-operation manifestations.)
