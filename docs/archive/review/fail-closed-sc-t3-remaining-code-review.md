# Code Review: fail-closed-sc-t3-remaining
Date: 2026-07-20
Review round: 1 (converged — tightening-only skip applied)

## Changes from Previous Round
Initial review, incremental on top of the Phase 2 self-R-check baseline
(3/3 No findings). Ollama pre-screen produced one Major claim
(route.test.ts "returns 429" case asserts 401) — VERIFIED FALSE by the
orchestrator before expert launch (both 429 cases assert 429); recorded as a
pre-screen hallucination and excluded from expert scope.

## Functionality Findings
No findings. Independent verification by the expert: 211/211 targeted unit
tests; 6/6 C4 integration cases against real Postgres+Redis; `next build`
pass; fail-closed gate exit 0 with zero manifest diffs; INV-C2 member-set
independently re-derived (bridge-code / reset-vault / nextauth redisErrored
sites all route through the canonical `serviceUnavailable()` path — no 6th
producer); C4 key predicates verified non-colliding; `pipeline.incr` always
first (wrapper's `routeKey ?? ""` fallback unreachable); e2e grep zero hits
for changed log channels / headers; all 7 SCIM handlers pass-through; both
forbidden patterns absent; reserved IPs and no-vitest-retry confirmed.

## Security Findings
No findings. Verified in final code state: C2 header-merge order (Content-Type
unoverridable; only production caller builds the headers object locally from
non-request data; 503 body byte-identical); C3 branch order + early return +
literal-only log (email-send path structurally unreachable from the change);
C4 substitutes only `getRedis` (production chain unmocked, grep-proven), no
fabricated command results, no secret material in fixtures; C1 attribution is
identity-based in the shared helper's step 6 — a route wired without
`failClosedOnRedisError: true` cannot pass.

## Testing Findings
One Minor:

- **F1/F1b (Minor)** — `route.test.ts:86` / `[id]/route.test.ts:116`:
  `mock.results[v1LimiterCallIndex]!.value` after `findIndex` — on future
  drift of `v1ApiKeyLimiter` options the index is -1 and `.value` throws an
  opaque TypeError at module-eval time. Fails loudly either way (no silent
  pass; RT1/RT8 unaffected), but a guard with a descriptive Error
  (mirroring `assertRedisFailClosed`'s own guard pattern) makes the failure
  self-explanatory. → FIXED this round.

## Seed Finding Disposition
- Functionality seed: No findings — no dispositions.
- Security seed: No findings — no dispositions.
- Testing seeds (3, all **Rejected** with evidence):
  1. `routeKey ??=` single-key assumption — production `checkRedis()` opens
     exactly one pipeline per `check()` with a single key; sequential limiter
     calls each resolve their own pipeline. Premise holds.
  2. Move async arrange to `beforeEach` — per-test `vi.doMock` + dynamic
     import must run in-test (paired with `resetModules`); second case
     mutates `limiter.check` between arrange and act; matches sibling suites.
  3. `clearEnv` redundant vs `unstubAllEnvs` — `unstubAllEnvs` restores only
     AFTER a test; `clearEnv` blanks real ambient env at test START. Not
     redundant.

## Adjacent Findings
- Security: `tenant/members/[userId]/reset-vault` 503 path inspected solely
  to validate INV-C2 completeness — compliant via `serviceUnavailable()`,
  no action.

## Quality Warnings
None (manual merge — one substantive finding across three experts; Ollama
merge-findings skipped as unnecessary for this volume).

## Recurring Issue Check
### Functionality expert
- R1-R17: pass/n/a per diff scope; R18: pass; R19: pass (independent
  test-tree + e2e greps); R20-R28: n/a; R29: pass; R30-R41: n/a; R42: pass
  (independent re-derivation); R43-R46: n/a
### Security expert
- R1/R2: pass (single-owner default; no new "30" literal); R19: pass;
  R21: n/a (no delegation); R29: pass; R42: pass (fresh-grep re-derivation);
  other R: n/a
- RS1-RS6: pass/n/a — RT5 chain unmocked (grep-proven); RT7 negatives
  present; RT8 side-effect spies asserted
### Testing expert
- R1: pass; R2: pass; R3: pass; R4-R9: n/a; R10: pass; R11-R15: n/a;
  R16: pass; R17: pass; R18: n/a; R19: pass; R20-R28: n/a; R29: pass;
  R30-R37: n/a; R38: pass; R39: n/a; R40: pass; R41: n/a; R42: pass;
  R43: pass; R44-R45: n/a; R46: pass
- RT1: pass (mock identity verified); RT2: pass; RT3: pass; RT4: pass;
  RT5: pass; RT6: pass; RT7: pass; RT8: pass; RT9: pass

## Environment Verification Report
- VE1 (Postgres): `verified-local` — `npm run test:integration` against the
  docker dev stack (89 files pass; rerun clean after one non-reproducing
  unrelated flake); `verified-CI` path exists via `ci-integration.yml`
  postgres service.
- VE2 (Redis): `verified-local` — same run; C4's
  `describe.skipIf(!redisAvailable)` gates ran ACTIVE (6/6 in the C10 file,
  stable across 3 consecutive runs); `verified-CI` via `ci-integration.yml`
  redis service + `REDIS_URL`.
- VE3 (real-IdP SCIM acceptance): `blocked-deferred` — links to plan
  "Verification environment constraints" VE3 entry and Scope contract SC4
  (staging operator acceptance); unit-level response-object assertions are
  the verification per the recorded cost-justification.

## Resolution Status
### F1/F1b [Minor] findIndex non-null assertion lacks not-found guard
- Action: replaced `mock.results[idx]!.value` with a guarded lookup that
  throws a descriptive Error naming the drift cause
  (windowMs/max/failClosedOnRedisError match criteria).
- Modified files: src/app/api/v1/passwords/route.test.ts:86,
  src/app/api/v1/passwords/[id]/route.test.ts:116
- Verified: 67/67 tests in the two files; `tsc --noEmit` clean.

## Tightening-only skip — Round 1
Findings applied directly (no Round 2 review):
- [F1/F1b] [Minor] findIndex guard + descriptive error — route.test.ts:86 /
  [id]/route.test.ts:116 — applied verbatim per the finding's recommendation.
Justification: both findings are scoped within the Phase 2 (C1) fix range;
inline minor (test-scaffolding diagnostics only — no observable behavior
change: the suite fails loudly in both worlds, only the error message
differs); no security boundary touched (production rate-limit path and every
assertion are byte-identical; the guard runs at test-module eval, before any
rate-limit logic executes).
