# Plan: OWASP re-review follow-ups — step-up on permanent purge + fail-closed mint/SCIM limiters

## Project context

- **Type**: web app + service (Next.js 16, multi-tenant E2E password manager).
- **Test infra**: unit (vitest) + integration (real-DB) + E2E + CI/CD. Not config-only.
- **Verification constraints**: all changes are unit-testable (mock `requireRecentCurrentAuthMethod` / the limiter). Redis-outage fail-closed is verified by mocking the limiter result; no live Redis outage needed.

## Objective

Remediate three OWASP re-review findings, all extensions of patterns already established in merged PRs:

- **M1 (Medium, A01/A04/A07)**: irreversible permanent-purge endpoints lack the step-up reauth that single permanent-delete already requires. Add `requireRecentCurrentAuthMethod` to the 5 purge endpoints.
- **M2 (Medium, A05/A07)**: SCIM runtime limiter is fail-open on Redis error. Make it fail-closed (503).
- **M3 (Low–Medium, A05/A07)**: token/account **create** limiters are fail-open. Make the 3 create limiters fail-closed (the #611 `checkRateLimitOrFail` pattern). Leave list limiters fail-open.

## Requirements

### M1 — step-up on permanent purge
- R-M1-1: These endpoints require a recent-auth (step-up) check after their existing auth+permission gate, matching `DELETE /api/passwords/[id]?permanent=true`:
  - `POST /api/passwords/empty-trash`
  - `POST /api/passwords/bulk-purge`
  - `DELETE /api/teams/[teamId]/passwords/[id]?permanent=true` (only the permanent branch)
  - `POST /api/teams/[teamId]/passwords/empty-trash`
  - `POST /api/teams/[teamId]/passwords/bulk-purge`
  - `POST /api/vault/reset` (self-reset — wholesale deletes ALL entries; added per security review S1)
- R-M1-2: All 5 are session-only (`auth()`), so NO token-type 403 guard is needed (unlike the reference handler). The step-up helper reads the session cookie and 401s a cookieless caller — but these are already session-gated, so it only adds the recency requirement.
- R-M1-3: The step-up check fires BEFORE any delete/body-mutation work (consistent ordering with the reference handler and breakglass).
- R-M1-4: team single-delete: gate step-up inside the existing `if (permanent)` branch only — soft-delete (trash) stays step-up-free (trash is the recovery window, matching personal).

### M2 — SCIM limiter fail-closed
- R-M2-1: `checkScimRateLimit` returns `RateLimitResult` (not boolean); the SCIM limiter sets `failClosedOnRedisError: true`.
- R-M2-2: `authorizeScim` returns `scimError(503, ...)` on `redisErrored`, `scimError(429, ...)` on `!allowed`, proceeds otherwise. 503 uses the SCIM error envelope (RFC 7644), not the canonical JSON.
- R-M2-3: Preserve the tenant-keyed rate key `rl:scim:${scopeId}`.

### M3 — mint limiters fail-closed
- R-M3-1: `scimTokenCreateLimiter`, operator-token `createTokenLimiter`, `saCreateLimiter` set `failClosedOnRedisError: true` and route through `checkRateLimitOrFail` (emits canonical 429 + 503 + audit).
- R-M3-2: Operator-token `listTokenLimiter` stays fail-open (list is not security-critical).
- R-M3-3: Bump `EXPECTED_LIMITER_COUNT` in `scripts/checks/check-fail-closed-routes-have-test.sh` 58 → 61; each of the 3 route test files gains a `redisErrored` assertion (the guard requires a sibling test referencing `redisErrored`).

### Non-functional
- Reuse `requireRecentCurrentAuthMethod` (M1) and `checkRateLimitOrFail` (M3); no new helpers except the SCIM 503 envelope wiring (M2).

## Contracts

### C1 — step-up on the 6 permanent-purge endpoints — locked
- **Files**: `src/app/api/passwords/empty-trash/route.ts`, `bulk-purge/route.ts`, `src/app/api/teams/[teamId]/passwords/[id]/route.ts` (DELETE permanent branch), `teams/[teamId]/passwords/empty-trash/route.ts`, `bulk-purge/route.ts`, `src/app/api/vault/reset/route.ts`.
- **Approach**: after the auth+permission gate and before any delete, insert `const stepUp = await requireRecentCurrentAuthMethod(req); if (stepUp) return stepUp;`. `req`/`request` is in scope in every handler (verified).
  - **empty-trash / bulk-purge (always permanent)**: insert right after the `auth()`/`requireTeamPermission` gate, before `parseBody`/`withTenantRls`.
  - **vault/reset**: insert after the `auth()` gate and the existing `checkRateLimitOrFail`, before `executeVaultReset`. NOTE: step-up here only checks session recency (≤15min), NOT the passphrase — so it is compatible with the "lost passphrase/recovery key" last-resort purpose (the user still has a recent valid session); it only blocks a stale/leaked cookie.
  - **team single-delete (F2 fix)**: the current handler computes `const permanent = searchParams.get("permanent")==="true"` AFTER the existence check. To mirror the reference handler (`passwords/[id]`) and avoid an existence-oracle before step-up, HOIST the `permanent` computation to just after `requireTeamPermission`, then gate `if (permanent) { const stepUp = await requireRecentCurrentAuthMethod(req); if (stepUp) return stepUp; }` there — before the existence lookup. Do NOT add the reference handler's `auth.type !== "session"` token guard: this DELETE is `auth()`-only, so no token path exists.
- **Invariant** (app-enforced): no permanent-purge of entry rows (trashed OR live) occurs without a recent (≤15min) session. Soft-delete paths are unaffected.
- **Forbidden patterns**:
  - `pattern: deleteMany` reachable before a `requireRecentCurrentAuthMethod` call in each of the 5 handlers — reason: step-up must precede destructive delete
- **Acceptance** (every endpoint, MANDATORY both halves): stale session → 403 (step-up response) **AND the delete mock NOT called** (proves step-up precedes delete — the security-critical ordering); fresh session → 200 + delete called; team soft-delete (no `?permanent`) → unchanged (no step-up); vault/reset stale → 403 AND `executeVaultReset`/its deleteMany NOT called.
- **Consumer-flow walkthrough**: the consumers are the web app's trash/empty-trash, bulk-purge, and vault-reset UI flows. They already handle the single-delete step-up 403 (re-prompt for reauth), so the same 403 envelope on these endpoints is consumed identically. No new response field; the existing `SESSION_STEP_UP_REQUIRED` envelope is reused. (Manual-test: trigger empty-trash with a >15min-old session → expect reauth prompt.)

### C2 — SCIM limiter fail-closed (503) — locked
- **Files**: `src/lib/scim/rate-limit.ts`, `src/lib/scim/with-scim-auth.ts`.
- **Breaking signature change (R3 / F7)**: `checkScimRateLimit` changes return type `Promise<boolean>` → `Promise<RateLimitResult>`. It has exactly ONE production caller, `authorizeScim` (must update the `if (!(await ...))` consumption), and ONE test file `src/lib/scim/rate-limit.test.ts` (2 boolean assertions must become object-form).
- **Approach**: limiter gets `failClosedOnRedisError: true`. `checkScimRateLimit` returns the full `RateLimitResult`. `authorizeScim`: `const rl = await checkScimRateLimit(tenantId); if (rl.redisErrored) { emitRateLimitFailClosed({req, scope:"scim", userId:null, tenantId}); return scimError(503, "Service temporarily unavailable"); } if (!rl.allowed) return scimError(429, "Too many requests");`. The SCIM error envelope (RFC 7644) is preserved for both 503 and 429.
- **Audit (S8 — MANDATORY, not optional)**: fire `emitRateLimitFailClosed({req, scope:"scim", userId:null, tenantId})` on the redisErrored branch for forensic parity with M3 (the "heavy deps" concern is unfounded — the helper is already imported by sibling routes; `tenantId` is in scope so it emits a real audit row, not a dead-letter; scope `"scim"` matches `SCOPE_RE`; the helper's 5-min throttle prevents audit storms). A Redis-outage SCIM 503 on a provisioning/deprovisioning surface is exactly the event that must be queryable, not log-only.
- **Invariant** (app-enforced): a Redis outage makes SCIM return 503, never fall to a per-Pod in-memory limit.
- **Acceptance**: `checkScimRateLimit` mocked `{redisErrored:true}` → `authorizeScim` returns 503 (SCIM envelope `schemas`/`status`/`detail`) AND does NOT proceed to the handler; `{allowed:false}` → 429 (SCIM envelope); `{allowed:true}` → proceeds. `rate-limit.test.ts`: rewrite the 2 boolean assertions to `result.allowed === true/false` AND add a `{redisErrored:true}` case asserting `result.redisErrored === true`.
- **Consumer-flow walkthrough**: consumer = the IdP's SCIM client. It reads HTTP status; 503 (with `Retry-After` semantics) and 429 are both standard SCIM backoff signals. The SCIM error body shape (`schemas`/`status`/`detail`) is preserved for both. No new field.

### C3 — mint limiters fail-closed — locked
- **Files**: `src/app/api/tenant/scim-tokens/route.ts`, `src/app/api/tenant/operator-tokens/route.ts` (create only), `src/app/api/tenant/service-accounts/route.ts`; `scripts/checks/check-fail-closed-routes-have-test.sh`.
- **Approach**: add `failClosedOnRedisError: true` to the 3 create limiters; replace `const rl = await limiter.check(key); if (!rl.allowed) return rateLimited(...)` with `const blocked = await checkRateLimitOrFail({ req, limiter, key, scope, userId: session.user.id, tenantId: actor.tenantId }); if (blocked) return blocked;`. Use `SCOPE_RE`-valid scope strings: `"tenant.scim_token_create"`, `"tenant.operator_token_create"`, `"tenant.service_account_create"`. Leave `listTokenLimiter` (operator-tokens GET) untouched.
- **Per-file `rateLimited` import (F9 — NOT uniform)**:
  - `scim-tokens/route.ts`: `rateLimited` used only by the create path → **remove the import** after the swap.
  - `service-accounts/route.ts`: same → **remove the import**.
  - `operator-tokens/route.ts`: `rateLimited` still used by the list/GET path → **KEEP the import**. `createRateLimiter` import stays in all 3.
- **CI guard (R-M3-3 / T11)**: bump `EXPECTED_LIMITER_COUNT` 58→61 in `check-fail-closed-routes-have-test.sh` AND extend the explanatory comment block (lines ~104-106) to record the +3 from this PR. The callsite floor (`EXPECTED_MIN_CALLSITE_COUNT=50`) is unaffected (swap adds callsites). The SCIM limiter (C2) lives in `src/lib/scim/` and is NOT counted by this guard (scoped to `src/app/api`) — no count change for C2.
- **(C3b — added during implementation, found by a full `rateLimited()` audit)**: `src/app/api/tenant/members/[userId]/reset-vault/route.ts` — the admin-vault-reset TRIGGER limiters (`adminResetLimiter` + `targetResetLimiter`) were fail-open. Admin vault reset is a destructive privileged action (force-resets another member's vault), so both get `failClosedOnRedisError: true`. The handler does a DUAL `Promise.all` check with custom retry-after, so instead of `checkRateLimitOrFail` (single-limiter) it adds an explicit `if (adminResult.redisErrored || targetResult.redisErrored) { emitRateLimitFailClosed(...); return serviceUnavailable(); }` branch before the existing 429 branch. `rateLimited` import stays (used by the 429 branch + the MAX_PENDING_RESETS count guard, which is NOT a Redis limiter and stays as-is). This adds 2 to the limiter count → `EXPECTED_LIMITER_COUNT` 61→63. NOTE: the `operator-tokens/[id]` DELETE revoke limiter is deliberately NOT changed — revoke is fail-safe (over-revoking shrinks attack surface), consistent with the review's "create/mint only" scoping.
- **Invariant** (app-enforced): create/mint of scim-token / operator-token / service-account AND the admin-vault-reset trigger fail closed (503) on Redis error.
- **Forbidden patterns**:
  - `pattern: saCreateLimiter = createRateLimiter\(\{[^}]*\}\)` without `failClosedOnRedisError` — reason: SA create must be fail-closed
- **Acceptance**: per route — limiter mocked `{redisErrored:true}` → 503 **AND the create mock NOT called**; `{allowed:false}` → 429 AND no create; `{allowed:true}` → proceeds. List limiter (operator-tokens GET) unchanged. Tests mock the limiter `.check` (NOT `checkRateLimitOrFail` directly) so the real helper maps results — this keeps existing 429 tests meaningful and lands the literal `redisErrored` token (CI guard requirement) in a LIVE mock value, not a comment. service-accounts has no 429 test today → add both a 429 and a 503 test.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | step-up on 6 permanent-purge endpoints (incl. vault/reset per S1) | locked |
| C2 | SCIM limiter fail-closed (503) + mandatory audit | locked |
| C3 | 3 mint limiters fail-closed + CI count bump | locked |

## Testing strategy

- **C1** (6 endpoints):
  - **MANDATORY mock**: existing test files for empty-trash (personal + team) and team `[id]` DELETE do NOT mock `requireRecentCurrentAuthMethod` today — adding the step-up call makes them run the REAL helper, which reads the session cookie and returns 401/403 in the test env, BREAKING every happy-path 200 test. Each of these 3 files MUST add `vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({ requireRecentCurrentAuthMethod: vi.fn() }))` and set `mockResolvedValue(null)` in `beforeEach` (re-set inside `beforeEach` because some files use `resetAllMocks`). Mirror `scim-tokens/route.test.ts` step-up mock pattern. vault/reset test also needs this mock added. (The "returns undefined and behavior is fine" assumption is WRONG — the real helper does not return undefined.)
  - **Per endpoint**: stale (`requireRecentCurrentAuthMethod → 403`) → assert 403 AND `expect(<deleteMany spy>).not.toHaveBeenCalled()` (vacuous-403 guard, T3/T9); fresh (`→ null`) → assert 200 + delete called. Team soft-delete (no `?permanent`) → unchanged.
  - **New test files**: `passwords/bulk-purge/route.test.ts` and `teams/[teamId]/passwords/bulk-purge/route.test.ts` do not exist — create them.
  - **Fixture refactor (T4)**: team empty-trash test builds its `deleteMany` spy inside the `mockPrismaTransaction` closure (not observable from the test body). Hoist it to a module-level const so the stale-session test can assert `.not.toHaveBeenCalled()`. Mirror personal empty-trash's `mockDeleteMany`.
- **C2** (the ONLY safety net for M2 — SC2: not CI-guarded):
  - `src/lib/scim/rate-limit.test.ts`: rewrite the 2 boolean assertions (`toBe(true)`/`toBe(false)`) to `result.allowed === true/false`; add a `{redisErrored:true}` case asserting `result.redisErrored === true`.
  - `with-scim-auth.test.ts`: change `beforeEach` mock `true` → `{allowed:true}` and the 429 test mock `false` → `{allowed:false}`; ADD a `{redisErrored:true}→503` test asserting `res.response.status===503`, the SCIM envelope body shape, AND that the handler is not reached.
- **C3**: each of the 3 route tests — mock the limiter `.check` (NOT `checkRateLimitOrFail`); add `mockCheck.mockResolvedValueOnce({ allowed:false, redisErrored:true })` → assert 503 AND `expect(<create spy>).not.toHaveBeenCalled()` (the `redisErrored` literal must appear in this LIVE mock — CI guard requirement). service-accounts: add BOTH a 429 test and the 503 test (none exist today). Verify the real `emitRateLimitFailClosed` pulled in by the swap doesn't need new mocks in these files (audit/prisma deps); add mocks if it does.
- Mandatory: `npx vitest run` + `npx next build` + `bash scripts/pre-pr.sh` (the latter validates the bumped `EXPECTED_LIMITER_COUNT`).

## Considerations & constraints

### Scope contract
- **SC1**: list limiters stay fail-open (operator-tokens GET) — only create/mint are security-critical. Owner: this PR's explicit scope.
- **SC2**: M2 SCIM limiter lives in `src/lib/scim/` → NOT counted by the CI guard (which scopes to `src/app/api`); no count bump for M2, and no guard enforcement — coverage relies on `src/lib/scim/*.test.ts` (so C2's tests are the sole safety net — see Testing strategy).
- **SC3**: L1 (orphan blob observability) remains deferred (E2E-encrypted, DB-backend no-op) — unchanged by this PR.
- **SC4 (S1)**: `/api/vault/admin-reset` is deliberately NOT given step-up. Unlike self-reset, it requires a single-use admin-issued token (`token: hexHash` validated against a DB `AdminVaultReset` record) PLUS the target's session + confirmation — the token IS the out-of-band possession proof, and the flow is admin-initiated with its own approval/revoke lifecycle. Self-reset (`/api/vault/reset`) has only session + a fixed public confirmation phrase, so it is the one added to C1. Documented here so the exclusion is auditable rather than silent.
- **SC5 (S7 residual)**: service-account create remains step-up-free (only `auth()` + `SERVICE_ACCOUNT_MANAGE`), unlike scim-token/operator-token create which require step-up. C3 fail-closes its rate limiter (caps mint volume) but does not add step-up parity. Tracked as a possible follow-up; out of scope here.

### Known risks / notes
- **Team permanent single-delete hard-deletes a LIVE entry** (not restricted to trashed rows, unlike the purge endpoints) — so step-up there is especially important; the contract gates it inside `if (permanent)` (hoisted before the existence check per F2).
- M1 changes previously-frictionless flows (empty-trash, vault-reset) to require recent auth. This is the intended security posture (matches single permanent-delete) but is a UX change — surface in the PR body. Web UI already handles the step-up 403 from single-delete, so the consumer path exists.
- **M1 residual (S5)**: step-up checks session *recency* (≤15min), not a fresh credential — a session cookie leaked within 15min of login still passes. This is parity with the already-shipped single permanent-delete; M1 does not regress, but does not make permanent purge "unconditionally safe". State plainly in the PR body.
- M2 makes SCIM depend on Redis for availability during an outage (fail-closed). **Deprovisioning-latency caveat (S6)**: a Redis outage also blocks SCIM `PATCH active=false` (deactivation), so a user who should be locked out stays active until Redis recovers + the IdP retries. Net judgment: fail-closed is still correct (a multi-Pod in-memory fallback does not actually cap; SCIM clients treat 503 as a standard retryable backoff; the uncapped-SCIM-auth-surface-during-outage risk outweighs the transient self-healing deactivation latency). Document this trade-off in the PR body; a future follow-up could fail-open only the `PATCH active=false` path if deployment prioritizes lockout latency.

## User operation scenarios

1. User clicks "empty trash" with a session older than 15 min → 403 step-up prompt → reauth → retry succeeds (was: silent permanent purge).
2. Team admin bulk-purges with a fresh session → succeeds. With a stale session → step-up required.
3. Redis down, IdP SCIM sync → 503 (was: per-Pod in-memory limit, effectively bypassed across Pods).
4. Redis down, tenant admin creates a service account → 503 (was: fail-open mint).
5. Redis healthy, normal operations → unchanged (429 only when actually over-limit).
