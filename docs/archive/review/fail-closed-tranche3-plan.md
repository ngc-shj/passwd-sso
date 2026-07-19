# Plan: fail-closed-tranche3 — legacy-manifest burn-down (SC-T3-1) → whole class helper-mode

Parent roadmap: `fail-closed-tranche2-plan.md` Scope contract SC-T3-1 (owner: tranche 3).
Predecessor: PR #681 (`feature/fail-closed-tranche2`, merged 2026-07-19) — burned the
debt file to 0 and pinned the class manifest. Deviation history that shapes this tranche:
tranche-2 deviation D10 (3-tier helper: Response / silent-drop / direct-result),
D17 (semantic-hybrid classifier). This plan is authored anew for tranche 3; it does
NOT reopen any tranche-2 contract.

## Project context

- Type: `web app` (Next.js 16 App Router). This tranche touches **test code only**
  plus two `scripts/checks/` control files (the gate script constants + the legacy
  manifest). No production route code changes (unlike tranche-2's C8c v1 fix). No
  classifier logic change is anticipated (the classifier already recognizes all 3
  helper tiers — D10 — and all 13 targets use `assertRedisFailClosed`, the Response
  tier).
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest unit lane;
  `scripts/checks/*` gates; meta-gate `check-gate-selftest-coverage.sh`).
- Verification environment constraints (inherited from parent plan):
  - VC3: Redis-failure fail-closed behavior is `verifiable-local` via the mocked
    limiter in unit tests (the `assertRedisFailClosed` contract). No integration-lane
    work is in scope for this tranche — C10's two-family real-broken-Redis proof
    (tranche 2) already covers the route-handler integration floor; extending it to
    these families is SC-T3-4, explicitly deferred. Every contract path below is
    `verifiable-local`.

## Objective

Migrate all **13 routes** currently registered in
`scripts/checks/fail-closed-legacy-direct.txt` from **legacy-direct tier** (test
asserts 503 directly with code-level `redisErrored`, pre-helper form; 4 of them
partial-stub `@/lib/security/rate-limit-audit`) to **helper mode** (each route's
sibling test calls `assertRedisFailClosed` — the strongest tier with recorded
factory attribution, envelope assertion, and non-empty `assertNoMutation`).

On completion:
1. `fail-closed-legacy-direct.txt` holds **0 route entries** (header + empty).
2. `EXPECTED_LEGACY_COUNT` drops `13 → 0` in the gate script (visible ratchet diff).
3. The C6 `FROZEN_STUB_EXEMPTIONS` list (4 tenant/* files) is **emptied** — every
   `vi.mock("@/lib/security/rate-limit-audit")` under `src` is removed, so the C6
   structural stub gate finds **zero** stubs and needs zero exemptions.
4. The whole fail-closed class (all 65 manifest members) is now machine-verified at
   helper tier or already-migrated tiers — no member sits at the weaker legacy tier.

## Ground truth (verified 2026-07-20 against main @ e3498ca6f)

Legacy manifest = 13 routes. Per-route survey (`grep` over each sibling test +
route):

| # | Route (src/app/api/...) | Limiters | Sibling test | Stub? | redisErrored | Tier target |
|---|---|---|---|---|---|---|
| 1 | auth/[...nextauth] | **2** (callbackRateLimiter, magicLinkIpLimiter) | route.test.ts (426L) | no | 4 | helper ×2 cases |
| 2 | maintenance/audit-chain-verify | 1 | route.test.ts (230L) | no | 1 | helper |
| 3 | maintenance/audit-outbox-metrics | 1 | route.test.ts (240L) | no | 1 | helper |
| 4 | maintenance/audit-outbox-purge-failed | 1 | route.test.ts (304L) | no | 1 | helper |
| 5 | maintenance/dcr-cleanup | 1 | route.test.ts (200L) | no | 1 | helper |
| 6 | maintenance/purge-audit-logs | 1 | route.test.ts (428L) | no | 1 | helper |
| 7 | maintenance/purge-history | 1 | route.test.ts (433L) | no | 1 | helper |
| 8 | tenant/breakglass | 1 | route.test.ts (517L) | no | 2 | helper |
| 9 | tenant/members/[userId]/reset-vault | **2** (adminResetLimiter, targetResetLimiter) | route.test.ts (753L) | **yes** | 4 | helper ×2 cases |
| 10 | tenant/operator-tokens | 1 | route.test.ts (373L) | **yes** | 3 | helper |
| 11 | tenant/scim-tokens | 1 | route.test.ts (326L) | **yes** | 3 | helper |
| 12 | tenant/service-accounts | 1 | route.test.ts (271L) | **yes** | 3 | helper |
| 13 | vault/ssh/sign-authorize | 1 | route.test.ts (365L) | no | 1 | helper |

Total cases: 15 (13 routes; #1 and #9 contribute 2 each — one per distinct limiter,
mandated by the gate's `HELPER_CALLS_BELOW_LIMITER_COUNT` distinct-arg rule).

Limiter-consumption topology (determines mock arrangement + which spies are legal
in `assertNoMutation`):

- **11 canonical `checkRateLimitOrFail` routes** (#1–8, #10–13): the route calls
  `checkRateLimitOrFail({ req, limiter | result, scope, userId, tenantId })` which
  maps `redisErrored → serviceUnavailable()` (canonical 503 + Retry-After) and
  fires `emitRateLimitFailClosed` internally on the post-auth path. Envelope =
  `canonical`.
- **#1 auth/[...nextauth]** is canonical but pre-auth (`userId: null`): it composes
  `checkIpRateLimit(... limiter)` → `checkRateLimitOrFail({ req, result, scope,
  userId: null })`. On redisErrored the emit is **warn-log only** (no
  `logAuditAsync`) because userId is null (rate-limit-audit.ts:110-118). The two
  limiters are reached via the exported wrappers `_withCallbackRateLimit` /
  `_withMagicLinkIpRateLimit`, each gated by a pathname/method match
  (`isCallbackRoute` / `isMagicLinkSigninRoute`). Precedent for the ip-limiter arrange
  (real `checkIpRateLimit` skips a null-IP limiter with `{allowed:true}`,
  ip-rate-limit.ts:52-59): tranche-2 row #9 (extension/bridge-code, U refactor) — a
  non-null client IP must be arranged so the limiter is actually reached.
- **#9 reset-vault** is the sole **direct `.check()`** route: it calls
  `Promise.all([adminResetLimiter.check(...), targetResetLimiter.check(...)])`
  (route.ts:123-124), then `if (adminResult.redisErrored || targetResult.redisErrored)
  { void emitRateLimitFailClosed({ ... userId: session.user.id, tenantId }); return
  serviceUnavailable(); }`. Post-auth → **`logAuditAsync` fires on the 503 path**
  (via emitRateLimitFailClosed) → `logAuditAsync` is FORBIDDEN in `assertNoMutation`
  (tranche-2 M9 rule). Envelope = `canonical`. The two `.check()` calls run under a
  single request, so the two cases arrange one limiter to `redisErrored` while the
  sibling resolves `{allowed:true}`.

Stub form in the 4 tenant/* siblings (partial `importOriginal`, D4/C6 target):
```ts
vi.mock("@/lib/security/rate-limit-audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  emitRateLimitFailClosed: vi.fn(),   // ← stubbed to a no-op
}));
```
This keeps real `checkRateLimitOrFail` (so redisErrored→503 mapping runs) but spies
`emitRateLimitFailClosed` to dodge its transitive deps. C6 forbids ANY
rate-limit-audit mock in a non-exempt file; migrating to helper mode requires
**removing this mock entirely** and letting the real emit run — which then fires
`logAuditAsync`, so the migrated tests must pin the audit seam at
`@/lib/audit/audit` (legal — C6 bans only rate-limit-audit) and honor throttle
hygiene.

### Member-set derivation (R42)

Class SC-T3-1 = current content of `scripts/checks/fail-closed-legacy-direct.txt`.

```
grep -vE '^\s*#|^\s*$' scripts/checks/fail-closed-legacy-direct.txt | sort   # 13 routes
```

Cross-check against the C6 exemption primitive (the 4 stub files must be a subset):

```
git grep -lE 'vi\.mock\("@/lib/security/rate-limit-audit"' -- 'src'
# → exactly the 4 tenant/* siblings (reset-vault, operator-tokens, scim-tokens,
#   service-accounts) — matches FROZEN_STUB_EXEMPTIONS in the gate script.
```

Verified 2026-07-20: 13 legacy entries; 4 of them are the frozen-exemption set; no
other rate-limit-audit stub remains anywhere under `src` (tranche 2 removed the
central-tree ones). Post-migration both greps return empty.

Whole-class invariant (unchanged by this tranche, re-asserted as the completeness
check): manifest = 65 members = (helper 18+3 lib from tranche 2 ∪ these 13 → helper)
∪ … The manifest `path<TAB>count` set and per-file counts are NOT edited by this
tranche — no `failClosedOnRedisError: true` literal is added or removed. Only the
tier of the 13 routes' sibling tests changes.

## Contracts

### C1 — Per-case helper migration (15 cases across 13 sibling tests)

- Every route's sibling `route.test.ts` gains (or has its existing direct-503 test
  REPLACED by) a test that calls `assertRedisFailClosed` with:
  - `invoke`: a thunk running the real handler (GET/POST as the route's limiter
    guards) and returning its `Response`.
  - `limiter`: the **factory-result object** for the limiter under test (strict
    identity — the object `createRateLimiter` returned, captured via the recording
    factory mock). For #1/#9 each case passes a **distinct** limiter object.
  - `limiterFactory`: the recorded `createRateLimiter` `vi.fn()` (snapshot-replayed
    per M10 — every one of the 13 files clears mocks in `beforeEach`, so
    `snapshotFactory` at module scope right after the route import is mandatory).
    **Exception — #1 auth uses dynamic `await import()`** (see the M-refactor note
    below): its factory fires only after the first dynamic import, so the
    module-scope snapshot pattern does not apply; capture + snapshot after the first
    `await import(...)` instead.
  - `expectation`: `{ envelope: "canonical" }` for 14 of 15 cases (every route maps
    redisErrored → `serviceUnavailable()` / canonical 503 + Retry-After). The sole
    exception is **#13 ssh/sign-authorize**, which supplies a bespoke
    `checkRateLimitOrFail` `envelope` returning `{ authorized: false, reason:
    "service_unavailable" }` (status 503, Retry-After 30) — its case uses
    `{ envelope: "custom", status: 503, body: { authorized: false, reason:
    "service_unavailable" }, retryAfter: "required" }` (deviation D1). Note this
    STRENGTHENS the assertion set beyond the current direct-503 tests (which assert
    status only): the helper additionally asserts the body `{ error:
    "SERVICE_UNAVAILABLE" }` and a strictly-positive integer `Retry-After`. Every
    route's 503 path reaches `serviceUnavailable()` (verified), so this passes — but
    each migrated `invoke` must actually reach `serviceUnavailable()`, not a bare
    `Response(..., {status:503})`.
  - `assertNoMutation`: non-empty, real write/side-effect spies for that route's
    guarded mutation (table below). **`logAuditAsync` is FORBIDDEN in
    `assertNoMutation` on EVERY post-auth row (#2–#13)** (M9). Derivation rule (not a
    hand-picked subset): any route that passes a **non-null `userId` with a
    resolvable `tenantId`** to `checkRateLimitOrFail` (or calls
    `emitRateLimitFailClosed` directly, as #9 does) fires `logAuditAsync` on the
    redisErrored 503 path (rate-limit-audit.ts:135-167) — all of #2–#13 do. Spying it
    as "no mutation" races the un-awaited emission (flake) and, if "fixed" by
    stubbing, suppresses the audit trail of a fail-closed event on a privileged route.
    #1 (pre-auth, `userId: null`) also excludes it, but because the emit is warn-log
    only (no `logAuditAsync`) — a different reason. The write-primitive spies in the
    table are the correct non-empty set; never add `logAuditAsync` alongside them.
  - `failure`: inline literal `{ allowed: false, redisErrored: true }` (gate literal
    must be code, not comment).
- Test name: `"fails closed (503, no mutation) when Redis is unavailable"`
  (multi-limiter files suffix ` — <limiter scope>`: e.g. ` — callback`,
  ` — magic-link`, ` — admin limiter`, ` — target limiter`).

**Per-route `assertNoMutation` spies + arrange notes:**

All post-auth rows (#2–#13) exclude `logAuditAsync` per the derivation rule above —
the "NOT logAuditAsync" note is stated once here and applies to every one, not just
the four it was originally written on.

| # | Route | limiter arg(s) | assertNoMutation spies | arrange notes |
|---|---|---|---|---|
| 1 | auth/[...nextauth] | callbackRateLimiter / magicLinkIpLimiter (2 cases) | (read-only wrapper — tranche-2 read-only-route semantic extension) handler-proceeded spy: the wrapped `handler` mock `.not.toHaveBeenCalled()` | non-null client IP so real checkIpRateLimit reaches limiter; callback case → callback pathname, magic-link case → POST /api/auth/signin/nodemailer; both `userId:null` (warn-log only, no logAuditAsync) |
| 2 | audit-chain-verify | rateLimiter | auditLog read/verify svc spy (nearest downstream) | admin bearer; NOT logAuditAsync |
| 3 | audit-outbox-metrics | rateLimiter | outbox metrics read spy | admin bearer; NOT logAuditAsync |
| 4 | audit-outbox-purge-failed | rateLimiter | auditOutbox.deleteMany | admin bearer; NOT logAuditAsync |
| 5 | dcr-cleanup | rateLimiter | `requireMaintenanceOperator` `.not.toHaveBeenCalled()` (410 stub has NO DB write; this is the first effect AFTER the limiter, so its non-invocation proves the 503 short-circuited before any downstream work) | admin bearer; limiter precedes the 410 (verified route.ts:42<71); NOT logAuditAsync (its only other effect is a logAuditAsync, forbidden) |
| 6 | purge-audit-logs | rateLimiter | auditLog.deleteMany | admin bearer; NOT logAuditAsync |
| 7 | purge-history | rateLimiter | passwordHistory.deleteMany | admin bearer; NOT logAuditAsync |
| 8 | breakglass | breakglassRateLimiter | breakGlassGrant.create | admin session + step-up; NOT logAuditAsync |
| 9 | reset-vault | adminResetLimiter / targetResetLimiter (2 cases) | adminVaultReset.create, createNotification | step-up → null; per case arrange the SIBLING limiter's own check to {allowed:true} (Promise.all runs both concurrently); NOT logAuditAsync |
| 10 | operator-tokens | scoped create limiter | operatorToken.create (+ advisory-lock $executeRaw if present) | admin session + step-up; NOT logAuditAsync |
| 11 | scim-tokens | scimTokenCreateLimiter | scimToken.create | admin session + step-up; NOT logAuditAsync |
| 12 | service-accounts | saCreateLimiter | serviceAccount.create | admin session + step-up; NOT logAuditAsync |
| 13 | ssh/sign-authorize | signRateLimiter | prisma.sSHAgentKey.findFirst (or the downstream key-lookup/authorize svc spy) | authed session; NOT logAuditAsync; **CUSTOM envelope** — `{ envelope: "custom", status: 503, body: { authorized: false, reason: "service_unavailable" }, retryAfter: "required" }` (verified route.ts:87-91; NOT canonical — deviation D1) |

- Refactor sub-tasks per file:
  - **F (factory→recording)**: the current factory form varies — some files use a
    **plain arrow** `createRateLimiter: () => ({ check, clear })` (verified:
    purge-history:36, dcr-cleanup:20, auth:34, sign-authorize:35 — NO `vi.fn`, so
    `snapshotFactory` reading `mock.mock.calls` would throw), others a non-recording
    `vi.fn(() => ({...}))` (e.g. operator-tokens:69). Convert EVERY file's factory to
    a **recording `vi.fn()`** captured in a module-scoped `const` (unconditionally —
    do not assume `.mock` already exists) so `snapshotFactory` can replay it and
    strict-identity attribution works. (Precedent: tranche-2 F column.)
  - **M (multi-limiter split)**: #1 and #9 — the recording factory MUST return a
    **distinct object per `createRateLimiter` call** (do NOT return one shared
    object). Both files today share ONE `check` mock across their two limiters,
    distinguished only by ordered `mockResolvedValueOnce` — that shape is
    incompatible with the helper (which does `limiter.check.mockResolvedValue(failure)`
    on the ONE limiter passed, and attributes via
    `findIndex(r => r.value === limiter)` — a shared object resolves to index 0 for
    both, so the second case's flag-attribution reads the wrong factory call, and a
    shared `check` cannot isolate one limiter failing while the sibling is healthy).
    - **Reference shape (solved in-repo)**: mirror
      `tenant/members/[userId]/reset-vault/[resetId]/approve/route.test.ts` (tranche-2
      row #20) — two distinct `check` fns, `mockImplementationOnce`×2 returning
      distinct `{ check }` objects in `createRateLimiter` creation order, module-scope
      capture of `results[0].value` / `results[1].value`. Per case: pass the
      under-test limiter object; arrange the SIBLING limiter's `check` to
      `mockResolvedValue({ allowed: true })` BEFORE invoking (both `.check()` run
      concurrently under the route's `Promise.all`, so both must be pre-armed). This
      gives 2 distinct `limiter:` args → satisfies `HELPER_CALLS_BELOW_LIMITER_COUNT`
      (declared count 2).
    - **#1 auth exception (dynamic-import topology)**: the auth test imports the route
      via `await import(...)` inside each test body with `resetModules()` — there is
      NO static module-scope route import, so the module-scope `snapshotFactory` /
      `results[i].value` capture reads an EMPTY `mock.results` → undefined limiters.
      Do NOT copy the approve-route module-scope pattern here. Instead: import once in
      a `beforeAll` (or capture after the first `await import(...)` in each case) and
      snapshot/replay the factory AFTER that import resolves; the two limiters
      (`callbackRateLimiter`, `magicLinkIpLimiter`) are separate production consts, so
      the factory's two calls yield distinct results once captured post-import.
      Wiring precision (the existing structure is two separate describe blocks —
      `withCallbackRateLimit` and `withMagicLinkIpRateLimit` — each with its own
      per-test `resetModules`, and ~14 existing wrapper tests reference the shared
      `mockRateLimitCheck` directly): to preserve those tests, the module-scope
      `@/lib/security/rate-limit` mock must return **two distinct result objects that
      both delegate their `check` to the existing `mockRateLimitCheck`** (not one
      shared object, and not two independent checks that would break the existing
      assertions). Both limiters are co-constructed only on a single module
      evaluation (route.ts:77 callback, :127 magic-link), so the redisErrored cases
      must capture `mock.results[0]/[1].value` from ONE import that constructs both —
      place them in a dedicated describe block that imports once (no `resetModules`
      between the two limiter cases), separate from the two wrapper blocks. Do not
      rewire the existing wrapper assertions. Auth is the HIGHEST-risk case (alongside
      reset-vault); verify `distinct=2` classification explicitly. Record the chosen
      shape in the deviation log.
  - **S (stub removal)**: #9–12 (the 4 tenant/*) — DELETE the
    `vi.mock("@/lib/security/rate-limit-audit", …)` block entirely. To keep the now-real
    `emitRateLimitFailClosed → logAuditAsync` from pulling transitive deps or throwing,
    mock `@/lib/audit/audit` exporting spied `logAuditAsync` + `tenantAuditBase`
    (legal under C6), and call `__resetThrottleForTests()` in `beforeEach` (throttle
    hygiene — tranche-2 F-R2-2: `emitRateLimitFailClosed` throttles per
    `rlfc:<scope>:<userId>` in a module-scoped 5-min Map; without reset an earlier
    test's emission silently swallows a later assertion). These files assert
    row-count no-mutation (not emission), so the reset is defensive isolation, not an
    emission assertion — but it is mandatory because the real emit now runs.
- Existing non-fail-closed cases in each file are preserved unchanged; only the
  redisErrored/503 case is restructured to the helper contract, and (for #9–12) the
  rate-limit-audit stub removal is applied globally in the file.
- Acceptance: `npx vitest run` green; each migrated test FAILS if the route's 503
  envelope changes family or loses Retry-After, the guarded mutation executes, the
  flag is removed from the limiter options (factory attribution), or the file
  re-introduces a rate-limit-audit stub (C6 gate).

**Consumer-flow walkthrough** (C1 defines no new producer shape — it consumes the
existing `assertRedisFailClosed` helper contract): the sole consumer of each test is
the vitest runner + the gate classifier. Classifier reads each migrated file and must
emit `calls≥1` (helper-mode flip) and `mock=0` (no rate-limit-audit stub). For #1/#9
the gate additionally reads `distinct` limiter args = 2. Walkthrough:
`Consumer classify-fail-closed-test.mjs (path: scripts/checks/) reads { calls, mock,
redis } per file and uses calls>0 ∧ mock=0 to classify the file as helper-mode; the
gate then reads distinct-limiter count from the helper callsites and compares to the
manifest limiter count.` No field is missing — the helper API is unchanged, so this
is a tier flip, not a shape change.

### C2 — Legacy manifest burn-down (atomic, 13 → 0) + ratchet decrement

- Remove all 13 entries from `scripts/checks/fail-closed-legacy-direct.txt` in the
  SAME PR that migrates the tests (STALE_LEGACY_ENTRY enforces per-route atomicity —
  a migrated test whose entry lingers fails the gate). File stays in place (header +
  zero entries) as the future opt-in target.
- Set `EXPECTED_LEGACY_COUNT` `13 → 0` in `check-fail-closed-routes-have-test.sh`
  (line 63). The gate asserts EXACT equality (`legacy_count -ne EXPECTED_LEGACY_COUNT`
  → fail), so the constant edit is mandatory and review-visible — symmetric with the
  entry removal.
- Also correct the now-stale comments that describe the legacy count as "16 (13
  routes + 3 lib members)" — the real constant is already 13 (the 3 lib members are
  helper-mode, not legacy) and drops to 0 here: gate comment
  `check-fail-closed-routes-have-test.sh:61` and self-test comment
  `check-fail-closed-routes-have-test.test.mjs:967`. Update both to the post-tranche
  end-state so the ratchet diff is self-consistent.
- Acceptance: `bash scripts/checks/check-fail-closed-routes-have-test.sh` exits 0
  with an empty legacy file and `EXPECTED_LEGACY_COUNT=0`.

### C3 — C6 frozen-exemption emptying

- Empty the `FROZEN_STUB_EXEMPTIONS` variable in
  `check-fail-closed-routes-have-test.sh` (currently the 4 tenant/* `route.test.ts`
  paths, ~line 558). After C1's S-refactor removes all 4 stubs, no file needs an
  exemption; leaving stale exemptions would be dead config but not a gate failure —
  however emptying it is the explicit SC-T3-1 end-state and makes the "zero stubs
  anywhere" invariant visible in the script diff.
- The gate's stub scan (`STUB_MOCKED_RATE_LIMIT_AUDIT`) then requires **zero**
  `mock=1` files under `src` across both lanes. Any residual stub fails CI.
- Acceptance: `git grep -lE 'vi\.mock\("@/lib/security/rate-limit-audit"' -- 'src'`
  returns empty; the gate's stub scan reports zero findings with an empty exemption
  list.

### C4 — Anti-pattern forbidden patterns (diff-scoped)

- pattern: `vi\.mock\("@/lib/security/rate-limit-audit"` anywhere in the diff —
  reason: RT5 mapping stub; C6 now enforces zero across all of `src` (no exemptions).
  The 4 tenant/* removals are the only legitimate occurrences of this string in the
  diff (as deletions).
- pattern: `checkRateLimitOrFail\s*:\s*vi\.fn` in the diff — reason: same
  anti-pattern via inline factory property (MAPPING_MOCKED_CONTRACT_TEST).
- pattern: `success:\s*(true|false)` in fail-closed fixtures — reason: field does
  not exist on `RateLimitResult` (tranche-2 C4).
- pattern: `logAuditAsync` inside any `assertNoMutation` array in the diff — reason:
  M9 rule; the 503 path fires it on post-auth routes, so spying it as "no mutation"
  races the intended emission.
- pattern: a single shared limiter object returned by the #1/#9 recording factory
  (i.e. the factory `vi.fn(() => sharedObj)` form) — reason: defeats distinct-arg
  attribution; each `createRateLimiter` call must yield its own result object.

### C5 — Classifier & self-test integrity (no logic change expected)

- No change to `classify-fail-closed-test.mjs` is anticipated: all 13 targets use
  `assertRedisFailClosed` (Response tier, already recognized), and stub removal only
  flips `mock 1→0` (already handled). If migration surfaces a classifier gap
  (unexpected), any fix follows the tranche-2 order-of-work invariant: red fixture in
  `scripts/__tests__/classify-fail-closed-test.test.mjs` FIRST, then the change, and
  the semantic-hybrid architecture (D17) is preserved — no `getSymbol` over the
  syntactic project, no by-name whole-scan.
- The gate self-tests (`check-fail-closed-routes-have-test.test.mjs`,
  `classify-fail-closed-test.test.mjs`) must stay green. The EXPECTED_LEGACY_COUNT
  ratchet is exercised via the existing `FAIL_CLOSED_EXPECTED_LEGACY_COUNT` override
  fixtures — verify a fixture asserting count-0 legacy passes and count-1 fails still
  holds after the constant change (the fixtures use overrides, not the real constant,
  so they are insulated; confirm no self-test hardcodes 13).
- Acceptance: `npx vitest run scripts/__tests__/classify-fail-closed-test.test.mjs`
  and `.../check-fail-closed-routes-have-test.test.mjs` green;
  `bash scripts/checks/check-gate-selftest-coverage.sh` exits 0.

## Testing strategy

- `npx vitest run` — 15 migrated cases + all existing suites; gate + classifier
  self-tests via the `scripts/__tests__/*` vitest lane.
- `bash scripts/checks/check-fail-closed-routes-have-test.sh; echo $?` — the real
  gate, EXIT 0 (C1 helper-mode flips + C2 empty legacy + C3 empty exemptions).
- `bash scripts/checks/check-gate-selftest-coverage.sh; echo $?` — meta-gate.
- `time node scripts/checks/classify-fail-closed-test.mjs $(git ls-files src | grep -E '\.test\.tsx?$' | sed "s|^|$(pwd)/|")`
  — ONLY IF the classifier is touched (baseline: full gate ~9.4s / classifier ~4s;
  CI timeouts 10s/60s). If untouched, skip.
- `PRE_PR_CACHE_TTL=0 bash ~/.claude/hooks/check-pre-pr.sh run` — full (vitest +
  build + all gates). Build runs even though only test/script files change (the
  hook decides); no production route code is modified so a build regression is not
  expected, but pre-pr is authoritative.
- `npx next build` — mandatory per CLAUDE.md only if pre-pr does not already cover
  it; test-only + script changes normally skip build, but pre-pr is the gate.

## Considerations & constraints

### Scope contract

- **SC-T3-1** (this tranche): 13 legacy routes → helper mode + 4 stub removals + C6
  exemption emptying + EXPECTED_LEGACY_COUNT 13→0. **In scope.**
- SC-T3-2: SCIM 503 Retry-After header (RFC 7644 review) — deferred, future SCIM
  hardening. Not touched here.
- SC-T3-3: v1/passwords + v1/passwords/[id] direct-redisErrored tests → helper mode —
  deferred; those are NOT legacy-manifest members (their limiter member is
  `rate-limiters.ts`, already helper), so out of SC-T3-1's set. Promote only if
  touched.
- SC-T3-4: route-handler integration for families beyond C10's two (incl.
  verify-access token-limiter, needing a selectively-failing Redis fake) — deferred.
- SC-T3-5: magicLinkEmailLimiter redisErrored observability upgrade — deferred.

### Risks

- **The two multi-limiter routes (#1 auth, #9 reset-vault) are the two hard cases —
  do them FIRST, in this order: #9 then #1.** #9 reset-vault consumes
  `Promise.all([admin.check, target.check])` by `.redisErrored` OR; the recording
  factory must return two distinct objects (approve-route shape, C1 M-refactor) and
  each case must pre-arm the sibling limiter. #1 auth is HIGHER-risk still: its test
  uses dynamic `await import()` + `resetModules()`, so the module-scope snapshot
  pattern does NOT transfer — it needs the post-import capture described in C1's #1
  exception, restructuring only the redisErrored cases. Do NOT assume "mirror #9 to
  #1"; they differ in import topology. Verify `distinct=2` classification on each.
  Record the chosen shape for both in the deviation log. Only after both pass do the
  11 single-limiter routes fan out. Fallback for #9 if call-order distinct results
  prove fragile: two separate `createRateLimiter` module mocks keyed by options.
- **Un-stubbing the 4 tenant/* rate-limit-audit mocks may surface transitive-dep
  import errors** (the stub's stated purpose was "avoid pulling transitive deps").
  Mitigation: mock `@/lib/audit/audit` (`logAuditAsync`, `tenantAuditBase`) — the
  same seam tranche-2 C8b used for SCIM — which is exactly the transitive dep the
  stub was dodging. Verify on operator-tokens (#10) first.
- **Throttle bleed across the migrated tenant/* tests**: real `emitRateLimitFailClosed`
  now runs; `__resetThrottleForTests()` in `beforeEach` is mandatory in #9–12.
  Without it, a second redisErrored case in the same file (or a neighboring file in
  the same worker) silently swallows the emission — but since these tests assert
  row-count not emission, the failure mode is subtler (a later emission-inspecting
  test elsewhere flakes). Add the reset defensively per the tranche-2 mandate.
- **#1 auth wrapper reach**: the two limiters only fire when `isCallbackRoute` /
  `isMagicLinkSigninRoute` match. Each case must invoke the exported wrapper with a
  matching pathname/method and a non-null client IP, else real `checkIpRateLimit`
  short-circuits `{allowed:true}` and the limiter is never reached (helper step 3
  `expect(limiter.check).toHaveBeenCalled()` would fail loud — good, catches a
  mis-arranged case).
- **15-file mechanical fan-out drift** — mitigation: batch (reset-vault + auth first
  as the two hard cases, then the 4 tenant/* stub-removals, then the 7 clean
  single-limiter routes), `vitest related` per batch, C4 grep, full suite last.
- Pre-1.0, no production behavior change (test-tier + gate-constant only) — no
  changelog user-visible entry; conventional commit `test(security):` /
  `refactor(security):` for the gate control-file edits (release-please: `test` does
  not bump; the gate-script edit is `refactor` to register a patch bump if a bump is
  desired — decide at commit time, low stakes).

### Accepted residual

- After this tranche the legacy tier is empty but the **mechanism** (legacy manifest
  + EXPECTED_LEGACY_COUNT + STALE/DANGLING tokens) remains in the gate as the
  registration path for any future pre-helper onboarding. This is intentional — the
  tier is retired of members, not deleted as machinery (deleting it would remove the
  ratchet that blocks a future silent legacy re-entry).

## User operation scenarios

- Operator during a Redis outage: every one of the 13 endpoints (admin key-rotation
  maintenance ops, breakglass grant, tenant token/SA creation, admin vault reset, SSH
  sign authorize, auth callback / magic-link signin) returns canonical 503 +
  Retry-After; no maintenance mutation runs, no token/SA/grant created, no vault
  reset performed, no signature authorized, no auth callback processed — now proven
  by the strongest-tier contract with recorded factory attribution, not a
  direct-503 assertion that could pass on a mis-wired limiter.
- Developer touching any of these 13 routes' rate-limit wiring later: the sibling
  test is now helper-mode, so a broken 503 envelope, a dropped Retry-After, a
  removed `failClosedOnRedisError` flag, or a re-introduced rate-limit-audit stub all
  fail CI at the strongest tier.
- Developer adding a NEW fail-closed limiter anywhere under src: unchanged from
  tranche 2 — manifest entry + helper contract (or debt entry with visible
  EXPECTED_DEBT_COUNT bump) demanded; a new rate-limit-audit stub fails CI with an
  empty exemption list (previously 4 slots were "available cover" — now zero).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Per-case helper migration (15 cases / 13 files; F/M/S refactors) | locked |
| C2 | Legacy manifest burn-down 13→0 + EXPECTED_LEGACY_COUNT 13→0 | locked |
| C3 | C6 FROZEN_STUB_EXEMPTIONS emptied; zero rate-limit-audit stubs under src | locked |
| C4 | Anti-pattern forbidden patterns (rate-limit-audit stub, mapping stub, logAuditAsync-in-noMutation, shared-limiter-object) | locked |
| C5 | Classifier/self-test integrity (no logic change expected; ratchet fixtures insulated) | locked |
