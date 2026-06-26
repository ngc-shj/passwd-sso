# Plan: rate-limiter fail-closed + GET auto-purge removal

## Project context

- **Type**: web app + service (Next.js 16 App Router, multi-tenant, E2E-encrypted password manager)
- **Test infrastructure**: unit (vitest) + integration (real-DB) + E2E (playwright) + CI/CD
- **Verification environment constraints**:
  - Redis-unavailable fail-closed paths: `verifiable-local` via mocking `getRedis()` → null (unit). No live Redis outage needed.
  - retention-gc worker trash-purge: `verifiable-CI` (real-DB integration suite already covers `sweepTrashEntry`).
  - OAuth/SAML callback under real IdP outage: `blocked-deferred` — cannot exercise a real Redis+IdP simultaneous outage locally; unit test asserts the 503 branch via mocked limiter result. (Cost-justification: a real dual-outage rig requires a staged IdP + Redis cluster; out of proportion to a 3-line branch addition that is unit-covered.)

## Objective

Phase 1 of the external OWASP review remediation:
1. Make security-sensitive rate limiters fail **closed** on Redis error (M1, M4, M5, M6).
2. Remove the destructive, observability-blind trash auto-purge side effect from `GET /api/passwords` and `GET /api/teams/[teamId]/passwords` (L3). The retention-gc worker already owns this purge.

Out of scope (separate PR / accepted): M2/M3 Bearer matcher narrowing, L1 orphan-blob retry, L2 SCIM session-invalidation hardening.

## Requirements

### Functional
- R-FC1: Every limiter listed below returns 503 (canonical `{error:"SERVICE_UNAVAILABLE"}`) when Redis is unreachable, instead of falling back to the in-memory Map.
- R-FC2: Normal over-limit behavior (429) is unchanged when Redis is healthy.
- R-FC3: Fail-closed 503 events emit the standard rate-limit-fail-closed audit/warn (via `checkRateLimitOrFail` → `emitRateLimitFailClosed`).
- R-L3-1: `GET /api/passwords` and `GET /api/teams/[teamId]/passwords` perform NO writes/deletes. They become read-only.
- R-L3-2: Trash auto-purge continues to run via the retention-gc worker (already registered: `PER_TENANT_TRASH` for `password_entries` + `team_password_entries`).

### Non-functional
- No new dependency. Reuse the existing `checkRateLimitOrFail` helper (`src/lib/security/rate-limit-audit.ts`) and `createRateLimiter` option `failClosedOnRedisError`.
- Match the existing fail-closed routes' envelope and audit wiring.

## Technical approach

### Rate limiters → fail-closed

The limiter factory already supports `failClosedOnRedisError: true`. On Redis error it returns `{ allowed:false, redisErrored:true }`. The route must translate `redisErrored` → 503. The canonical translator is `checkRateLimitOrFail` (already used by ~22 fail-closed routes); it fires `emitRateLimitFailClosed` internally.

Two shapes:
- **Direct-limiter routes** (v1 passwords, autofill, breakglass): pass `{ limiter, key }` to `checkRateLimitOrFail`.
- **IP-keyed wrapper routes** (auth callback, magic link): `checkIpRateLimit` already returns a `RateLimitResult` (propagating `redisErrored`). Pass `{ result }` to `checkRateLimitOrFail`. The wrappers currently branch only on `!rl.allowed`; add the `redisErrored → 503` branch.

`magicLinkEmailLimiter` (per-email, in `auth.config.ts`) is ALREADY `failClosedOnRedisError: true`. This PR closes the per-IP asymmetry.

### L3 → delete inline purge

The retention-gc worker (`sweepTrashEntry`, registry `PER_TENANT_TRASH`) already auto-purges trashed entries per-tenant using `trashRetentionDays` (NULL → tenant skipped = opt-in, "no implicit deletion"). The GET-route inline purge is a leftover duplicate that (a) puts a destructive `deleteMany` on a GET, (b) swallows failures via `.catch(()=>[])` with zero audit/log/metric, and (c) force-purges at a hardcoded 30 days regardless of the tenant's opt-in. Removing it **completes** the migration to the worker's opt-in model.

**Behavior change to surface**: tenants with `trashRetentionDays = NULL` will no longer have trash auto-purged at 30 days on list. This is the worker's intended opt-in semantics; it is not a regression but IS an observable behavior change. Documented here for reviewer awareness.

## Contracts

### C1 — `failClosedOnRedisError` on five limiters — locked
- **Files**:
  - `src/lib/security/rate-limiters.ts` — `v1ApiKeyLimiter` (M1)
  - `src/app/api/auth/[...nextauth]/route.ts` — `callbackRateLimiter`, `magicLinkIpLimiter` (M4)
  - `src/app/api/mobile/autofill-token/route.ts` — `mintLimiter` (M5)
  - `src/app/api/tenant/breakglass/route.ts` — `breakglassRateLimiter` (M6)
- **Invariant** (app-enforced): each `createRateLimiter(...)` above includes `failClosedOnRedisError: true`.
- **Forbidden patterns**:
  - `pattern: v1ApiKeyLimiter = createRateLimiter\(\{[^}]*\}\)` without `failClosedOnRedisError` — reason: M1 must be fail-closed
- **Acceptance**: grep each factory call → `failClosedOnRedisError: true` present.

### C2 — v1 passwords routes translate redisErrored → 503 — locked
- **Files**: `src/app/api/v1/passwords/route.ts` (GET+POST), `src/app/api/v1/passwords/[id]/route.ts` (the shared `checkAuth` helper at top of file).
- **Approach**: replace the `const rl = await v1ApiKeyLimiter.check(...); if (!rl.allowed) return rateLimited(...)` blocks with `checkRateLimitOrFail({ req, limiter: v1ApiKeyLimiter, key, scope:"v1.passwords", userId, tenantId })`. Returns 503 on redisErrored, 429 on over-limit, null to proceed.
- **Invariant** (app-enforced): no v1 passwords path falls back to in-memory on Redis error.
- **Acceptance**: unit test — limiter `check` mocked to `{redisErrored:true}` → response 503; mocked `{allowed:false,retryAfterMs}` → 429; `{allowed:true}` → proceeds.
- **Consumer-flow walkthrough**: the only consumer of these responses is the v1 API client (CLI / REST). It reads HTTP status: 503 → retry-after backoff; 429 → rate-limit backoff. Both statuses are already in the v1 contract (`SERVICE_UNAVAILABLE`, `RATE_LIMIT_EXCEEDED`). No body-shape field is newly required.

### C3 — autofill-token + breakglass translate redisErrored → 503 — locked
- **Files**: `src/app/api/mobile/autofill-token/route.ts`, `src/app/api/tenant/breakglass/route.ts`.
- **Approach**: same `checkRateLimitOrFail` swap. breakglass: scope `"breakglass"`, userId + tenantId available. autofill: scope `"mobile.autofill_token"`, userId available (tenantId too).
- **Acceptance**: same 503/429/proceed unit matrix.

### C4 — auth callback + magic-link wrappers translate redisErrored → 503 — locked
- **File**: `src/app/api/auth/[...nextauth]/route.ts`.
- **Approach**: in `withCallbackRateLimit` and `withMagicLinkIpRateLimit`, after `const rl = await checkIpRateLimit(...)`, call `checkRateLimitOrFail({ req: request, result: rl, scope, userId: null })` and return its non-null result as `Response`. Pre-auth (userId null) → `emitRateLimitFailClosed` warn-logs (per its pre-auth branch).
- **Invariant** (app-enforced): callback/magic-link return 503 on Redis error; null-IP still fail-OPEN (existing `checkIpRateLimit` behavior, intentional — proxy-misconfig detection, NOT changed here).
- **Acceptance**: unit — mocked `checkIpRateLimit` → `{redisErrored:true}` yields 503; `{allowed:false}` yields 429; `{allowed:true}` proceeds to handler; null-IP path (`{allowed:true}` from helper) proceeds.
- **Note**: This makes OAuth/SAML login callbacks fail-closed during a Redis outage (login blocked until Redis recovers). User explicitly accepted this trade-off ("今回は全部 fail-closed").

### C5 — remove inline trash auto-purge from GET list routes — locked
- **Files** (exact per-file import edits — verified against actual usage by Phase-1 functionality review F1):
  - `src/app/api/passwords/route.ts` — delete lines 71-100 (the `if (!trashOnly) { ... auto-purge ... }` block). Then remove imports that become unused (sole uses were in that block): `collectEntryAttachmentRefs`, `deleteAttachmentBlobs`, `AttachmentBlobRef` (the whole `@/lib/blob-store/cleanup` import group), `MS_PER_DAY`. From the line-12 import, remove ONLY `TRASH_PURGE_BATCH_SIZE` — `FILENAME_MAX_LENGTH` (same line) is still used at line ~186.
  - `src/app/api/teams/[teamId]/passwords/route.ts` — delete lines 59-68 (the `if (!trashOnly) { ...purgeExpiredTeamPasswords... }` block) + remove ONLY the `deleteAttachmentBlobs` import (line 16). `errorResponse`, `TeamPasswordServiceError`, `FILENAME_MAX_LENGTH` remain used.
  - `src/lib/services/team-password-service.ts` — delete `purgeExpiredTeamPasswords` (dead code; worker uses `sweepTrashEntry`, not this helper). Remove ONLY the now-unused `MS_PER_DAY` and `TRASH_PURGE_BATCH_SIZE` imports. **KEEP `collectEntryAttachmentRefs` and `AttachmentBlobRef` (lines 9-10)** — still used by `deleteTeamPassword` (~lines 590/593). Verify no other caller of `purgeExpiredTeamPasswords` exists via grep before deleting.
- **Invariant** (app-enforced): `GET /api/passwords` and `GET /api/teams/[teamId]/passwords` contain no `deleteMany` / `deleteAttachmentBlobs` / purge call.
- **Forbidden patterns**:
  - `pattern: passwordEntry\.deleteMany` in `src/app/api/passwords/route.ts` — reason: GET must be read-only
  - `pattern: purgeExpiredTeamPasswords` anywhere after this PR — reason: dead helper removed
- **Acceptance**:
  - grep the two GET route files → no `deleteMany`, no `deleteAttachmentBlobs`, no `purgeExpired*`.
  - existing GET list tests still pass (list output unchanged).
  - retention-gc integration test (`retention-gc-worker-sweep`) still green (worker still purges).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `failClosedOnRedisError:true` on 5 limiters | locked |
| C2 | v1 passwords routes → 503 on redisErrored | locked |
| C3 | autofill + breakglass → 503 on redisErrored | locked |
| C4 | auth callback + magic-link wrappers → 503 on redisErrored | locked |
| C5 | remove inline trash auto-purge from GET list routes + dead helper | locked |

## Testing strategy

Canonical mock pattern (mirror `src/app/api/mobile/authorize/route.test.ts:71-73,182-193`): mock `@/lib/security/rate-limit-audit` with a hoisted `mockCheckRateLimitOrFail`, default `mockResolvedValue(null)` in `beforeEach`, and per-case `mockResolvedValueOnce(503-response)` / `(429-response)`. This avoids running the real `emitRateLimitFailClosed` (which calls real audit/tenant resolution) in unit env.

- **R-FC2/R-FC3 mapping owned by `src/lib/security/rate-limit-audit.test.ts`** — the `{allowed:false}→429`, `{redisErrored}→503`, and `emitRateLimitFailClosed`-fired assertions live at the helper level. Verify this test exists and covers the redisErrored branch (R-FC3 is otherwise untested). Route tests mock the helper and assert *propagation* only.
- **C2 (v1 passwords)**: in GET/POST + the `[id]` local `checkAuth`, mock `checkRateLimitOrFail`. redisErrored test MUST assert `status===503` AND that the handler body did not run (`expect(mockEntryFindMany / mockEntryCreate / mockEntryUpdate).not.toHaveBeenCalled()`) — guards the vacuous-test trap (T7). Keep a 429 propagation test and an `{allowed→null}` proceed test.
- **C3 (autofill, breakglass)**: autofill test currently has NO rate-limit mock seam (drives the real limiter) — add the `@/lib/security/rate-limit-audit` mock (T1). redisErrored → assert 503 AND `expect(mockIssueAutofill).not.toHaveBeenCalled()`. breakglass → 503 AND no grant created.
- **C4 (auth callback + magic link)**: the existing test already mocks `@/lib/security/rate-limit` returning `{check: mockRateLimitCheck}`; set `mockRateLimitCheck.mockResolvedValue({redisErrored:true})` so `checkIpRateLimit` propagates it and the real `checkRateLimitOrFail({result})` yields 503 — assert `status===503` AND `expect(inner).not.toHaveBeenCalled()`. Also add a null-IP test asserting the path still PROCEEDS (no 503) — locks the intentional null-IP fail-open invariant (T7). **Export `withMagicLinkIpRateLimit` as `_withMagicLinkIpRateLimit`** (currently unexported) so magic-link's 503 path is testable (T2); mirror the existing `_withCallbackRateLimit` describe block.
- **C5**:
  - personal `passwords/route.test.ts`: remove the now-dead `deleteMany.mockResolvedValue(...)` setup lines; add a regression guard `it("GET performs no deleteMany (read-only after L3)")` → `expect(mockPrismaPasswordEntry.deleteMany).not.toHaveBeenCalled()` (T5 — converts grep-only acceptance into an executable guard).
  - team route has NO route test file (T6) — read-only-ness is grep-enforced (forbidden-pattern) + dead-helper removal; acknowledge the team GET is route-test-blind.
  - Worker trash-purge coverage already exists in `src/__tests__/db-integration/retention-gc-trash-purge.integration.test.ts` (personal trash + cascade + NULL-retention skip) and unit `src/workers/retention-gc-worker/__tests__/sweep-trash.test.ts` (personal + team registries). C5 does NOT reduce net coverage (T3/T4).
- Mandatory: `npx vitest run` + `npx next build`.

## Considerations & constraints

### Scope contract
- **SC1**: M2 Bearer-matcher narrowing (`/api/teams/.../passwords/**`) — deferred to a separate PR (route policy = method + exact path + token kind). Owner: future security-hardening PR. Currently latent (all team mutating children are `auth()`-only).
- **SC2**: M3 personal `/api/passwords/**` — NOT a vulnerability (scope-gated `passwords:write` is intended); folded into SC1's latent-risk note.
- **SC3**: L1 orphan-blob retry/audit — accepted. Worst case: orphaned E2E-encrypted blob (billing/storage leak, no plaintext exposure). Likelihood: low (delete failures are rare). Cost to fix: a retry queue is a multi-file change. Deferred; tracked by external review L1.
- **SC4**: L2 SCIM session-invalidation hardening — accepted. The token/membership validators are fail-closed (next request rejected), so the invalidation failure is a latency-of-revocation issue, not a bypass. Deferred; tracked by external review L2.

### Known risks
- C4 makes login callbacks fail-closed on Redis outage (availability cost). Accepted by user. **Operational note (S3)**: this makes Redis a hard dependency for SSO login availability — a Redis flap/failover converts a throttling outage into a login outage (self-DoS angle). The callback limiter guards low-value (replay-flood blunting), not a secret. Record in the ops runbook + ensure Redis HA/fast-failover. Magic-link IP gate guards SMTP cost (reasonable to fail-closed; OAuth/passkey unaffected by that one gate).
- C5 behavior change: NULL-`trashRetentionDays` tenants lose 30-day auto-purge-on-list; the worker's opt-in model governs going forward. Documented above. The retained rows are E2E-encrypted (no plaintext-at-rest exposure) — this is retention-policy drift, not a confidentiality issue. Moving to opt-in means data is retained LONGER by default = the safer-for-user direction (no silent destruction).
- C5 operational dependency (F2): trash auto-purge now requires the `worker:retention-gc` process to be deployed. Deployments without it get no trash auto-purge at all (storage growth, not a correctness/security bug).
- S2 (deferred, confirm-before-close): the `/api/passwords/[id]/attachments` upload limiter remains fail-open. Acceptable IF attachments are quota-bounded (`assertQuotaAvailable`). Confirm during implementation; if not quota-gated, track as a Phase-2 candidate. Not a Phase-1 blocker.

## User operation scenarios

1. Redis down, CLI calls `GET /api/v1/passwords` → 503 (was: silently in-memory limited, effectively bypassed across pods).
2. Redis down, user submits magic-link email → 503 (was: per-pod in-memory limit).
3. Redis healthy, user exceeds v1 100/min → 429 (unchanged).
4. User lists vault (`GET /api/passwords`) → entries returned, no deletion happens during the request (was: up to 500 stale-trash rows hard-deleted as a side effect).
5. Tenant with `trashRetentionDays=14` → retention-gc worker purges at 14 days (unchanged, worker-driven).
