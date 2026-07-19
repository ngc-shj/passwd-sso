# Code Review: fail-closed-tranche2
Date: 2026-07-19
Review round: 1

## Changes from Previous Round
Initial code review over the working-tree diff (`git diff main`) — 58 files:
gate/classifier/self-tests, C1 helper variant, C7 stub migration, 35 C2
route tests, C8 (v1 production + SCIM + magic-link), C10 integration, manifest,
debt burn-down. Phase 2 mandatory checks (vitest 12728 pass, next build,
pre-pr 43/43) and mechanical R-hooks were green before this round.

## Functionality Findings
No findings. All 6 verified items correct: C8c v1 routes preserve 429/success
paths (only 503-on-redisErrored is new); 3 comment rewordings are logic-neutral;
D1 dangling-check fix builds ENUM_LIST once and repoints correctly; classifier
output contract preserved (dynspec appended, key-based awk extraction unaffected);
Implementation Checklist fully present (manifest + C10 are untracked CREATE
files); debt=0, manifest=65 (62 api sum 69 + 3 lib), legacy=16.
Non-defect note: `git add` the untracked manifest + C10 test before PR.

## Security Findings
### F1 — [Major] Aliased `vi` named-import escapes stub detection — RESOLVED
`scripts/checks/classify-fail-closed-test.mjs:143` — `resolveMockCallee` gated
on `target.getText() === "vi"` BEFORE the symbol comparison, so
`import { vi as viz } from "vitest"; viz.mock(".../rate-limit-audit")` yielded
`mock=0` and escaped all three stub guards (STUB_MOCKED_RATE_LIMIT_AUDIT,
MAPPING_MOCKED_CONTRACT_TEST, STUB_DYNAMIC_SPECIFIER). A bare auto-mock of
rate-limit-audit via aliased `vi` neutralizes the production checkRateLimitOrFail
mapping → a helper-mode "fails closed" test passes vacuously while the route
could silently fail-open. Contradicted the plan's "alias-aware" claim; no
aliased-named-vi red fixture existed. Live-verified by the reviewer
(mock=0 before). Escalate: no (latent; no current file uses the shape).

All OTHER evasion vectors verified CLOSED by live construction: AST-authoritative
per-file count (comment-literal spoof → MANIFEST_COMMENT_LITERAL); global-vi /
namespace-vi / relative-specifier / doMock / import()-typed / dynamic-specifier
/ shadowed-vi all correctly classified; STUB_CONFIG_SEAM catches alias redirect;
frozen 4-file exemption is hardcoded (legacy growth cannot license a stub);
ratchets in both guard sites; C8c leaks only infra-outage class; C8b asserts
real emission not a stub. R42 convergence artifact SATISFIED (gate enumerates
from the defining primitive, self-test red-proven, wired into pre-pr.sh).

## Testing Findings
No findings. RT5 clean (only the 4 frozen tenant/* stubs remain); RT8 every
assertNoMutation carries a meaningful reachable spy (D4 substitutions sound);
snapshotFactory present in every clear-mocks file (2× in multi-limiter files);
RT4 C10 switchable getRedis + throttle-reset sound, C8b real emission; RT7 gate
+ classifier self-tests red-proven for every new token; D2 interim→clean flip
correct. Mutation-proof: flipping the flag off makes a fail-closed test fail at
factory-attribution (non-vacuous). 93 self-tests + representative C2 batch pass.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1-R44: no misses. R42 member-set (62=18∪13∪31, 65 manifest, 69 sum) re-derived
and consistent. R44 gate exit read directly (no pipeline mask). No findings.

### Security expert
R1-R44 / RS1-RS6: only RT5-evasion sub-case (F1, aliased vi) triggered; R42
convergence artifact satisfied. No other recurring issues.

### Testing expert
R1-R44 / RT1-RT9: RT4/RT5/RT7/RT8 all verified clean; no misses.

## Environment Verification Report
Plan declared VC3 (Redis-failure fail-closed testable local + CI):
- Unit lane (35 C2 cases + helper/gate/classifier self-tests): `verified-local`
  (`npx vitest run` — 12728 pass, 1 skip).
- Integration lane (C10): `verified-local` (`npm run test:integration --
  rate-limit-fail-closed-routes` → 4 pass with REDIS_URL set; 2 pass + 2 skip
  without — red-proof cases skip via redisAvailable guard, broken-Redis cases
  run). `verifiable-CI` in ci-integration.
No `blocked-deferred` paths.

## Resolution Status
### F1 [Major] Aliased vi named-import escapes stub detection
- Action: rewrote `resolveMockCallee` Identifier branch to resolve by symbol
  (`sym === viImportSymbol`, alias-aware) when a named `vi` import exists,
  falling back to raw-text `"vi"` only for the bare-global (no-import) case;
  shadow-detection preserved (a same-text `vi` binding elsewhere → fail-loud).
  Added 2 red fixtures (aliased `viz.mock` + `viz.doMock` → mock=1) to
  `scripts/__tests__/classify-fail-closed-test.test.mjs`.
- Modified: scripts/checks/classify-fail-closed-test.mjs:141-163,
  scripts/__tests__/classify-fail-closed-test.test.mjs (+2 cases)
- Verified: live classify of aliased fixture → mock=1 (was mock=0); classifier
  self-test 32/32; gate self-test 41/41; real-repo gate green (EXIT=0, no
  false-positive).

---

# Code Review Round 2
Date: 2026-07-19

## Changes from Previous Round
F1 (aliased-vi stub-detection evasion) fixed in
scripts/checks/classify-fail-closed-test.mjs + 2 red fixtures. Round 2 is a
mandatory security-boundary re-review (Step 3-8) of that single fix.

## Result: No findings — F1 resolved, no regression
Security expert verified live across 10 shapes:
- aliased viz.mock / viz.doMock → mock=1 (fixed); plain-named / global /
  namespace vi → mock=1 (no regression); local-shadow → fail-loud
  (VI_SHADOWED); legit `vi.mock("@/lib/prisma")` → mock=0 (no false positive);
  aliased-import + separate object → mock=0, no crash.
- R43: pure tightening, no boundary widening; real-repo gate EXIT=0 (no new
  false positive over 100+ test files).
- Red-proven: both new fixtures give mock=0 on the `main` classifier, mock=1
  on the fixed one — non-tautological.
- Regression: 73 self-tests pass; gate EXIT=0.

## Documented residual (not a finding)
Cross-file re-export aliased to a non-"vi" name
(`import { myvi } from "./helper"; myvi.mock(...)`) → mock=0 in BOTH old and
new classifier — an inherent limit of single-file in-memory parsing (the
classifier cannot follow cross-file re-exports), explicitly out of the gate's
"vi must resolve to the vitest package via a same-file import" design scope.
R43-clean: the fix neither introduced nor widened it. Contrived; accepted.

## Convergence
Phase 3 converged in 2 rounds: Round 1 (Func/Test No findings, 1 Security
Major) → fix + red fixture → Round 2 (No findings). All contracts C1–C10
implemented and verified. R42 class convergence artifact
(check-fail-closed-routes-have-test.sh, mutation-verified self-test, wired
into pre-pr.sh) is the mechanical guard that keeps the class closed.

---

# Code Review Round 3 (external-review follow-up)
Date: 2026-07-19

## Changes from Previous Round
Two external reviews (post-push) raised one convergent Major: the gate verified
test coverage only for src/app/api routes, so the 3 non-route members
(auth.config.ts, scim/rate-limit.ts, rate-limiters.ts) had their opt-in flag
manifest-pinned but their fail-closed TESTS unclassified — test drift
(delete/stub the test) stayed green. See deviation D9.

## Fix
scripts/checks/check-fail-closed-routes-have-test.sh: new "Non-route member
coverage" block iterates whole-src ENUM_LIST members outside src/app/api, maps
each to its contract test via a hardcoded NON_ROUTE_TEST_MAP (SCIM's contract
is non-adjacent: with-scim-auth.test.ts), classifies with the AST classifier,
applies helper/legacy/debt modes. New token NON_ROUTE_COVERAGE_UNMAPPED forces
a new non-route opt-in to declare its test. 5 red-proven self-test fixtures
(gate self-test 41→46). Manifest header + D9 document it.

## Security re-review: No findings — gap resolved, no regression
Independently reproduced all 4 ex-false-greens now failing with the right token
(LEGACY_TEST_MISSING ×2, MAPPING_MOCKED_CONTRACT_TEST, NON_ROUTE_COVERAGE_UNMAPPED).
R43 pure tightening (zero false-positive on the 3 real members). Regression-free:
gate self-test 46 pass, real gate EXIT 0, meta-gate EXIT 0, pre-pr 51/51.

## Adjudicated Low observations (no change)
- STALE_LEGACY asymmetry: the non-route helper-mode branch does not force
  atomic legacy-entry removal, UNLIKE the route loop. This is deliberate, not
  lax: SCIM (scim/rate-limit.ts) currently rides BOTH a helper test AND a
  legacy entry because helper mode is not yet the canonical mode for non-route
  members (plan SC-T3-6, deferred). Adding STALE_LEGACY_ENTRY here would force
  SCIM's legacy entry off and break EXPECTED_LEGACY_COUNT=16. Left as-is by
  design; revisited when SC-T3-6 makes non-route helper mode canonical. Cannot
  false-green real fail-closed coverage.
- Non-route MISSING_FAIL_CLOSED_TEST tail branch (mapped + non-legacy +
  calls==0) has no dedicated fixture: all 3 real members are legacy, and
  writeNonRouteMember always registers legacy, so it is a defensive tail
  unreachable via the current harness. Accepted.

## Convergence
Code review converged in 3 rounds: R1 (1 Major aliased-vi, fixed) → R2 (clean) →
external-review R3 (1 Major non-route coverage, fixed + re-reviewed clean). The
R42 convergence artifact (check-fail-closed-routes-have-test.sh) now covers the
WHOLE class — route AND non-route members — with mutation-verified self-tests.

---

# Code Review Round 4 (external-review follow-up 2)
Date: 2026-07-19

## Changes from Previous Round
External review noted D9 caught non-route test DELETION but not WEAKENING: a
member's mapped test could keep a bare `redisErrored` identifier while its real
fail-closed assertion was gutted, because (1) the classifier didn't recognize
assertRedisFailClosedSilentDrop as a helper call (auth.config's strong
silent-drop test fell to the weak legacy tier) and (2) the non-route helper
branch lacked STALE_LEGACY. See deviation D10.

## Fix
- classify-fail-closed-test.mjs: HELPER_NAME → HELPER_NAMES set (3 tiers:
  assertRedisFailClosed / ...SilentDrop / ...Result); import + call counting
  match any tier.
- src/__tests__/helpers/fail-closed.ts: new assertRedisFailClosedResult
  (direct-result tier; asserts redisErrored===true && allowed===false) + 3
  self-test red cases. rate-limiters.test.ts migrated to it.
- check-fail-closed-routes-have-test.sh: non-route helper branch fires
  STALE_DEBT_ENTRY / STALE_LEGACY_ENTRY (route parity); EXPECTED_LEGACY_COUNT
  16→13.
- All 3 non-route members migrated to HELPER MODE, removed from legacy
  (legacy = 13 routes now). Resolves plan SC-T3-6.
- Self-test: non-route positive fixture uses a real helper (not
  {redisErrored:true}); STALE_LEGACY non-route red fixture added; classifier +
  helper self-tests gain the new-tier cases.

## Verification (orchestrator, direct)
Red-proof reproduced first-hand: a helper-mode non-route member whose mapped
test is a bare `{redisErrored:true}` placeholder (NOT in legacy) now fails
MISSING_FAIL_CLOSED_TEST — the placeholder no longer counts as coverage. All 3
real members classify calls=1 (helper mode). classifier self-test 34, gate
self-test 47, helper self-test 25, real gate + meta-gate EXIT 0, pre-pr 51/51.
The security re-review agent for this round was interrupted by a session
restart; every check it was tasked with was independently reproduced by the
orchestrator (member classification, the 4 drift/weakening red-proofs, gate +
meta-gate + pre-pr green), so its findings are not required to close the round.

## Adjudicated (no change)
- Reviewer's "duplicate check_dangling" item: NOT a bug — the two calls pass
  different lists (DEBT_LIST vs LEGACY_LIST); same as the upstream tranche-1
  gate. No edit.
- Route legacy tier (13 route members) still passes on a code-level
  redisErrored reference: unchanged and acceptable — routes are the documented
  weaker legacy tier tracked for migration (plan T3-1). The external review's
  concern was specifically the NON-route members, which are now ALL helper
  mode; no non-route member can ride the weak legacy path.

## Convergence
Code review converged in 4 rounds: R1 (Major aliased-vi, fixed) → R2 (clean) →
R3 external (Major non-route coverage gap, fixed) → R4 external (Major non-route
weakening + tier migration, fixed). The R42 convergence artifact now verifies
the WHOLE class — route AND non-route — for coverage AND semantic strength, with
mutation-verified self-tests.

---

# Code Review Round 5 (external-review round 2)
Date: 2026-07-19

## Changes from Previous Round
External review round 2 raised 3 residual gate gaps (see deviation D11):
Medium (new) — assertRedisFailClosedResult accepted an arbitrary result thunk
so a fixed object could masquerade as a direct-result contract; Medium
(pre-existing) — multi-limiter files passed on 1 helper call; Low
(pre-existing) — multiline setupFiles arrays evaded the C6 stub scan.

## Fix
- fail-closed.ts: assertRedisFailClosedResult now takes { limiter, key } and
  runs limiter.check(key) itself (no arbitrary thunk). rate-limiters.test.ts
  passes the production v1ApiKeyLimiter.
- check-fail-closed-routes-have-test.sh: helper-mode files must have
  calls >= declared limiter count (HELPER_CALLS_BELOW_LIMITER_COUNT), on both
  route and non-route branches; multiline setupFiles now parsed by an awk
  multiline extractor.
- Self-tests: HELPER_CALLS_BELOW_LIMITER_COUNT (fail + pass), multiline
  setupFiles stub (STUB_MOCKED_RATE_LIMIT_AUDIT), result-helper cases rewired
  to limiter+key. Gate self-test 47→50, classifier 34, helper self-test with
  limiter-driven result cases.

## Verification (orchestrator, direct red-proofs)
- Fix 1: signature requires a real limiter object; the old arbitrary-thunk form
  no longer exists. rate-limiters.test.ts green against production v1ApiKeyLimiter.
- Fix 2: count=2 file with 1 call → HELPER_CALLS_BELOW_LIMITER_COUNT; with 2
  calls → passes. All real count>=2 helper-mode files already satisfy it.
- Fix 3: a stub in a multiline setupFiles array → STUB_MOCKED_RATE_LIMIT_AUDIT
  (was missed by the same-line grep).
- Regression: gate self-test 50, real gate + meta-gate EXIT 0, pre-pr 51/51
  (typecheck caught + fixed a missing RateLimitResult import).

## Adjudicated residual (documented, accepted)
The AST gate cannot statically prove the limiter passed to
assertRedisFailClosedResult is the PRODUCTION singleton rather than a
same-shaped fake — a semantic property beyond AST reach. The signature change
closes the specific arbitrary-object weakening; correct production wiring
(getRedis→null + the real limiter) for the single direct-result member is a
review matter, not a mechanically-verifiable one. The two carried-over Mediums
from the prior review (multi-limiter, setupFiles) are now resolved.

## Convergence
Code review converged in 5 rounds: R1 (Major aliased-vi) → R2 (clean) → R3
(Major non-route coverage) → R4 (Major non-route weakening + tier migration) →
R5 (3 residual gaps: result-helper binding, multi-limiter count, multiline
setupFiles). The R42 convergence artifact now enforces, per fail-closed member:
existence, semantic strength (real helper, mapping unmapped, limiter-bound
result), per-limiter coverage in multi-limiter files, and stub-scan reach into
multiline-configured setup files.

---

# Code Review Round 6 (external-review round 3)
Date: 2026-07-19

## Changes from Previous Round
External review round 3: both prior Mediums remained because the gate checked
call COUNT, not limiter IDENTITY. (1) The direct-result helper still accepted a
fake `{ check }` object. (2) A count=2 file passed by asserting the SAME
limiter twice. See deviation D12.

## Fix (classifier symbol-based limiter resolution)
- `distinct` field: count of distinct `limiter:` argument symbols across helper
  calls (shorthand-aware). Gate multi-limiter check now compares
  `distinct >= manifest count`, not `calls` — same-limiter-twice fails
  HELPER_CALLS_BELOW_LIMITER_COUNT.
- `resultfake` field: 1 when an assertRedisFailClosedResult limiter arg is a
  locally-constructed object literal (inline or const-bound) instead of a
  production import. Gate fires RESULT_HELPER_FAKE_LIMITER.
- bindingDeclsOf follows a `{ limiter }` shorthand to its real const binding
  (getAliasedSymbol / getDefinitionNodes).

## Verification
- distinct: two distinct → distinct=2; same twice → distinct=1 (self-tested).
- resultfake: inline/const fake → 1; production import → 0 (self-tested).
- All real count>=2 helper files assert distinct limiters; rate-limiters
  imports production v1ApiKeyLimiter (resultfake=0).
- classifier self-test 34→38, gate self-test 50→53, meta-gate EXIT 0,
  pre-pr 51/51.

## Accepted residual (documented)
resultfake rejects inline/const object-literal fakes. A fake returned from a
factory-CALL expression is not classified as fake — that is the legitimate
factory-mock pattern the Response/silent-drop tiers rely on, and the
direct-result tier has exactly one member (rate-limiters) whose production
wiring is verified. Deeper "is this the PROD singleton" identity is beyond AST
reach and remains a review matter for that single member.

## Convergence
Code review converged in 6 rounds. The R42 convergence artifact now verifies,
per fail-closed member: existence; semantic strength (real helper, mapping
unmapped); per-DISTINCT-limiter coverage in multi-limiter files; a real
(non-fake) limiter for the direct-result tier; and stub-scan reach into
multiline-configured setup files — all symbol-based, all mutation-verified in
the self-tests.

---

# Code Review Round 7 (external-review round 4)
Date: 2026-07-19

## Changes from Previous Round
Two evasions survived the symbol-based checks (deviation D13): (1) mocking the
allowlisted rate-limiters module itself left the import binding
production-legitimate while faking v1ApiKeyLimiter; (2) two aliases of one
factory-result were keyed by alias text, counting as distinct=2.

## Fix
- Direct-result tier now also fails resultfake=1 when the rate-limiters module
  is vi.mock/doMock'd (pre-pass, string + relative specifier normalized).
- resolveRootBinding keys every non-import root on the root VariableDeclaration
  position (declKey), so factory-result aliases collapse to distinct=1.
- Proactively closed the same class before re-review: vi.doMock and
  relative-specifier module mocks; relative import unmocked stays resultfake=0.
- Removed a pre-existing unused MAPPING_MODULE constant; fixed a self-inflicted
  `module` variable-name lint error.

## Verification
Classifier self-test 42→46 (factory-alias distinct=1, module vi.mock/doMock
resultfake=1), gate self-test 53, real gate + meta-gate EXIT 0, lint clean.

## Note on process
This round and R6 were the same defect class (limiter identity by AST) that
should have been closed comprehensively in one pass; the piecemeal fixes were an
implementation-thoroughness gap, not an inherent AST limitation. The self-audit
(doMock/relative variants) was added to this round to close the class rather
than wait for the next report.

---

# Code Review Round 8 (external-review round 5)
Date: 2026-07-19

## Changes from Previous Round
The module-substitution class had two members left (deviation D14): the
resultfake pre-pass missed the vitest-3 typed form vi.mock(import("...")), and
the config-seam guard only flagged rate-limit-audit, not the rate-limiters
module.

## Fix
- Factored mock-specifier extraction (string / template / typed import() form)
  into one mockSpecifierOf helper shared by the mapping-stub scan AND the
  module-mock pre-pass — a single source of truth so a new arg shape cannot lag.
- STUB_CONFIG_SEAM now also fails on a security/rate-limiters reference in a
  vitest config (path-segment match, no false positive on the real config).

## Verification (self-audited the full class before submit)
typed-form module mock caught in vi.mock / vi.doMock / relative variants;
mapping-mock + dynspec unregressed; config alias of rate-limiters →
STUB_CONFIG_SEAM. classifier self-test +3, gate +1, all green; real gate +
meta-gate EXIT 0, lint clean.

## Class closed
Module substitution of the fail-closed-critical modules (rate-limit-audit,
security/rate-limiters) is now covered across: specifier form
(string / template / typed import()), mock verb (vi.mock / vi.doMock), specifier
kind (absolute / relative), and config-level resolve.alias. This was the class I
should have enumerated and closed in round 6; it took rounds 6-8 instead, a
thoroughness failure recorded in the retrospective memory.

---

# Code Review Round 9 (external-review round 6)
Date: 2026-07-19

## Changes from Previous Round
Last placement axis of the module-substitution class (deviation D15): a
rate-limiters mock in a GLOBAL setup file. resultfake needs a co-located helper
call; a setup file has none, so the mock reached no output field, and the C6
setup scan only checked mock+dynspec.

## Fix
- New helper-call-independent classifier field resultmodulemock=1 iff the file
  mocks security/rate-limiters (all specifier forms, shared mockSpecifierOf).
- C6 scan rejects resultmodulemock=1 ONLY in setup files
  (STUB_MOCKED_RATE_LIMITERS_MODULE), scoped by SETUP_FILE_SET — a per-file
  mock in an ordinary test only affects that file's own limiter (real example:
  migrate/route.test.ts mocks it for migrateLimiter) and stays legitimate.

## Verification
Setup file mocking rate-limiters (string + typed) → fail; ordinary test mocking
it → pass; real repo (with the legitimate per-file migrate mock) green.
classifier self-test +3, gate +2, all green; real gate + meta-gate EXIT 0, lint
clean.

## Class fully closed
Module substitution of the fail-closed-critical modules is now covered across
all four axes: module (rate-limit-audit, rate-limiters), specifier form
(string/template/typed import()), mock verb (mock/doMock) & config resolve.alias,
and PLACEMENT (inline test vs global setup file). The scope guard distinguishes a
fleet-wide setup-file mock (rejected) from a legitimate per-file mock of an
unrelated limiter (allowed).
