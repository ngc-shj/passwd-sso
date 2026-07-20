# Plan: fail-closed-sc-t3-remaining

Date: 2026-07-20
Branch: `feature/fail-closed-sc-t3-remaining` (from `main`)
Predecessor: fail-closed tranche 3 (PR #682, `feature/fail-closed-tranche3`, OPEN at plan time)

## Project context

- Type: web app (Next.js 16 App Router + TypeScript 5.9 + Prisma 7 + PostgreSQL 16 + Redis 7)
- Test infrastructure: unit (vitest) + integration (real DB/Redis, `npm run test:integration`) + E2E + CI/CD
- Verification environment constraints:
  - **VE1**: `db-integration` tests require a running Postgres (`DATABASE_URL`/`MIGRATION_DATABASE_URL`). Available locally (docker compose dev stack) and in CI (`ci-integration.yml` postgres service). → `verifiable-local` / `verifiable-CI`.
  - **VE2**: Redis-dependent integration cases (`redisAvailable = !!process.env.REDIS_URL`) require a reachable Redis. Available locally (docker compose `redis`) and in CI (`ci-integration.yml` redis service, `REDIS_URL=redis://localhost:6379`, ci-integration.yml:66-78). → `verifiable-local` / `verifiable-CI`.
  - **VE3**: SCIM Retry-After behavior against a real IdP (Okta/Entra provisioning client) is not exercisable locally. Manual-test path is `blocked-deferred`; cost-justification: the change is a purely additive response header whose consumer contract is defined by RFC 9110 generic HTTP semantics, fully verifiable by unit assertion on the response object. Real-IdP validation deferred to operator acceptance in a staging tenant (same posture as tranche 2's SCIM 503 introduction, which shipped without IdP-in-the-loop testing).
  - No path in this plan is blocked by paid tiers, hardware, or multi-account setups.

## Objective

Close the four remaining SC-T3 backlog items from the fail-closed initiative
(tranche 3 scope contract), in approved order SC-T3-3 → SC-T3-2 → SC-T3-5 →
SC-T3-4:

1. **SC-T3-3** (test-only): migrate the 3 remaining hand-rolled v1/passwords
   fail-closed test cases to the shared `assertRedisFailClosed` helper tier.
2. **SC-T3-2** (production): add `Retry-After` to the SCIM fail-closed 503,
   closing the last member of the "every fail-closed 503 carries Retry-After"
   invariant.
3. **SC-T3-5** (production, observability-only): split the magic-link limiter's
   Redis-outage log channel from its over-limit channel, preserving the
   silent-drop contract.
4. **SC-T3-4** (test-only, new infra): prove the verify-access `tokenLimiter`
   fail-closed path at the route-integration tier via a selective-failure Redis
   wrapper (IP key succeeds, token key fails).

User decisions already taken (2026-07-20): independent branch from `main`
(zero file overlap with PR #682, verified by `git diff main...feature/fail-closed-tranche3 --name-only`);
ONE PR for all four items with per-item commits; SC-T3-4 is implemented, not
deferred.

## Requirements

Functional:
- SCIM 503 (Redis outage) response carries `Retry-After: <delay-seconds>` with
  the shared 30 s default. Body shape unchanged.
- Magic-link `sendVerificationRequest` distinguishes Redis outage from
  over-limit in logs only; externally observable behavior (silent drop, no
  email, no throw) unchanged.

Non-functional:
- No behavior change for any other route or envelope.
- Test-tier upgrades must keep `scripts/checks/check-fail-closed-routes-have-test.sh` green with **no manifest edits** (v1 routes are not gate members; the `v1ApiKeyLimiter` class member is `src/lib/security/rate-limiters.ts`, already helper-mode via `assertRedisFailClosedResult`).
- Mandatory checks before completion: `npx vitest run`, `npx next build`
  (production code changes in C2/C3), `npm run test:integration` (C4),
  `scripts/pre-pr.sh` before push.

## Technical approach

No new dependencies, no schema changes, no migrations, no concurrency-control
primitives (plan-stage real-DB concurrency probe: N/A — nothing in this plan
depends on isolation levels or locks).

All four items ride existing primitives:
- C1 reuses `assertRedisFailClosed` + `snapshotFactory`
  (`src/__tests__/helpers/fail-closed.ts`) exactly as the 13 routes migrated in
  PR #682.
- C2 extends `scimError` (additive optional param) and reuses the existing
  `retryAfterSecondsOrDefault` logic from `src/lib/http/api-response.ts`
  (currently module-private; exported by this change) so the 30 s default has a
  single owner (R1/R2).
- C3 is a two-line branch in `src/auth.config.ts` plus test updates.
- C4 extends the existing switchable-`getRedis` integration harness
  (`src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts:71-79`)
  with a key-predicate routing wrapper.

### External spec citations (R29 — verified verbatim 2026-07-20 against rfc-editor.org)

- RFC 7644 §3.12 "HTTP Status and Error Response Handling" defines the SCIM
  error envelope (`urn:ietf:params:scim:api:messages:2.0:Error`; `status`
  REQUIRED as JSON string, `scimType` OPTIONAL, `detail` OPTIONAL). It contains
  **zero** mentions of `Retry-After` or status 503 (verified:
  `grep -c "Retry-After" rfc7644.txt` → 0; `grep -c "503" rfc7644.txt` → 0).
  **Therefore this plan does NOT claim SCIM requires Retry-After.**
- RFC 9110 §15.6.4 "503 Service Unavailable": "The server MAY send a
  Retry-After header field (Section 10.2.3) to suggest an appropriate amount of
  time for the client to wait before retrying the request." (verbatim).
- RFC 9110 §10.2.3 "Retry-After": "When sent with a 503 (Service Unavailable)
  response, Retry-After indicates how long the service is expected to be
  unavailable to the client." (verbatim). `delay-seconds = 1*DIGIT`,
  a non-negative decimal integer.
- The change's real justification is **internal invariant consistency**: this
  repo's own contract "503 envelopes ALWAYS set Retry-After (operator playbook
  requires a back-off hint on service-unavailable)"
  (src/lib/http/api-response.ts:154-156). SCIM is the last fail-closed 503
  producer without it (member-set below). RFC 9110's MAY permits it; nothing
  forbids it; the SCIM error body is untouched so RFC 7644 §3.12 conformance is
  unaffected.

## Contracts

### C1 — SC-T3-3: v1/passwords fail-closed tests → helper mode (test-only)

Files:
- `src/app/api/v1/passwords/route.test.ts` — 2 cases (GET at :138, POST at :368)
- `src/app/api/v1/passwords/[id]/route.test.ts` — 1 case (GET at :167)

Signatures (test-file internal):
- Replace plain-arrow factory mock
  `vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: () => ({ check: mockCheck }) }))`
  with a recording factory: `mockCreateRateLimiter: Mock` created inside the
  existing `vi.hoisted` block and wired as
  `vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: mockCreateRateLimiter }))`.
- Module scope, immediately after the route import:
  `const limiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);`
  and resolve the limiter under test **by factory-args match, not bare index**:
  find the `mock.calls` entry whose options equal `v1ApiKeyLimiter`'s
  (`windowMs: RATE_WINDOW_MS, max: 100, failClosedOnRedisError: true`,
  src/lib/security/rate-limiters.ts:16-20) and take the corresponding
  `mock.results[i].value`. Rationale: the route's import graph constructs
  multiple limiters through the same mocked factory (`migrateLimiter` et al.);
  a positional index is fragile against import-graph drift.
- Each of the 3 cases becomes an `assertRedisFailClosed` call:
  - `expectation: { envelope: "canonical" }` (route consumes the limiter via
    production `checkRateLimitOrFail` → `serviceUnavailable()`; the helper adds
    the Retry-After delay-seconds assertion the manual cases lacked).
  - `assertNoMutation`: GET list → `[mockEntryFindMany]`; POST create →
    `[mockEntryCreate]`; [id] GET → the entry-read spy used by the current
    manual case (`mockEntryFindUnique` — [id]/route.test.ts:8,44, backing
    `prisma.passwordEntry.findUnique`; the existing case at :167-177 already
    asserts it).
    `mockLogAudit` is NOT included (M9: the 503 path itself calls
    `logAuditAsync` via `emitRateLimitFailClosed`).
  - `failure: { allowed: false, redisErrored: true }` inline literal.
  - `limiterFactory: limiterFactorySnapshot.replay()`.

Invariants:
- App-enforced: no manual 503-envelope assertion remains in the 3 cases; the
  shared helper is the single contract surface. (Schema-enforced equivalent:
  none — this is a test-code pattern; the gate script is the closest
  machine-enforcement and stays green unchanged.)
- `vi.hoisted` TDZ trap (tranche-3 lesson): inside the hoisted callback, bind
  `const check = vi.fn()` first, then return
  `{ mockCheck: check, mockCreateRateLimiter: vi.fn(() => ({ check })) }` —
  the returned object must not reference its own properties.

Forbidden patterns:
- pattern: `createRateLimiter: \(\) => \(` in the two files — reason: plain-arrow factory defeats `assertRedisFailClosed` attribution.
- pattern: `toEqual\(\{ error: "SERVICE_UNAVAILABLE" \}\)` inside the 3 migrated cases — reason: manual envelope assertion must be replaced by the helper, not duplicated beside it.

Acceptance criteria:
- 3 cases invoke `assertRedisFailClosed`; all previously asserted behavior
  (503, envelope, no-DB-access) still asserted, plus Retry-After and
  factory-attributed `failClosedOnRedisError: true`.
- `npx vitest run src/app/api/v1/passwords` green; full suite green;
  `bash scripts/checks/check-fail-closed-routes-have-test.sh` green with zero
  manifest diffs.

Consumer-flow walkthrough: N/A — no producer shape changes; test-only.

### C2 — SC-T3-2: SCIM fail-closed 503 carries Retry-After (production)

Signatures:
- `src/lib/http/api-response.ts`: `export function retryAfterSecondsOrDefault(retryAfterMs?: number): string` — existing implementation, visibility change only (module-private → exported).
- `src/lib/scim/response.ts`:
  `export function scimError(status: number, detail: string, scimType?: string, headers?: Record<string, string>): NextResponse`
  — additive optional 4th param merged into the response headers after the
  Content-Type default (caller headers must not be able to override
  `Content-Type: application/scim+json`; spread order: `{ "Content-Type": SCIM_CONTENT_TYPE, ...headers }` is FORBIDDEN — use `{ ...headers, "Content-Type": SCIM_CONTENT_TYPE }`).
- `src/lib/scim/with-scim-auth.ts:34`:
  `scimError(503, "Service temporarily unavailable", undefined, { "Retry-After": retryAfterSecondsOrDefault() })`.

Invariants (universally quantified → R42 member-set, code-derived 2026-07-20):
- **INV-C2: every fail-closed (redisErrored → 503) response producer sets `Retry-After`.**
  Defining primitive: the 503 branch of `checkRateLimitOrFail`
  (`rl.redisErrored` → envelope, src/lib/security/rate-limit-audit.ts:239-250)
  plus direct `scimError(503, ...)` on the `rl.redisErrored` branch in
  `authorizeScim`. Derivation commands:
  `grep -rn 'envelope:' src --include='*.ts' | grep -v test` (custom/oauth
  envelope callers) + `grep -n 'serviceUnavailable\|oauthTemporarilyUnavailable' src/lib/http/api-response.ts`
  + `grep -n 'scimError(503' src/lib/scim/with-scim-auth.ts`.
  Member-set (5, verified in source):
  1. `serviceUnavailable()` canonical — Retry-After ✔ (api-response.ts:171-174)
  2. `oauthTemporarilyUnavailable()` — Retry-After ✔ (api-response.ts:185-190)
  3. `vault/delegation/check` custom envelope — `Retry-After: "30"` ✔ (route.ts:75-79)
  4. `vault/ssh/sign-authorize` custom envelope — `Retry-After: "30"` ✔ (route.ts:87-91)
  5. `scimError(503, ...)` in `authorizeScim` — ✘ → **closed by this contract**.
  Indirect members check: no raw `NextResponse.json(..., { status: 503 })` on a
  `redisErrored` branch outside these five (`grep -rn 'redisErrored' src --include='*.ts' | grep -v test` reviewed; all 503 emissions route through the five producers).
  App-enforced; additionally test-enforced by `FailClosedExpectation.retryAfter`
  being a required explicit field for custom envelopes (helper design), so a
  future custom-envelope consumer must decide rather than silently skip.
- The SCIM 503 **body** is byte-identical before/after (RFC 7644 §3.12 envelope
  untouched); only a header is added.
- `Content-Type: application/scim+json` unoverridable by the new headers param.

Forbidden patterns:
- pattern: `"Retry-After": "30"` in `src/lib/scim/` — reason: the default must come from `retryAfterSecondsOrDefault()` (single owner), not a new magic literal.
- pattern: `retryAfter: "forbidden"` in `src/lib/scim/with-scim-auth.test.ts` — reason: the expectation must flip to `"required"`; leaving `"forbidden"` means the test contradicts the contract.

Acceptance criteria:
- `authorizeScim` Redis-outage response: status 503, SCIM error body unchanged,
  `Retry-After` matches `/^\d+$/` and > 0 (default 30).
- `with-scim-auth.test.ts` fail-closed case passes with
  `retryAfter: "required"`.
- `response.test.ts` gains coverage for the `headers` param: (a) headers are
  emitted, (b) `Content-Type` cannot be overridden (RT6/RT7 — prove the new
  parameter can fail: a deliberately wrong-order implementation fails (b)).
- All existing `scimError` call sites compile and behave unchanged, verified
  by `npx next build` plus a call-site grep audit (`grep -rn 'scimError(' src`)
  — no hardcoded count; independent review greps produced 41-43 depending on
  methodology, so the number is deliberately not part of the criterion.

Consumer-flow walkthrough (response shape consumed outside the producer):
- Consumer 1 — the 7 SCIM route handlers (`src/app/api/scim/v2/**`): read
  `auth.ok`; when false, return `auth.response` verbatim. They read no fields
  of the response object itself → header addition is pass-through safe.
- Consumer 2 — IdP SCIM clients (Okta/Entra provisioning engines): read HTTP
  `status` (503 → retry later) and, per RFC 9110 generic semantics, MAY read
  `Retry-After` for back-off pacing. Body fields (`schemas`, `status`,
  `detail`) unchanged; no field the consumer needs is removed.
- Consumer 3 — `with-scim-auth.test.ts` + `response.test.ts`: assert the
  envelope; updated in this change as listed above.

### C3 — SC-T3-5: magic-link Redis-outage log channel split (production, observability-only)

Signatures:
- `src/auth.config.ts` `sendVerificationRequest` (currently :113-121): insert a
  `redisErrored` branch BEFORE the `!rl.allowed` branch:
  - outage: `getLogger().error("magic-link.rate-limit.fail_closed"); return;`
  - over-limit (unchanged): `getLogger().warn("magic-link.rate-limited"); return;`
- No new exports; no signature changes.

Invariants:
- **Silent-drop contract preserved on BOTH branches**: no throw, no email
  (`sendEmail` not called), function resolves `undefined` — anti-enumeration
  behavior is externally indistinguishable between outage, over-limit, and
  (from the requester's view) success.
- **No PII in the new log call**: message string only, no structured fields —
  the email address must not appear (logging rule: never log emails; precedent:
  `rate-limit.fail_closed.pre_auth_skip` logs only scope + ipBucket).
- Channel naming: `magic-link.rate-limit.fail_closed` — `error` level because a
  Redis outage is operator-actionable, unlike the expected-noise `warn` on
  over-limit. (`emitRateLimitFailClosed` is NOT used here: it requires a
  `NextRequest`, which `sendVerificationRequest` does not receive.)

Forbidden patterns:
- pattern: `identifier` or `email` as an argument to the new `getLogger().error(` call in auth.config.ts — reason: PII in logs.
- pattern: `throw` inside the `redisErrored` branch — reason: silent-drop contract.

Acceptance criteria:
- Updated C8a test (`src/auth.config.test.ts:316`): redisErrored →
  `assertRedisFailClosedSilentDrop` still passes AND
  `mockError` called with `"magic-link.rate-limit.fail_closed"` AND `mockWarn`
  NOT called with `"magic-link.rate-limited"`.
- New sibling over-limit case: `{ allowed: false }` (no `redisErrored`) →
  `mockWarn` called with `"magic-link.rate-limited"`, `mockError` not called
  with the outage channel, `sendEmail` not called (RT8: assert the mutation
  spy, not just the log).
- `npx next build` green.

Consumer-flow walkthrough: N/A — no shape consumed by code; log lines are
consumed by operators (channel names documented in the commit message).

### C4 — SC-T3-4: verify-access tokenLimiter route-integration proof (test-only, new infra)

File: `src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts`

Signatures (test-file internal):
- `function createSelectiveRedis(broken: IORedis, real: IORedis, failKeyPredicate: (key: string) => boolean): IORedis`
  — returns an object (cast `as unknown as IORedis`) implementing exactly the
  surface `createRateLimiter` uses (rate-limit.ts:54-99):
  - `pipeline()`: returns a shim recording `incr(key)/pexpire(...)/pttl(key)`
    chained calls; on `exec()`, chooses the target client by
    `failKeyPredicate(key of the first incr)` and replays the recorded commands
    onto a real `target.pipeline()`, returning its `exec()` result.
  - `del(key)`: routes by the same predicate (limiter `clear`). Note
    (review round 1): the two new cases exercise only 503/404 paths, which
    never call `limiter.clear()` — the `del` branch is defensive scaffolding
    so the wrapper is a complete stand-in for the surface `createRateLimiter`
    uses (rate-limit.ts:60-106), plus it serves the `afterEach` key cleanup.
- Predicate for the new case: `(key) => key.startsWith("rl:share_verify_token:")`
  — token-limiter key shape from verify-access route.ts:61; IP-limiter keys
  (`checkIpRateLimit`, scope `share_verify_ip`) do NOT match and hit the real
  Redis.
- Wiring: reuse the existing switchable `activeRedis` (test file :71-79);
  assign the selective wrapper for the new cases, restore after.

Test cases (new `describe`, `skipIf(!dbAvailable || !redisAvailable)` — VE1+VE2):
- **Green (fail-closed) case**: schema-valid body, fresh IP → response is 503
  canonical envelope `{ error: "SERVICE_UNAVAILABLE" }` + `Retry-After`
  matching `/^\d+$/` > 0; `shareAccessLog` row count unchanged (existing
  no-mutation pattern of the file).
- **Discrimination proof (RT4/RT7 red-proof)**: identical fixture with
  `activeRedis = realRedis` (whole path real) reaches the non-503 domain
  response (404 — token does not exist). Since the IP-limiter leg is real and
  identical in both runs, the 503 in the green case is attributable ONLY to the
  token-limiter leg — proving (a) the ipLimiter passed, (b) the route reached
  `tokenLimiter`, (c) `tokenLimiter`'s production `checkRateLimitOrFail`
  mapping produced the 503. This kills the vacuous-pass risk of a wrapper that
  fails every key. The fixture token is generated fresh (random) per case so
  the 404 is guaranteed by construction, not by absence-by-convention (a
  seeded/reused `tokenHash` could otherwise surface a different non-503
  status and weaken the framing).
- Hygiene / flake control (review round 1, RT4):
  - **Reserved IPs**: the new cases use `203.0.113.30` (green) and
    `203.0.113.31` (red-proof) — verified unused across the whole
    `src/__tests__/db-integration/` tree (in-use set at plan time: .9, .10,
    .11, .20, .21, .50, .55, .60, .65). One request per case against a
    5-req/min IP limit leaves ample headroom.
  - **Retry interaction**: neither `vitest.config.ts` nor
    `vitest.integration.config.ts` configures `retry` (verified by grep), so
    same-IP re-execution within the 1-minute window cannot occur via
    framework retries. If a `retry` option is ever introduced, this file's
    IP-per-case allocation must be revisited.
  - **Cleanup**: `afterEach` deletes the `rl:share_verify_ip:*` keys for the
    reserved test IPs on the real Redis. Token-key cleanup is deliberately
    N/A: in the green case the token key's `incr` is routed to the broken
    client and never lands on real Redis; in the red-proof case it does land
    — delete it in the same `afterEach` for symmetry.

Invariants:
- No mocks of `@/lib/security/rate-limit` or `@/lib/security/rate-limit-audit`
  (RT5: production chain in path) — the ONLY substitution remains `getRedis`,
  same trust boundary the file already established (tranche-2 C10 adjudication).
- The selective wrapper must not fabricate results: it delegates every command
  to a real ioredis client (broken or real); it contains no canned values.

Forbidden patterns:
- pattern: `vi.mock("@/lib/security/rate-limit"` in this file — reason: RT5, the production limiter chain must stay real.
- pattern: `mockResolvedValue` on any limiter surface in this file — reason: same.

Acceptance criteria:
- New cases pass locally with docker Postgres+Redis (`npm run test:integration`)
  and in CI (`ci-integration.yml`).
- Existing C10 cases in the file remain green and untouched except for shared
  harness additions.

Consumer-flow walkthrough: N/A — test-only.

## Testing strategy

Per-item targeted runs during implementation, then the mandatory gates:
1. `npx vitest run` — full unit suite.
2. `npx next build` — required (C2/C3 touch production code).
3. `npm run test:integration` — C4 (requires local Postgres+Redis; also runs in CI).
4. `bash scripts/checks/check-fail-closed-routes-have-test.sh` — C1 gate
   regression check (expect: zero manifest diffs, still green).
5. `scripts/pre-pr.sh` before push (project rule).

Test-design rules honored: RT5 (C4 keeps production chain), RT7 (C2's
Content-Type-override negative; C4's red-proof), RT8 (C3 asserts `sendEmail`
spy on both branches, not just log lines), M9 (`logAuditAsync` never in
`assertNoMutation`), tranche-3 traps (vi.hoisted TDZ; `tsc` via `next build`).

## Considerations & constraints

- Commit granularity: 4 commits, one per contract, in approved order
  (C1 `refactor(security)`, C2 `fix(security)`, C3 `fix(security)` or
  `refactor` — use `fix` since release-please skips chore/docs and the log-split
  is operator-facing, C4 `test(security)`; release-please prefixes per repo
  rules). ONE PR at the end (user decision 2026-07-20).
- PR #682 interplay: zero file overlap (verified); merge order free; no rebase
  dependency in either direction.

### Scope contract

- **SC1 — SCIM 429 Retry-After**: out of scope. RFC 7644 is silent on it, and
  adding it to SCIM 429 is an unrequested spec change. (Factual note, review
  round 1: the over-limit branch DOES have `rl.retryAfterMs` available at the
  call site — with-scim-auth.ts:36-38 simply never plumbs it into `scimError`;
  the blocker is unwired plumbing, not an unknown value. A future SC1
  implementer can pass it via the new `headers` param.) Owner: future issue if
  an IdP integration requests back-off hints on 429.
- **SC2 — hardcoded `"Retry-After": "30"` literals** in
  `vault/delegation/check` and `vault/ssh/sign-authorize` custom envelopes:
  pre-existing; normalizing them onto `retryAfterSecondsOrDefault()` is a
  behavior-neutral cleanup outside this backlog. Owner: follow-up candidate
  noted for the next fail-closed housekeeping pass.
- **SC3 — other legacy patterns in v1/passwords tests** (non-fail-closed
  cases): untouched. C9.2 "touch it → migrate it" applies only to the 3
  fail-closed cases; a whole-file modernization is not in scope.
- **SC4 — real-IdP SCIM acceptance** (VE3): deferred to staging operator
  acceptance; see Verification environment constraints.

## User operation scenarios

1. **IdP admin during Redis outage**: Entra/Okta provisioning sync hits
   `/api/scim/v2/Users` → 503 + `Retry-After: 30` + SCIM error body → the IdP
   marks the cycle retryable and backs off instead of hammering; operator sees
   the `RATE_LIMIT_FAIL_CLOSED` audit row (existing) and can correlate.
2. **End user requests a magic link during Redis outage**: no email arrives
   (silent drop, unchanged); the operator's log search now distinguishes
   `magic-link.rate-limit.fail_closed` (outage — page the on-call) from
   `magic-link.rate-limited` (abuse/noise — ignore).
3. **CLI/API-key consumer during outage**: `GET /api/v1/passwords` → 503 +
   Retry-After (behavior unchanged; now pinned by the shared helper contract).
4. **Share-link recipient during a partial Redis failure** (token shard
   erroring, IP shard healthy): verify-access returns 503, no password oracle
   exposure — now proven at the route-integration tier, not only unit tier.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | v1/passwords fail-closed tests → assertRedisFailClosed tier    | locked |
| C2  | SCIM fail-closed 503 carries Retry-After (last INV-C2 member)  | locked |
| C3  | magic-link outage log channel split, silent-drop preserved     | locked |
| C4  | verify-access tokenLimiter selective-failure integration proof | locked |

## Implementation Checklist (Phase 2 Step 2-1)

Baseline (rebased onto main @ 709b6d9a8, post-#682): fail-closed gate exit 0,
`EXPECTED_DEBT_COUNT=0`, `EXPECTED_LEGACY_COUNT=0`.

Files to modify:
- C1: `src/app/api/v1/passwords/route.test.ts`, `src/app/api/v1/passwords/[id]/route.test.ts`
- C2: `src/lib/http/api-response.ts` (visibility-only export), `src/lib/scim/response.ts`, `src/lib/scim/with-scim-auth.ts`, `src/lib/scim/response.test.ts`, `src/lib/scim/with-scim-auth.test.ts`
- C3: `src/auth.config.ts`, `src/auth.config.test.ts`
- C4: `src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts`

Shared assets to reuse (no reimplementation): `assertRedisFailClosed`,
`snapshotFactory`, `assertRedisFailClosedSilentDrop`
(`src/__tests__/helpers/fail-closed.ts`), `retryAfterSecondsOrDefault`
(`src/lib/http/api-response.ts`), switchable `getRedis` harness + `requestWithIp`
(`rate-limit-fail-closed-routes.integration.test.ts`), `createRequest`/`parseResponse`
(`src/__tests__/helpers/request-builder`).

R19 test-tree enumeration (all changed symbols): `scimError` →
`src/lib/scim/response.test.ts` (+ `with-scim-auth.test.ts` behavioral);
`serviceUnavailable`/`retryAfterSecondsOrDefault` → `src/lib/http/api-response.test.ts`
(indirect, unchanged behavior); magic-link warn channel `"magic-link.rate-limited"` →
`src/auth.config.test.ts` only (repo-wide grep: no other reference);
no centralized/e2e tree references any changed selector/header/log channel.

CI gate parity: pre-pr.sh covers lint/unit/build; integration tests run in
`ci-integration.yml` (Postgres+Redis services) — mirrored locally via
`npm run test:integration` per the plan's Testing strategy. This diff adds no
new file class that CI-only gates (Extension jobs, static-checks-no-generate)
scan; C4's file already belongs to the integration glob.
