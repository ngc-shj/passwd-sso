# Plan: fail-closed-tranche1 — Redis fail-closed contract tests (第1群 high-sensitivity routes)

Parent roadmap: `control-consolidation-roadmap-plan.md` Sec 1 (P1), as amended in
Review Rounds 1–3 (M1, M2, M12, M14, R2-5, R2-6, R2-7, R3-1). This plan implements
the first tranche of the fail-closed test-debt burn-down.
Plan review: `fail-closed-tranche1-review.md` — Round 1 findings T1–T10 reflected below.

## Project context

- Type: `web app` (Next.js 16 App Router) — this tranche touches test code, one
  shared test helper (+ its self-test), one integration test, and
  `scripts/checks/fail-closed-test-debt.txt`.
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest unit lane,
  db-integration lane via `vitest.integration.config.ts`, `scripts/checks/*` gates).
- Verification environment constraints (inherited from parent plan):
  - VC3: Redis-failure fail-closed behavior is testable via mocked limiter in unit
    tests (`verifiable-local`) and via real Redis outage simulation in the
    integration lane (`verifiable-local` with unreachable Redis port;
    `verifiable-CI` in ci-integration).

## Objective

Author the fail-closed contract test for every 第1群 route so that a Redis outage
provably yields the correct 503 envelope (including `Retry-After`), the guarded
mutation provably does not execute, the limiter provably carries
`failClosedOnRedisError: true`, and the production `checkRateLimitOrFail`
mapping stays in the tested path. Remove the covered routes from
`fail-closed-test-debt.txt` atomically.

## Ground truth (verified 2026-07-18; corrected per review T1/T2/T4)

- `RateLimitResult` = `{ allowed: boolean; retryAfterMs?: number; redisErrored?: true }`
  (src/lib/security/rate-limit.ts:28-40). No `success` field.
- `checkRateLimitOrFail` branches `redisErrored` before `allowed`
  (src/lib/security/rate-limit-audit.ts:239-258); envelopes: `"canonical"` →
  `serviceUnavailable()`, `"oauth"` → `oauthTemporarilyUnavailable()`, function →
  custom. BOTH `serviceUnavailable()` (api-response.ts:171-174) and
  `oauthTemporarilyUnavailable()` (:185-192) ALWAYS set `Retry-After`
  (default 30s — `retryAfterMs` is never passed on the redisErrored path).
- All 18 第1群 routes call `checkRateLimitOrFail`; all colocated `route.test.ts`
  files exist and mock `@/lib/security/rate-limit` at the factory level, BUT:
  - Mock shapes vary per file (check-mock variable names differ); only
    `api-keys`, `vault/recovery-key/recover`, `vault/admin-reset` currently wrap
    the factory in a spyable `vi.fn()` — the rest use plain arrow functions and
    will be refactored to a recording `vi.fn()` (C2, mechanical).
  - THREE files currently stub `@/lib/security/rate-limit-audit` (the C4
    anti-pattern) and MUST be un-mocked as part of C2 (T1):
    `tenant/access-requests/[id]/approve/route.test.ts:104`,
    `tenant/access-requests/[id]/deny/route.test.ts:70`,
    `extension/token/route.test.ts:92`.
  - `mcp/token/route.test.ts` currently backs BOTH limiter instances with one
    shared check mock. The T4 refactor SPLITS them (R3 finding): factory becomes
    `vi.fn().mockReturnValueOnce({ check: mockTokenLimiterCheck, clear: vi.fn() })
    .mockReturnValueOnce({ check: mockIpLimiterCheck, clear: vi.fn() })` —
    creation order in the route is tokenRateLimiter (:33) THEN ipRateLimiter
    (:38), so the first factory result is the token limiter. With distinct
    check mocks, no same-invocation sequencing is needed (cases B/C arrange the
    sibling ip check `{ allowed: true }` and let the helper arrange the limiter
    under test). Existing cases in the file that relied on the shared mock are
    updated in the same sub-task (deviation-logged).
- Gate: `scripts/checks/check-fail-closed-routes-have-test.sh` requires the
  literal `redisErrored` in the ADJACENT test file's own source (helper imports
  do NOT satisfy it) OR a debt-file entry; also enforces
  `EXPECTED_LIMITER_COUNT=69` and a `checkRateLimitOrFail(` callsite floor.
- Debt file: 42 `src/` entries (recounted raw; a filtered count of 41 was
  rejected in review).

### Member-set derivation (R42; adjudicated per review T3)

Class = 第1群. The parent roadmap's Sec 1 narrative names token mint/refresh,
passkey verify/reauth, extension exchange, **Vault setup/unlock/reset/recovery**,
access request approve/deny as the high-sensitivity set; review T3 adjudicated
`vault/unlock`, `vault/setup`, `webauthn/authenticate/verify` (raw WebAuthn
assertion-verify = "passkey verify" class) INTO the tranche.
Derived from `scripts/checks/fail-closed-test-debt.txt` ∩ family definition,
recomputed via `grep -c 'failClosedOnRedisError: true' <route>`:

**18 route files / 20 limiter instances / 21 test cases** (case = limiter
instance, plus one extra case per mutually-exclusive branch that re-invokes the
same limiter instance — only mcp/token qualifies):

| # | Route file | Limiters | Cases | Envelope |
|---|-----------|----------|-------|----------|
| 1 | src/app/api/api-keys/route.ts | 1 | 1 | canonical |
| 2 | src/app/api/auth/passkey/verify/route.ts | 1 | 1 | canonical |
| 3 | src/app/api/auth/passkey/reauth/verify/route.ts | 1 | 1 | canonical |
| 4 | src/app/api/extension/token/route.ts | 1 | 1 | canonical |
| 5 | src/app/api/extension/token/refresh/route.ts | 1 | 1 | canonical |
| 6 | src/app/api/extension/token/exchange/route.ts | 1 | 1 | canonical |
| 7 | src/app/api/mobile/token/route.ts | 1 | 1 | canonical |
| 8 | src/app/api/mobile/token/refresh/route.ts | 1 | 1 | canonical |
| 9 | src/app/api/mcp/token/route.ts | 2 | 3 | oauth |
| 10 | src/app/api/vault/recovery-key/recover/route.ts | 2 | 2 | canonical |
| 11 | src/app/api/vault/recovery-key/generate/route.ts | 1 | 1 | canonical |
| 12 | src/app/api/vault/reset/route.ts | 1 | 1 | canonical |
| 13 | src/app/api/vault/admin-reset/route.ts | 1 | 1 | canonical |
| 14 | src/app/api/tenant/access-requests/[id]/approve/route.ts | 1 | 1 | canonical |
| 15 | src/app/api/tenant/access-requests/[id]/deny/route.ts | 1 | 1 | canonical |
| 16 | src/app/api/vault/unlock/route.ts | 1 | 1 | canonical |
| 17 | src/app/api/vault/setup/route.ts | 1 | 1 | canonical |
| 18 | src/app/api/webauthn/authenticate/verify/route.ts | 1 | 1 | canonical |

mcp/token case map (3 `checkRateLimitOrFail(` callsites at route.ts:68/:122/:237):
- Case A: ip limiter errors (callsite :68).
- Case B: ip allows → token limiter errors in `authorization_code` branch (:122).
- Case C: ip allows → token limiter errors in `refresh_token` branch (:237).

vault/recovery-key/recover: 2 limiter instances in mutually exclusive
`step: "verify"` / `"reset"` branches — 2 independent single-invoke cases, no
sequencing needed.

Not in 第1群 (remain in debt file — tranche 2+): passkey/options(/email),
passkey/reauth/options, webauthn register/* + authenticate/options +
credentials/[id]/prf(/options), mcp/register, mcp/revoke, share-links/*,
teams/invitations/accept, emergency-access/accept, vault
unlock/data + change-passphrase + rotate-key(/data) + delegation(/check),
extension/bridge-code, extension/key/reset, tenant/access-requests (list/create),
reset-vault/[resetId]/approve.

### Per-route mutation-primitive table (R2-7)

The `assertNoMutation` spy set per route. Spies bind to the module mocks already
present in each colocated test; "(svc)" = service-function mock:

| Route | Mutation spies (assert `.not.toHaveBeenCalled()`) |
|-------|---------------------------------------------------|
| api-keys | `apiKey.create` |
| auth/passkey/verify | `session.create`, `session.deleteMany` |
| auth/passkey/reauth/verify | `session.update` |
| extension/token | `extensionToken.update` |
| extension/token/refresh | `extensionToken.updateMany`, `extensionToken.create` |
| extension/token/exchange | `extensionBridgeCode.updateMany` |
| mobile/token | `mobileBridgeCode.updateMany` |
| mobile/token/refresh | token-rotation write primitive per existing test mocks (svc) |
| mcp/token | `exchangeCodeForToken`, `exchangeRefreshToken` (svc) |
| vault/recovery-key/recover | `user.update` |
| vault/recovery-key/generate | `user.update` |
| vault/reset | `executeVaultReset`, `invalidateUserSessions` (svc) |
| vault/admin-reset | `adminVaultReset.updateMany` |
| access-requests/[id]/approve | `serviceAccountToken.create`, `accessRequest.update` |
| access-requests/[id]/deny | `transition` (svc) |
| vault/unlock | `user.updateMany`, `recordFailure`, `resetLockout` (svc) |
| vault/setup | `user.update`, `vaultKey.create` |
| webauthn/authenticate/verify | assertion-verify/session write primitive per existing test mocks (svc) |

Where a route's `$transaction` wraps the writes, the spy targets the mocked model
methods invoked inside the transaction callback.

## Contracts

### C1 — Shared contract-test helper `assertRedisFailClosed`

- File: `src/__tests__/helpers/fail-closed.ts` (new)
- Signature:

```ts
import type { Mock } from "vitest";

export type FailClosedExpectation =
  | { envelope: "canonical" }   // 503, body { error: "SERVICE_UNAVAILABLE" }, Retry-After present
  | { envelope: "oauth" }       // 503, body { error: "temporarily_unavailable" }, no error_description key, Retry-After present
  | { envelope: "custom"; status: number; body: Record<string, unknown> };

export async function assertRedisFailClosed(options: {
  /** Executes the route handler and returns its Response. Any thunk. */
  invoke: () => Promise<Response>;
  /** The mocked limiter under test — MUST be the factory result object itself; the helper arranges its check() and asserts it reached. */
  limiter: { check: Mock };
  expectation: FailClosedExpectation;
  /** Write-primitive spies; each asserted .not.toHaveBeenCalled(). Must be non-empty. */
  assertNoMutation: readonly Mock[];
  /**
   * Recorded createRateLimiter factory mock (vi.fn wrapping the factory in the
   * test file's vi.mock). MANDATORY. Attribution (R2/R3 security findings):
   * the helper locates the recorded factory call whose RETURN VALUE is
   * options.limiter (strict identity via mock.results — no .check-equality
   * fallback) and asserts THAT call's options had failClosedOnRedisError:
   * true — an existential any-call check would let a sibling limiter in a
   * multi-limiter file (mcp/token, recovery-key/recover) mask a silent opt-in
   * removal on the limiter under test (parent M2 blind spot). Callers pass
   * the factory result object itself as options.limiter.
   */
  limiterFactory: Mock;
  /**
   * The redisErrored fixture the limiter's check() resolves to. REQUIRED
   * (Phase 3 review F1): callers pass the literal (e.g.
   * `{ allowed: false, redisErrored: true }`) inline at each callsite so the
   * gate-satisfying literal is type-checked CODE, not a comment that could
   * rot independently of the gate's grep.
   */
  failure: RateLimitResult & { redisErrored: true };
}): Promise<void>;
```

- Behavior (in order):
  1. Arrange: `options.limiter.check.mockResolvedValue(options.failure)` — limiter-layer mock, touching ONLY the limiter under test; sibling limiters in multi-limiter routes are arranged by the caller (e.g. `{ allowed: true }`) before invoking the helper. `checkRateLimitOrFail` itself stays production code (RT5).
  2. Act: `const res = await options.invoke()`.
  3. Assert limiter reached: `expect(options.limiter.check).toHaveBeenCalled()`.
  4. Assert envelope: canonical → status 503 ∧ body `{ error: "SERVICE_UNAVAILABLE" }` ∧ `Retry-After` header present; oauth → status 503 ∧ `body.error === "temporarily_unavailable"` ∧ `"error_description" not in body` ∧ `Retry-After` header present; custom → exact status/body match.
  5. Assert no mutation: `assertNoMutation` must be non-empty (throw otherwise) and every spy `.not.toHaveBeenCalled()`.
  6. Assert factory options (attributed, identity-only): find the `limiterFactory` recorded call whose `mock.results[i].value` IS `options.limiter` (strict identity — no `.check`-equality fallback; a fallback is ambiguous when limiters share a check mock, R3 finding); throw with a clear message ("limiter not produced by limiterFactory — pass the factory result object itself") if none found; assert that call's first arg has `failClosedOnRedisError: true`.
- Invariants (app-enforced): helper throws on empty `assertNoMutation`; helper never mocks `@/lib/security/rate-limit-audit`.
- Consumer-flow walkthrough:
  - Consumers = the 18 colocated `route.test.ts` files (C2). Each supplies
    `invoke` (its existing request construction — request-builder or local
    helper, any thunk), `limiter` (its existing check mock), `expectation`
    (per member-set table), `assertNoMutation` (per mutation table),
    `limiterFactory` (its factory mock, refactored to a recording `vi.fn()`
    where currently a plain arrow — 15 of 18 files).
  - Gate `check-fail-closed-routes-have-test.sh` greps the literal
    `redisErrored` in the ADJACENT test file's own source. The operative
    mechanism is the required `failure` fixture literal at each callsite
    (`failure: { allowed: false, redisErrored: true }`, passed inline to
    `assertRedisFailClosed` — a required, type-checked parameter, not a
    comment). The helper file's own literal does NOT satisfy the gate for
    any route.

### C2 — Per-case fail-closed tests (21 cases across 18 files)

- Every case in the member-set table gets one test in the route's colocated
  `route.test.ts`, calling `assertRedisFailClosed`.
- Sub-task (T1): `approve`, `deny`, `extension/token` tests first REMOVE their
  `vi.mock("@/lib/security/rate-limit-audit", ...)` and restructure existing
  assertions so production `checkRateLimitOrFail` runs (limiter-layer mocks
  only). Recorded per-file in the deviation log.
- Sub-task (T4): refactor factory mocks to recording `vi.fn((opts) => mock)`
  in the 15 files lacking one. mcp/token carve-out (R3): split the shared
  check mock into `mockTokenLimiterCheck`/`mockIpLimiterCheck` via
  `mockReturnValueOnce` chain in route-creation order (token :33, ip :38);
  update existing cases in the file that relied on the shared mock.
- mcp/token: cases A/B/C per the case map; B/C arrange the sibling ip check
  `{ allowed: true }`, helper arranges the limiter under test — no
  same-invocation sequencing needed with distinct check mocks.
- Each test file contains the literal token `redisErrored` in its own source
  (gate compatibility) — via the fixture literal; NOT via describe-label
  strings alone.
- Acceptance criteria: `npx vitest run` green; each new test FAILS if
  (a) the route's 503 envelope changes family or loses `Retry-After`,
  (b) the mutation executes before the limiter check,
  (c) `failClosedOnRedisError` is removed from the limiter options,
  (d) the file re-introduces a rate-limit-audit stub (C4 grep).
- Test names: `"fails closed (503, no mutation) when Redis is unavailable"`
  (suffix ` — <scope/branch>` for multi-case files).

### C3 — Debt-file burn-down (atomic)

- Remove exactly the 18 member-set entries from
  `scripts/checks/fail-closed-test-debt.txt` in the same PR that adds the tests.
- Acceptance: `bash scripts/checks/check-fail-closed-routes-have-test.sh` passes;
  debt file count 42 → 24; `EXPECTED_LIMITER_COUNT` unchanged (69).

### C4 — Anti-pattern prohibition (new/modified tests)

- Forbidden patterns (grep over the diff; match set MUST be empty):
  - pattern: `vi\.mock\("@/lib/security/rate-limit-audit"` in the 18 C2 test
    files — reason: return-value-stub anti-pattern takes the production
    `redisErrored→503` mapping out of the tested path (RT5; roadmap R2-6/R3-1).
    (The three pre-existing instances are REMOVED by C2's T1 sub-task; the
    grep enforces they do not return.)
  - pattern: `checkRateLimitOrFail\s*:\s*vi\.fn` in the C2 diff — reason: same
    anti-pattern via inline factory.
  - pattern: `success:\s*(true|false)` in fail-closed fixtures — reason: the
    field does not exist on `RateLimitResult` (M12).
- Out of scope (SC1): `src/__tests__/api/mcp/authorize.test.ts`,
  `src/__tests__/api/extension/token-exchange-dpop.test.ts:48`,
  `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts:53` — pre-existing
  central-tree stubs; they carry non-rate-limit concerns (DPoP/cnf-jkt) and the
  colocated tests own the fail-closed contract.

### C5 — Integration proof of the production chain (real broken Redis)

- File: `src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts` (new)
- Proves with NO limiter mocks: `createRateLimiter({ failClosedOnRedisError: true, ... })`
  against an unreachable Redis (env-pointed at a closed port) returns
  `{ allowed: false, redisErrored: true }`, and production
  `checkRateLimitOrFail` maps it to the canonical and oauth 503 envelopes
  (incl. `Retry-After`).
- Red-proof (RT7): sibling assertion that the same limiter WITHOUT
  `failClosedOnRedisError` falls back open (`allowed: true`, no `redisErrored`)
  — proves the test discriminates on the option.
- Redis client note (T8): `getRedis()` uses ioredis `lazyConnect` with swallowed
  connection errors; first `pipeline.exec()` against a closed port may wait on
  retry backoff. The test may set a short `maxRetriesPerRequest`/connect-timeout
  via the test-scoped Redis URL/env; the lane's 30s `testTimeout` is headroom,
  not the target.
- Scope note (deviation from parent M2 wording "≥1 per 第1群 route family"):
  route-handler-level integration invocation requires per-route session/DB
  fixtures in the integration lane; this tranche proves the shared production
  chain (limiter → checkRateLimitOrFail → envelope) end-to-end against real
  Redis failure, while per-route wiring is covered by C2 with the production
  mapping in path. Recorded in the deviation log; per-family route-level
  integration may be promoted to tranche 2.

### C6 — Helper self-test (red-proof for the helper itself)

- File: `src/__tests__/helpers/fail-closed.test.ts` (new)
- Cases: (1) passing invocation against a minimal fake route (limiter-blocked,
  correct envelope, no mutation) succeeds; deliberately-broken invocations
  each REJECT: (2) handler returns 500/wrong body, (3) a mutation spy was
  called, (4) empty `assertNoMutation` array, (5) the factory call that
  produced the limiter under test lacks `failClosedOnRedisError: true`
  (including the sibling-masking shape: a DIFFERENT factory call has the flag —
  attribution must still reject), (6) limiter never reached — the limiter
  under test IS registered with the factory (the standard beforeEach pair),
  but `invoke` returns a fully-correct canonical 503 (right body + numeric
  Retry-After) WITHOUT ever calling `limiter.check`, isolating step 3's
  `expect(limiter.check).toHaveBeenCalled()` as the only failing axis (Phase 3
  review F2 — the prior version used an unregistered ad-hoc limiter, which
  left the case unable to distinguish "never reached" from "not attributed to
  the factory"), (7) correct status/body but `Retry-After` header absent or
  non-numeric — helper rejects (Retry-After red-proof axis).
- Rationale (T6): 21 cases depend on this single helper; a helper bug must not
  vacuously green the tranche.

## Testing strategy

- `npx vitest run` (21 new cases + C6 self-test + existing suites).
- `npm run test:integration` with local Postgres+Redis (C5; file lands under
  `db-integration/` with the `*.integration.test.ts` suffix per roadmap M10).
- `bash scripts/checks/check-fail-closed-routes-have-test.sh` (C3).
- `npx next build` (mandatory check).
- `scripts/pre-pr.sh` before PR.

## Considerations & constraints

### Scope contract

- SC1: stub-pattern migration + structural gate detection of
  `vi.mock(".../rate-limit-audit")` for the CENTRAL trees
  (`mcp/authorize.test.ts`, `extension/token-exchange-dpop.test.ts`,
  `extension/token-refresh-cnfJkt.test.ts`) — owner: roadmap Sec 1 follow-up
  (R3-1). Colocated-tree instances are NOT deferred (C2/T1 removes them).
- SC2: manifest pinning of the fail-closed class, gate scan-root extension
  (src/lib + src/auth.config.ts), silent-drop helper variant
  (magicLinkEmailLimiter), migration policy for already-tested routes —
  owner: roadmap Sec 1 tranche 2 (M2 actions 1/4/5).
- SC3: per-route-family route-handler-level integration tests against real
  broken Redis — owner: tranche 2 (see C5 scope note).
- SC4: remaining 24 debt routes (第2群) — owner: tranche 2/3.

### Risks

- Un-mocking rate-limit-audit in the 3 T1 files may surface hidden coupling
  (existing cases relying on the stub's `null` return); restructure with
  limiter-layer mocks and record per-file deviations.
- `emitRateLimitFailClosed` fires `void` async audit work inside the 503 path;
  colocated tests must have logger/audit mocks in place (all 18 mock logger;
  emission is throttled and error-swallowed). Verify no unhandled rejections on
  the first converted file before fanning out.

## User operation scenarios

- Operator during a Redis outage: any 第1群 endpoint returns 503 with the
  documented envelope + `Retry-After`; no token minted, no vault state mutated,
  no access request transitioned; audit row `RATE_LIMIT_FAIL_CLOSED`
  (post-auth) or warn log (pre-auth) emitted.

## Go/No-Go Gate

| ID  | Subject                                              | Status |
|-----|------------------------------------------------------|--------|
| C1  | Shared helper assertRedisFailClosed (Retry-After, identity-attributed mandatory factory) | locked |
| C2  | 21 per-case fail-closed tests (incl. T1 un-mock + T4 factory refactor sub-tasks) | locked |
| C3  | Debt-file burn-down (18 entries, atomic, 42→24)      | locked |
| C4  | Anti-pattern forbidden patterns                      | locked |
| C5  | Integration proof vs real broken Redis + red-proof   | locked |
| C6  | Helper self-test (red-proof for the helper)          | locked |
