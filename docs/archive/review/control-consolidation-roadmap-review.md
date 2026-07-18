# Plan Review: Control Consolidation Roadmap
Date: 2026-07-18
Review round: 4 — CONVERGED (Rounds 1–3 preserved below)

---

# Round 4 (2026-07-18) — final targeted verification

## Changes from Previous Round
The plan gained the "# Review Round 3 amendment" section (single bullet, R3-1).
Delta touches Testing scope only; Functionality and Security already returned
No findings in Round 3 on surfaces unchanged since, so Round 4 ran the Testing
expert only (targeted iteration).

## Result
**No findings.** Verified: (a) citations exact — authorize.test.ts:45-47 mocks
checkRateLimitOrFail directly; the only `redisErrored` occurrence is a
describe-label string (:345); the gate is a pure literal-token grep with no
vi.mock inspection; (b) no overclaim — the amendment states convention-only
enforcement until structural detection ships; (c) the structural-detection
sketch is plausible in the existing grep-based gate style.
- RT1/RT5/RT7: triggered by the delta's subject matter and correctly resolved
  by the amendment text; R42: n/a (single documented instance; the class-count
  question is separately handled by Sec 1's 69-callsite derivation and the
  M2 "migration policy for the 20 already-tested routes" deliverable).

## Convergence
- Functionality: No findings (Round 3)
- Security: No findings (Round 3)
- Testing: No findings (Round 4)
Phase 1 plan review complete after 4 rounds.

---

# Round 3 (2026-07-18)

## Changes from Previous Round
The plan gained the "# Review Round 2 amendments" section (seven bullets,
R2-1 … R2-7). Round 3 re-verified those amendments (three Sonnet experts,
incremental review).

## Summary of severities
- Critical: 0 / Major: 0 / Minor: 1 (R3-1, Testing)
- Functionality: **No findings** — R2-2's route citations re-verified exact
  (personal restore fail-closed via assertCurrentKeyVersion inside the tx with
  rollback; team restore genuinely unguarded at :95-109); no contradiction with
  Round 1 sections; amendments touch disjoint surfaces.
- Security: **No findings** — R2-3 premise confirmed (worker grant = SELECT,
  DELETE only; UPDATE grant absent), R2-4 additive, all seven bullets
  additive/narrowing, R43 clean.
- Testing: R2-1/R2-5/R2-6/R2-7 all resolved and re-verified against the repo
  (mobile-dpop-flow is the sole file in src/__tests__/integration/ with the
  suffix — lone drift instance, no external references to the filename; both
  R2-5 fixture precedents match exactly; vaultKey.updateMany example real at
  src/auth.ts:136), with one residual:

## Merged Findings

### Minor

**R3-1. R2-6's return-value-stub prohibition has no CI-enforceable backstop** — Testing
mcp/authorize.test.ts:45-47 mocks `checkRateLimitOrFail` directly (the exact
anti-pattern to prohibit) and satisfies the gate's `redisErrored` presence grep
via a describe-label string alone (:345). The prohibition therefore lives as
convention/code-review only until the Sec 1 implementation adds structural
detection. The amendment does not overclaim enforcement, but the plan should
state the enforcement mechanism explicitly.
Resolution: recorded in the plan as "# Review Round 3 amendment (R3-1)".

## Recurring Issue Check (Round 3)

### Functionality expert
- R3: no issue (both restore citations re-verified by file read) / R42: no issue (personal-vs-team guard membership re-derived from grep of assertCurrentKeyVersion/KeyVersionMismatchError, not prose) / R43: no issue (R2-2 narrows, does not widen)
- All other rules: no issue or n/a for this documentation-only delta (full per-rule list in expert output; no triggers).

### Security expert
- R42: no issue (no new class-shaped claims; prior counts reconfirmed) / R43: no issue (verified directly — no Round 2 amendment removes/loosens/defers any Round 1 mandate; all additive or narrowing) / RS1–RS6: no issue
- All other rules: no issue or n/a for this delta (no triggers).

### Testing expert
- RT1: investigated — R2-1's proposed enumeration gate non-vacuous (pure glob); R2-5 fixtures non-vacuous; R2-6's newly scoped prohibition lacks a gate → R3-1
- RT5: no drift (both fixture citations match exactly) / RT7: triggered — see R3-1 / RT8: no issue (R2-1 gate fits scripts/checks/* pattern; no new CI wiring for R2-5/R2-7)
- R42: applied — gate member-set re-derived from script logic (:90-108, :159-164), surfacing R3-1
- All other rules: no issue or n/a for this delta.

---

# Round 2 (2026-07-18)

## Changes from Previous Round
Round 1 findings M1–M14 were addressed via the plan's "Review Round 1 amendments"
section. Round 2 re-verified every amendment against the actual repository
(three Sonnet experts, incremental review). Merge performed manually (mechanical
JSON-index join; no cross-expert duplicates — 7 findings, 0 overlapping roots).

## Summary of severities
- Critical: 0
- Major: 1 (R2-1)
- Minor: 6 (R2-2 … R2-7)
- All Round 1 amendments verified **correct and complete**; no regression,
  no boundary widening (R43 clean), all quantitative claims (69/62/3, 24=13+11,
  EXPECTED_LIMITER_COUNT=69) independently recomputed exact.

## Merged Findings

### Major

**R2-1. mobile-dpop-flow.integration.test.ts: fully-mocked test silently excluded from the mandatory unit lane (filename-suffix drift)** — Testing F1
`vitest.config.ts:14` excludes `src/**/*.integration.test.ts` repo-wide;
`vitest.integration.config.ts:8` includes the same glob repo-wide. The file sits in
`src/__tests__/integration/` (the mocked unit-lane directory, 4 plain `*.test.ts`
siblings) but carries the `.integration.test.ts` suffix — 12 `vi.mock` calls
(prisma/redis/crypto-server), no real DB dependency. It therefore runs ONLY under
`npm run test:integration` and is absent from `npx vitest run` (CLAUDE.md Mandatory
Checks). Live instance of exactly the drift class M10 warns about.
Action: rename (drop `.integration.` infix) or relocate; add a gate check
enumerating `*.integration.test.ts` outside `db-integration/`.

### Minor

**R2-2. Sec 6/M3(d) conflates personal and team history-restore routes** — Functionality F1
Personal restore (`passwords/[id]/history/[historyId]/restore/route.ts:80`) already
fails closed via `assertCurrentKeyVersion` → KEY_VERSION_MISMATCH. The actual
unguarded gap is the TEAM restore route
(`teams/[teamId]/passwords/[id]/history/[historyId]/restore/route.ts:95-109`), which
unconditionally writes back the stale `teamKeyVersion`. Scope Sec 6's re-encrypt
contract to the team surface; personal route needs no action.

**R2-3. Sec 7: grant migration not a named deliverable; silent zero-row no-op undetected** — Security F1
`passwd_retention_gc_worker` currently holds only SELECT, DELETE on `access_requests`
(migration 20260619001000 …:9) — the required UPDATE grant does not exist yet, and the
repo's own precedent (retention-gc-worker/index.ts:51-55) shows an under-granted
NOBYPASSRLS worker silently updates 0 rows without erroring. Action: list the
column-scoped UPDATE grant migration as its own checklist item; emit a worker
log/metric when updated===0 on a nonzero expired-PENDING candidate set.

**R2-4. Sec 8: new PAT is a release-availability dependency with no lifecycle plan** — Security F2
Fail-closed publish gating on a live `gh api` read means PAT expiry/revocation
silently blocks all releases. Action: add PAT-expiry monitoring/rotation note.

**R2-5. Sec 1: "spy on createRateLimiter options" omits the module-load-time constraint** — Testing F2
`createRateLimiter` runs at module top level on first import (vault/unlock/route.ts:27-31);
a post-import `vi.spyOn` records zero calls without failing (new RT1/RT7 vacuity).
Action: require the repo's `vi.hoisted()` + `vi.mock` factory-wrapper mechanic
(vault/unlock/route.test.ts:14-30), or replace the spy with the behavioral proof in
rate-limiters.test.ts:44-49 (mock getRedis→null, assert redisErrored:true).

**R2-6. Sec 1/4: gate co-evolution ask is narrower than stated** — Testing F3
check-fail-closed-routes-have-test.sh:159-164 already gates on the
`checkRateLimitOrFail(` callsite count (the co-evolved mechanism), and the amended
mock fixture still contains the literal `redisErrored` token, so the test-existence
grep (:98,:101) remains valid under the corrected contract. Scope the remaining ask
to prohibiting the return-value-stub anti-pattern only.

**R2-7. Sec 1: assertNoMutation write-primitive enumeration is per-route, unspecified** — Testing F4 [Adjacent→Functionality, accepted]
Mechanic proven (vi.hoisted + vi.mock("@/lib/prisma") spies); the open task is
enumerating which write primitive constitutes "the mutation" per route family
(e.g. vaultKey.updateMany for unlock vs token-mint inserts for MCP token routes).
The Sec 1 implementation plan must carry that per-route table.

## Quality Warnings
None (manual merge; all findings carry file:line evidence).

## Adjacent Findings
- Testing F4 routed to Functionality — accepted as R2-7.
- Security F1 flagged adjacent (observability/testing overlap) — merged as R2-3.

## Recurring Issue Check (Round 2)

### Functionality expert
- R1–R2: no issue / R3: no issue (restore claims re-verified both routes; attribution sharpened via R2-2) / R4–R6: no issue / R7–R8: n/a / R9–R10: no issue / R11: n/a
- R12: no issue (AUDIT_ACTION re-confirmed CREATE/APPROVE/DENY only) / R13: n/a / R14: no issue / R15: n/a / R16: no issue / R17: no issue (69/62/3 recomputed exact) / R18: no issue / R19–R21: n/a / R22: no issue / R23–R26: n/a / R27: no issue / R28: n/a / R29–R36: no issue (R31 no issue, R35 n/a) / R37: n/a / R38: no issue / R39: n/a / R40–R41: no issue
- R42: no issue — both class-membership claims recomputed exact (69 callsites/62 files/3 out-of-scan; 24=13+11 debt split; all 13 inline names verbatim in pre-pr.sh:204-437)
- R43–R44: no issue

### Security expert
- R1–R11: no issue (R4, R7, R8, R11 n/a) / R12: no issue (audit.ts re-grepped) / R13: no issue / R14: no issue (M6 mandate re-verified) / R15: n/a / R16–R19: no issue / R20–R21: n/a / R22: no issue / R23–R26: n/a / R27: no issue / R28: n/a / R29: no issue / R30: n/a / R31–R36: no issue / R37: n/a / R38: no issue (approve-side guard unaffected) / R39–R41: no issue
- R42: triggered (check performed) — member-set recomputed over src/app/api + src/lib + src/auth.config.ts; auth.config.ts:18 confirmed real out-of-scan member; no additional members beyond the 3 named
- R43: no issue — no amendment widens a boundary; Sec 8 PAT narrower than existing contents:write token
- R44: no issue
- RS1: no issue / RS2: no issue (M5 hardening scope confirmed complete) / RS3: no issue (member-key/route.ts:46) / RS4–RS6: no issue

### Testing expert
- R1–R2: no issue / R3–R4: n/a / R5–R6: no issue / R7–R8: n/a / R9–R10: no issue / R11: n/a / R12: no issue / R13–R15: n/a / R16–R18: no issue / R19: no issue (M12 verified) / R20–R21: n/a / R22: no issue / R23–R26: n/a / R27: no issue / R28: n/a / R29–R30: no issue / R31–R32: n/a / R33–R34: no issue / R35: n/a / R36: no issue / R37: n/a / R38–R40: n/a / R41: no issue
- R42: no issue (counts re-verified exact) / R43: n/a / R44: no issue
- RT1: triggered — see R2-5 / RT2: no issue (VC1–VC3 hold) / RT3: no issue / RT4: n/a
- RT5: no issue — amended helper contract keeps production checkRateLimitOrFail mapping in the tested path
- RT6: n/a / RT7: triggered — see R2-1, R2-6 / RT8: no issue (assertNoMutation wireable via existing convention) / RT9: no issue

---

# Round 1 (2026-07-18)

## Changes from Previous Round
Initial review. The plan is an externally-produced investigation report pasted into
/triangulate, reviewed as a roadmap. Orchestrator pre-verified its factual claims
(all counts/TODOs accurate); three experts then reviewed the substance against the
real repo. Merge performed by local LLM (gpt-oss:120b); three findings dropped by
the merger were manually restored (M12, M13, M14) from the Testing expert's output.

## Summary of severities
- Critical: 2 (M1 vacuous denial-path helper, M2 fail-closed class unpinned)
- Major: 9 (M3–M9, M12, M13)
- Minor: 3 (M10, M11, M14)
- Pre-screen (local LLM, addressed as plan amendments): 3 Major, 2 Minor

Overall verdict: the report's diagnosis and priorities are sound and factually
accurate (every count, file, and TODO checked out), but its three flagship
prescriptions (Sec 1 helper, Sec 2 endpoint split, Sec 4 gate extraction) are
under-specified in exactly the ways that would make the resulting controls
vacuous or regressive. All are fixable at plan level; amendments recorded in
the plan's "Review Round 1 amendments" section.

---

## Merged Findings

### Critical

**M1. Fail-closed helper: no mutation-absence / limiter-reached assertion (vacuous denial path)**
Perspectives: Security F2 + Testing F2 (convergence → severity floor Critical, RT8)
`assertRedisFailureIsFailClosed` verifies only 503 + error code. No assertion that the
guarded mutation did not execute, none that the mocked limiter was reached. The 42 debt
routes are exactly the RT8 Critical class (token mint/refresh, passkey verify, vault
recovery/reset, approve/deny). A handler that mints the token before the limiter check
still passes. Action: helper must take a mandatory `assertNoMutation` hook (write-primitive
spies asserted not called) and internally assert the limiter was invoked.
Evidence: src/lib/security/rate-limit-audit.ts:239; src/__tests__/api/mcp/authorize.test.ts:361-366.

**M2. Fail-closed class definition, gate scope, and enforcement mechanism unpinned**
Perspectives: Functionality F1 + Security F1 + Testing F3 + Testing F5 (4-way convergence)
The plan treats "42 debt routes" as the class; the code-derived class is 62 route files /
69 limiter callsites, plus 3 members outside the gate's scan root entirely
(src/auth.config.ts:21 magicLinkEmailLimiter — silent-drop contract, not expressible by the
helper signature; src/lib/security/rate-limiters.ts:19; src/lib/scim/rate-limit.ts:17 —
gate scans only src/app/api, check-fail-closed-routes-have-test.sh:81). The gate keys the
class off the literal `failClosedOnRedisError`/`redisErrored` greps, so REMOVING the opt-in
from a route simultaneously greens the mocked test and removes the route from gate scope —
silent fail-open with all controls green. Debt is per route file but enforcement class is
per limiter callsite (EXPECTED_LIMITER_COUNT=69, line 151): one helper call greens a
multi-limiter file. Canonical existing test (authorize.test.ts:350-368) stubs
checkRateLimitOrFail itself — the production redisErrored→503 mapping is out of the tested path.
Action: (1) pin the fail-closed set in a committed manifest so opt-in removal requires an
exemption diff; (2) helper spies on createRateLimiter options to assert failClosedOnRedisError:true;
(3) burn-down unit = limiter callsite (69), not route file (42); (4) extend gate scan root
to src/lib + auth.config.ts and add a silent-drop helper variant; (5) define migration
policy for the 20 already-tested routes; (6) ≥1 integration-CI test against real broken
Redis for the 第1群 routes, red-proven.

### Major

**M3. Sec 2: history-restore violates the pairing invariant by design; dedicated endpoint must inherit the full PUT guard set**
Perspectives: Functionality F3 + Functionality F7 + Security F3 + Security F4
(a) passwordEntryHistory stores no overview columns; restore overwrites blob/iv/authTag/
keyVersion/aadVersion only (restore/route.ts:117-127) — post-restore, overview and blob
diverge: the exact state Sec 2 claims to eliminate. Extend snapshots to include overview,
or scope the invariant to the PUT surface and document restore as sanctioned divergence
with client-side re-derivation. (b) The proposed passkey-counter endpoint is a
full-capability blob write path with a narrower name; it must replicate: PASSWORDS_WRITE
scope + rate limit (route.ts:88-93), 403→404 oracle collapse (:116-119), keyVersion CAS
inside FOR UPDATE (:173-175, :212-226 — absence permanently bricks freshly rotated blobs),
history snapshot + trim (:230-251), ENTRY_UPDATE audit (:277-282). (c) Team PUT already
enforces bidirectional all-or-none, and v1 shares updateE2EPasswordSchema — the v1 caveat
is about consumers, not schema. (d) Restore old-key re-encrypt contract (restore
route.ts:95-106 comment) is unimplemented client-side → rotation+restore leaves the live
entry undecryptable on every surface; Sec 6 must include it.

**M4. Sec 4: inline-gate migration lacks control-continuity; targets arithmetically off**
Perspectives: Functionality F5 + Security F6 + Testing F4 + Testing F9
Deleting an inline gate together with its debt line, without landing the extracted
check-*.mjs, is invisible to the meta-gate — "13→0" is satisfied equally by extraction and
deletion, on security gates (RLS cross-tenant parse, master-key rotation CAS, ...). The
debt=0 criterion for Sec 1 rests on a literal `redisErrored` grep
(check-fail-closed-routes-have-test.sh:98,101) that the shared helper both defeats and is
defeated by. Self-test "100%" is existence-based (check-gate-selftest-coverage.sh); red
fixtures, FIXTURE_ROOT seam, and atomic inline-removal are unstated. 24→"10以下" is
unreachable via Sec 4 alone: 11 path entries remain (incl. check-security-matrices.sh,
justified to stay). Action: one-to-one migration manifest checked by the meta-gate;
red-proof fixture required before inline removal; co-evolve the fail-closed gate to
recognize the helper callsite token; fix target to 11 or name the extra entry.

**M5. Sec 6: member-key endpoint already exists; real gap is client wiring + missing controls on the existing route**
Perspectives: Security F5 + Security F10 + Testing F10 + Functionality F3-note (RS2)
GET /api/teams/[teamId]/member-key already accepts keyVersion with range validation and
is route-tested; the TODO is client-side only (entry-history-section.tsx:188-193). The
EXISTING route has no rate limiter, no Cache-Control: no-store (global headers carry no
cache directives), and no audit on key-material responses — while the plan lists those as
constraints for a route it assumes must be built. Action: rescope Sec 6 to client wiring
+ hardening of the existing route (per-user limiter, no-store on all responses, audit
emit, revoked-member denial tests with mutation-absence).

**M6. Sec 7: raw UPDATE bypasses bulkTransition SSoT; worker grant minimality unspecified**
Perspectives: Security F8 (R1/R14)
The sketched raw UPDATE bypasses the compile-checked transition MATRIX and the
hasScopeUnderBypass cross-tenant defense built into bulkTransition
(access-request-state.ts) — in a bypass-RLS worker context both guards are lost. Action:
mandate bulkTransition({actor: AR_ACTOR.SYSTEM}) with explicit per-batch tenantId
predicate; column-scoped UPDATE grant for the worker role.

**M7. Sec 8: branch-protection check needs admin-read token; failure direction and detective-only window unspecified**
Perspectives: Security F7
Default GITHUB_TOKEN cannot read branch protection; the natural path provisions an
admin-capable PAT — a credential that can rewrite the protection it monitors. Action:
fine-grained PAT, "Administration: Read-only", single repo; API error/absence = check
FAILURE; gate the release workflow on a fresh protection check (detective→preventive at
the publish boundary).

**M8. Sec 2: no version-skew migration plan for deployed extensions**
Perspectives: Functionality F2
Immediate pairing enforcement rejects deployed extensions' blob-only counter persist
(extension/src/background/passkey-provider.ts:270-284, soft-fail :290-298) → same counter
re-presented next sign-in → strict RPs reject as clone-suspect. Action: staged rollout
(endpoint first, extension migration release, version floor + grace period, independent
enforcement flag for rollback).

**M9. Sec 3: Node runtime class misses cli/package.json engines (npm consumer contract)**
Perspectives: Functionality F4 (R42)
cli/package.json:20-22 `"engines": {"node": ">=20"}` is the only runtime contract reaching
npm consumers; extension/package.json has none. Action: add `consumerRuntime` to the role
table and to the proposed consistency gate.

**M12. Sec 1: example mock shape does not match production RateLimitResult**
Perspectives: Testing F1 (RT1/R19) — dropped by LLM merger, restored
The plan's `{success:false, redisErrored:true}` has no `success` field in reality:
`{ allowed: boolean; retryAfterMs?; redisErrored?: true }` (rate-limit.ts:28-39, Redis-error
path :161). Masked because checkRateLimitOrFail branches on redisErrored before allowed.
Action: helper mock contract = exported RateLimitResult type, fixture
`{ allowed: false, redisErrored: true }`.

**M13. Sec 9: risk-tier thresholds vacuous — named critical paths outside coverage.include**
Perspectives: Testing F7 — dropped by LLM merger, restored
Per-path thresholds are supported (vitest.config.ts:60-70) but collection is an allowlist
(:17-56); vault/**, tenant-rls.ts, prisma.ts, most of security/**, workers/** are not in
it — thresholds there measure nothing. check-vitest-coverage-include.mjs checks only path
existence. Action: pair the tier table with an explicit coverage.include expansion and add
a "every thresholds key matched by an include glob" rule + red self-test.

### Minor

**M10. Sec 5: derivation failure direction + registry↔migrations (not production) scope + lane placement**
Perspectives: Security F9 + Testing F8
Derivation error must fail CI (no skip-on-error), with a nonzero-RLS sanity floor.
Guarantee is "registry consistent with migrations" (CI DB = prisma migrate deploy);
production drift belongs to Sec 10 runtime health. Reconciliation test must be named
`*.integration.test.ts` under db-integration (src/__tests__/integration/ is the mocked
UNIT lane) — same trap applies to Sec 7 CAS tests.

**M11. Sec 7: ACCESS_REQUEST_EXPIRED audit action registration not costed**
Perspectives: Functionality F6 (R12)
AUDIT_ACTION has CREATE/APPROVE/DENY only (audit.ts:163-165); new action requires group
array + i18n + UI label map + test registration.

**M14. Sec 1: single expectedErrorCode string cannot express the 503 envelope families**
Perspectives: Testing F6 — dropped by LLM merger, restored
FailClosedEnvelope union: canonical {error:"SERVICE_UNAVAILABLE"} vs OAuth
{error:"temporarily_unavailable"} (+Retry-After, −error_description) vs custom
(rate-limit-audit.ts:38-41); mcp/register|revoke|token in the debt list use the OAuth
family. Action: envelope-aware helper parameter.

## Pre-screen findings (local LLM, gpt-oss:120b — addressed via plan amendments)
1. [Major] Sec 2 consumer inventory incomplete (iOS/desktop/CLI users of the passwords API).
2. [Major] Sec 7 no client notification/cache-invalidation strategy for PENDING→EXPIRED.
3. [Major] Sec 1 helper must reuse existing shared test utilities.
4. [Minor] Sec 6 stale cached history entries post-rotation not addressed.
5. [Minor] Sec 1 non-route Redis dependents (CLI/workers/internal) unmapped.

## Verified-sound points (no finding)
- Sec 7 fail-open direction safe: approve gates expiresAt both pre-check and atomically in
  the transition predicate (approve/route.ts:116-117, :152, :169) — a dead worker does NOT
  leave expired requests approvable.
- Sec 6 revoked-member exposure: membership filter + TeamMemberKey row deletion on removal;
  keyVersion bounded 1..10000.
- Sec 3 release trust-domain split already implemented (release.yml:40-42,120-124).
- Sec 4 inline gate enumeration exact (13, names match pre-pr.sh:204-437).
- All quantitative claims in the report verified accurate (42/24/13/nvmrc/engines/node22/TODOs).

## Quality Warnings
merge-findings quality gate: no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags. All findings
carry file:line evidence.

## Adjacent Findings
- Testing F10 / Security F10 (member-key endpoint already exists) — routed to
  Functionality; confirmed and merged into M5.

## Recurring Issue Check

### Functionality expert
- R1: no issue / R2: no issue
- R3: triggered — see M3
- R4: no issue (pre-screen #2) / R5: no issue / R6: no issue / R7: n/a / R8: n/a / R9: no issue / R10: no issue / R11: n/a
- R12: triggered — see M11
- R13: n/a / R14: no issue / R15: n/a / R16: no issue
- R17: triggered — see M2
- R18: no issue / R19: n/a / R20: n/a / R21: n/a / R22: no issue / R23–R26: n/a / R27: no issue / R28: n/a / R29: no issue / R30: no issue / R31: no issue / R32: no issue / R33: no issue / R34: no issue / R35: n/a / R36: no issue / R37: n/a
- R38: no issue (approve-side expiry check verified implemented)
- R39: n/a / R40: no issue / R41: no issue
- R42: triggered — see M2, M9
- R43: no issue / R44: no issue

### Security expert
- R1: triggered — see M6
- R2: no issue
- R3: triggered — see M3
- R4–R6: no issue / R7: n/a / R8: n/a / R9: no issue / R10: no issue / R11: n/a
- R12: no issue (AR MATRIX compile-exhaustive)
- R13: no issue
- R14: triggered — see M6
- R15: n/a / R16: no issue / R17: no issue / R18: no issue / R19: no issue / R20: n/a / R21: n/a / R22: no issue / R23: n/a / R24: n/a / R25: no issue / R26: n/a / R27: no issue / R28: n/a / R29: no issue / R30: n/a / R31: no issue / R32: no issue / R33: no issue / R34: no issue / R35: no issue / R36: no issue / R37: n/a
- R38: no issue (approve gates expiry atomically — verified)
- R39: no issue / R40: no issue / R41: no issue
- R42: triggered — see M3 (blob-writer class); fail-closed class 62/42 and 13-inline recomputed clean
- R43: no issue / R44: no issue
- RS1: no issue
- RS2: triggered — see M5
- RS3: no issue (keyVersion bounded at member-key/route.ts:46)
- RS4: no issue (.env* untracked — verified)
- RS5: no issue
- RS6: no issue

### Testing expert
- R1: no issue (pre-screen #3 covers helper reuse)
- R2: no issue
- R3–R15: n/a
- R16: no issue (Sec 3 addresses env-drift Node 22 vs .nvmrc 20 directly)
- R17: triggered — see M2
- R18: no issue
- R19: triggered — see M12
- R20: n/a / R21: n/a
- R22: no issue
- R23–R26: n/a
- R27: no issue / R28: n/a / R29: no issue / R30: no issue / R31: n/a / R32: n/a
- R33: no issue / R34: no issue / R35: n/a / R36: no issue / R37: n/a
- R38: no issue (Sec 7 EXPIRED design is functionality scope)
- R39: n/a / R40: n/a
- R41: no issue
- R42: triggered — see M2
- R43: n/a
- R44: no issue (gate scripts examined use set -euo pipefail, no piped exit reads)
- RT1: triggered — see M12
- RT2: no issue (VC1-VC3 acknowledged; all proposed tests testable in a declared lane)
- RT3: no issue
- RT4: n/a (no race tests proposed; Sec 7 CAS is integration-lane, noted in M10)
- RT5: triggered — see M2
- RT6: n/a (roadmap, no diff)
- RT7: triggered — see M4
- RT8: triggered — see M1
- RT9: triggered — see M4
