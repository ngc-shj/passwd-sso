# Plan Review: fail-closed-tranche1
Date: 2026-07-18
Review round: 4 — CONVERGED (Rounds 1–3 preserved below)

---

# Round 4 (2026-07-18) — final targeted verification

Delta: Round 3 resolution edits (preArranged removal, identity-only step 6,
T4 mcp/token carve-out, :237 citations). Single targeted reviewer verified:
no stale preArranged/fallback/:239 references; all sections internally
consistent; tokenRateLimiter-before-ipRateLimiter creation order confirmed in
route source; case B walkthrough sound. **No findings.**

Convergence: Functionality (R2, resolved), Security (R3 residual → fixed,
R4 clean), Testing (R3 residual → fixed, R4 clean). Go/No-Go: C1–C6 locked.
Phase 1 complete after 4 rounds → Phase 2.

---

# Round 3 (2026-07-18)

## Changes from Previous Round
Round 2 fixes applied (attributed factory assertion, C6 cases 5/7, :237
citation). Round 3 ran Security + Testing targeted verification on the edited
passages (Functionality's only Round 2 item was the self-reported line-number
fix — no re-verification needed).

## Result — one convergent residual, fixed
Both experts independently converged on the same residual (perspective
convergence): mcp/token's test file keeps ONE shared check mock behind both
limiter instances, so (a) the `.check`-equality fallback in C1 step 6 is
ambiguous there, and (b) T4's "mechanical wrap" gave no instruction to produce
attribution-distinguishable limiter references for cases A vs B/C.
Testing additionally confirmed: C6 case (7) single-case coverage of Retry-After
is sufficient (both envelope constructors share `retryAfterSecondsOrDefault`,
api-response.ts:157-163); mock.results identity mechanism verified against
vitest 4.1.10 and the recovery-key/recover precedent; C6's 7 cases map onto
every helper assertion axis (steps 3/4/5/6) with no uncovered axis.

Resolution (both experts' recommended option (a) + (b)):
- T4 mcp/token carve-out: split into `mockTokenLimiterCheck`/`mockIpLimiterCheck`
  via `mockReturnValueOnce` chain in route-creation order (token :33, ip :38);
  existing shared-mock cases updated in the same sub-task.
- C1 step 6 is identity-only (`.check`-equality fallback REMOVED); callers pass
  the factory result object itself as `options.limiter`; clear throw message.
- `preArranged` removed from C1 entirely — with distinct check mocks no
  same-invocation sequencing exists in the member set (YAGNI); cases B/C
  arrange the sibling ip check `{ allowed: true }` themselves.
- vault/recovery-key/recover confirmed NOT at risk (already distinct
  `mockVerifyCheck`/`mockResetCheck` via mockReturnValueOnce).

## Recurring Issue Check (Round 3)
- Security: R42 triggered (mock-shape re-derivation surfaced the gap) — resolved
  by the carve-out; R43 no issue; RT7 [Adjacent] residual → resolved via C6
  case (5) sibling-masking + identity-only step 6.
- Testing: RT7 triggered (Retry-After axis) → C6 case (7) verified sound;
  RT1/RT8 no issue; axis-coverage table complete.

---

# Round 2 (2026-07-18)

---

# Round 2 (2026-07-18)

## Changes from Previous Round
Plan rewritten to reflect T1–T10 (member-set 18/20/21, mcp/token case map,
C1 Retry-After + mandatory limiterFactory + preArranged, C2 sub-tasks, C6
self-test, SC1 expansion, debt 42→24). Three experts re-verified incrementally.

## Summary
- Functionality: 1 Minor — mcp/token third callsite is route.ts:237 not :239
  (citation only; case design correct). FIXED in plan. All other resolutions
  verified: T1 stub lines exact, Retry-After production behavior confirmed,
  rows 16–18 verified line-for-line, 42−18=24 confirmed by exact set-difference,
  R42 recount clean (18/20/21).
- Security: 1 Major — **limiterFactory attribution gap**: "≥1 call had the
  flag" is existential over the shared factory mock; in the 2 multi-limiter
  files (mcp/token :33/:38, recovery-key/recover :49/:54) a sibling limiter's
  recorded call could mask silent flag removal on the limiter under test.
  FIXED: C1 step 6 now attributes via mock.results identity (the call that
  RETURNED options.limiter); C6 case (5) extended with the sibling-masking
  red-proof. (a)(b)(d)(e) verified clean; R43 no widening.
- Testing: 1 Major — **C6 missed the Retry-After red-proof axis** (no case
  proved the helper rejects correct-status/body with missing/corrupt
  Retry-After). FIXED: C6 case (7) added. C1 Retry-After matches production
  (api-response.ts:157-192, default 30s); preArranged vacuity double-caught
  (envelope AND mutation assertions both fail if arrangement forgotten);
  rows 16–18 mock shapes verified spyable; 21-case arithmetic confirmed by
  two partitions.

## Convergence
All Round 2 findings were plan-text defects with direct transcribed fixes;
facts underpinning the fixes were verified by the reporting experts
themselves this round (attribution mechanism realizable via mock.results —
functionality expert confirmed factory vi.fn per-call spyability; Retry-After
production behavior confirmed by testing expert). Round 3 verification is
scoped to the three edited plan passages only.

---

# Round 1 (2026-07-18)

## Changes from Previous Round
Initial review (three Sonnet experts, full review). Merge performed manually
(mechanical JSON-index join). Orchestrator independently re-verified the two
Critical claims and one disputed count before disposition.

## Summary of severities
- Critical: 2 (T1 stub-pattern baseline, T2 helper envelope/sequencing)
- Major: 4 (T3–T6)
- Minor: 4 (T7–T10)
- Rejected: 1 (security F5 — debt-count 41; orchestrator recount via raw grep
  `grep -c '^src/'` = 42, matching the plan)

## Merged Findings

### Critical

**T1. Three target route tests already stub `checkRateLimitOrFail` (C4 anti-pattern); plan Ground truth claimed a uniform clean baseline**
Perspectives: Security F1 + Functionality F3 (convergence → Critical; Security
escalate:true — orchestrator handled the escalation by direct mechanical
verification: grep confirms exactly `tenant/access-requests/[id]/approve/route.test.ts:104`,
`tenant/access-requests/[id]/deny/route.test.ts:70`, `extension/token/route.test.ts:92`
mock `@/lib/security/rate-limit-audit`; remaining 15 target files clean).
Without un-mocking, the new fail-closed case in those 3 files would assert
against a stubbed helper — production `redisErrored→503` mapping out of the
tested path (RT5) on SA-token mint / access approve/deny / extension token mint.
Resolution: plan Ground truth corrected; C2 gains an explicit un-mock sub-task
for the 3 files (restructure to keep production `checkRateLimitOrFail`).

**T2. C1 helper contract: missing Retry-After assertion (locked M14 regression) and no sequencing affordance for same-invocation multi-limiter routes**
Perspectives: Testing F1 (Critical) + Functionality F1 (Critical) + Testing F2 (Major)
(a) `serviceUnavailable()` (api-response.ts:171-174) and
`oauthTemporarilyUnavailable()` (:185-192) ALWAYS set `Retry-After` (default
30s); parent M14 locked "incl. Retry-After"; C1 dropped it.
(b) `mcp/token` has 3 `checkRateLimitOrFail(` callsites (ip :68; token
:122 authorization_code; token :239 refresh_token) over 2 limiter instances,
and its test file backs BOTH limiters with one shared `mockRateLimiterCheck` —
case B/C need `mockResolvedValueOnce` chains within one invoke(), which C1's
unconditional `mockResolvedValue` step would clobber.
Resolution: C1 asserts `Retry-After` on both families; C1 gains
`preArranged: true` (caller pre-arranges sequenced results; helper skips its
own arrange step); C2 defines 3 cases for mcp/token (both token-limiter
branches covered); case totals recounted as limiter-instance base + branch
extras.

### Major

**T3. Member-set adjudication: vault/unlock, vault/setup, webauthn/authenticate/verify plausibly in-class but silently excluded** — Security F2 + F3 (R42)
The parent roadmap's Sec 1 narrative names "Vault setup/unlock/reset/rotation/
recovery" and the class label "passkey verify" covers the raw WebAuthn
assertion-verify route. Disposition: ACCEPTED — all three added to the tranche
(verified: colocated tests exist, no rate-limit-audit mocks, 1 limiter each).
Member-set becomes 18 files / 20 limiter instances / 21 cases; debt 42 → 24.

**T4. `limiterFactory` optional = silent fail-open regression gap; only 3/18 files currently have a spyable factory mock** — Security F4 + Functionality F2
C1's factory-options assertion is the only test-level guard against silently
removing `failClosedOnRedisError: true` (parent M2 blind spot). Resolution:
`limiterFactory` becomes MANDATORY for every C2 case; the files with plain
arrow-function factory mocks are refactored to a recording `vi.fn()` wrapper
(mechanical, per-file).

**T5. R19: central `__tests__/api/extension/token-exchange-dpop.test.ts:48` and `token-refresh-cnfJkt.test.ts:53` stub rate-limit-audit for 2 member routes** — Functionality F4
Outside C4's colocated-file grep scope; they test other aspects (DPoP, cnf/jkt)
and the colocated tests carry the fail-closed contract. Resolution: recorded in
SC1 alongside mcp/authorize.test.ts (stub-pattern migration follow-up), NOT
modified in this tranche.

**T6. No RT7 red-proof for the shared helper itself** — Testing F3
A helper bug could vacuously green all 21 dependent cases. Resolution: new C6 —
helper self-test (`src/__tests__/helpers/fail-closed.test.ts`) exercising a
passing invocation plus deliberately-broken invocations (wrong status, mutation
spy called, empty assertNoMutation, missing factory option) asserting the
helper throws.

### Minor

**T7. Consumer-walkthrough wording: helper import does NOT satisfy the gate grep; only the literal `redisErrored` in each test file's own source does** — Testing F4 + Functionality F5. Resolution: wording tightened (invoke is any thunk; literal-token requirement restated as the operative mechanism).
**T8. C5 ioredis latency unspecified** — Testing F5. `getRedis` uses lazyConnect + swallowed errors; first pipeline exec against a closed port may be slow. Resolution: C5 notes the latency characteristic and permits a short `maxRetriesPerRequest`/connect-timeout override for the test client env; 30s lane timeout is headroom.
**T9. Parallel trees informational** — Testing F6. mcp-oauth-flow.test.ts / jit-workflow.test.ts mock rate-limit but assert no fail-closed behavior; no update needed (recorded).
**T10. Case-count semantics** — Testing F2 (part). "Cases" = limiter instances + mutually-exclusive branch extras, now stated explicitly in the plan.

### Rejected

**Security F5 (debt count 41)** — orchestrator recount: `grep -c '^src/'` = 42
(the expert's 41 came through a filtered pipeline). Plan arithmetic
42 − 18 = 24 updated only for the T3 member-set change.

## Escalation note
Security F1 carried escalate:true. Per skill escalation the orchestrator
assessed independently: the finding is fully mechanically confirmed (grep), no
ambiguity remains, and it merges into T1 (Critical, fix mandated). An Opus
re-run would add no information; recorded as deviation from the literal
re-run step.

## Recurring Issue Check

### Functionality expert
- R1: checked — no existing helper duplicates C1 (repo-wide grep) / R17: n/a
- R19: triggered — see T5 / R42: triggered — see T2(b), T3 / others: no issue or n/a (full text in expert output)

### Security expert
- R42: triggered — see T3 / R43: no issue (plan only adds tests/removes debt entries) / RS2: n/a
- RT5/RT7/RT8 [Adjacent]: RT5 → T1; RT7 → C5 red-proof sound; RT8 → C1 non-empty assertNoMutation sound / others: no issue or n/a

### Testing expert
- RT1: mock shape matches RateLimitResult; envelope divergence → T2(a)
- RT5: no issue (helper keeps production mapping; 15/18 baseline clean, 3 → T1)
- RT7: triggered — see T6 (helper) / C5 red-proof verified discriminating
- RT8: no issue (non-empty spy set enforced)
- R42: recount → T2(b)/T10; debt-file 42 and EXPECTED_LIMITER_COUNT=69 verified
- R44: no issue / others: no issue or n/a

---

# Phase 3: Code Review (2026-07-18)

## Round 1
- Functionality: **No findings** — C1–C6 conformance verified (21 it-blocks =
  21 helper callsites, R17 100% adoption; mcp/token and recover creation order
  verified; T1 chain traced end-to-end; snapshotFactory replay traced
  line-by-line, no fabricated data; full suite 12621 passed).
- Security: **No findings** — helper has no silent-success path; strict-identity
  attribution confirmed; T1 un-mock verified in all 3 files (+ ip-rate-limit
  un-mock in extension/token); C3 removal set byte-identical to plan; R43 sweep:
  zero removed expect() lines across all 18 diffs; sampled routes reach the
  limiter through genuine gate traversal.
- Testing: 2 Major + 1 Minor —
  **P3-F1 (Major)**: all 18 files satisfied the gate's redisErrored grep via
  comments only; false-green demonstrated (deleting the helper call left the
  literal). **P3-F2 (Major)**: C6 case 6 rejected via factory-attribution, not
  the limiter-reached axis (falsified by scratch-copy mutation test).
  **P3-F3 (Minor)**: mcp/token's 3 cases shared one comment literal.

## Fixes (Round 1 → Round 2)
- P3-F1/F3: `assertRedisFailClosed` gained REQUIRED
  `failure: RateLimitResult & { redisErrored: true }`; all 21 callsites pass
  the fixture inline as type-checked code; literal-carrying comments deleted.
  Negative proof: scratch copy minus the callsite contains no redisErrored
  literal (gate would re-flag).
- P3-F2: case 6 rebuilt — registered limiter + invoke returning a correct
  canonical 503 without calling check; scratch-copy discrimination proof:
  removing step 3 in a copied helper makes the case pass, so step 3 is the
  sole discriminator.

## Round 2 (Testing, targeted)
**No findings.** Helper failure param verified required and load-bearing; all
18 files' redisErrored occurrences are code literals (or incidental comments
alongside code); case 6 isolates step 3; helper self-test 10/10; 18 files
304/304; gate exit 0; plan C1/C2/C6 text consistent.

## Phase 3 convergence
Functionality R1 clean / Security R1 clean / Testing R2 clean.
Final gates: full vitest 964 files 12621 passed; integration lane 88 files
351 passed; next build exit 0; pre-pr 43 checks passed (pre-fix run) — commit
proceeds; pre-pr re-runs at PR time per repo convention.
