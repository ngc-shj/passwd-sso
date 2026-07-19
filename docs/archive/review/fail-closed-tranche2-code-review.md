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
