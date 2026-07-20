# Code Review: fail-closed-tranche3
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Initial code review (Phase 3). Phase 2 self-R-check already ran a focused R1-R44
pass that found + fixed one R20 tsc regression (D4). This round is incremental
verification by three experts (functionality / security / testing), each performing
independent live mutation-proofs.

## Functionality Findings
No findings. All 15 assertRedisFailClosed cases across 13 files verified migrated;
auth dynamic-import loadRoute() captures 2 distinct limiters correctly; reset-vault
D4 const-before-return fix confirmed (tsc clean project-wide); ssh custom envelope
(D1) matches route.ts:87-91 byte-for-byte; emptied FROZEN_STUB_EXEMPTIONS + guard
sound; no production route.ts touched. C1-C5 all verified against live evidence
(gate exit 0, full vitest 12769 passed, classifier distinct=2 for the 2 multi-limiter
routes).

## Security Findings
No findings. Independent live verification:
- `git grep vi.mock rate-limit-audit -- src` → empty (zero stubs remain).
- legacy manifest empty; gate exit 0 with EXPECTED_LEGACY_COUNT=0.
- RT7 mutation-proofs: flipped `failClosedOnRedisError: true→false` in auth callback,
  reset-vault admin, dcr-cleanup — each reds the targeted case while the sibling
  distinct-limiter case stays green (proves distinct attribution discriminates), then
  reverted clean.
- Live probe: added `expect(mockLogAudit).toHaveBeenCalled()` after the reset-vault
  admin case — passed, proving the real emitRateLimitFailClosed→logAuditAsync chain
  fires on the 503 path (not swallowed by throttle/tenantId-resolution/leftover stub).
  Reverted; worktree byte-identical afterward.
- M9: zero logAuditAsync in any assertNoMutation array.
- `is_stub_exempt()` is dead code (never called; real C6 enforcement is the awk block
  which builds an empty EX[] from the empty list — no accidental blanket exemption).
  The added `[ -n ... ]` guard is harmless defense-in-depth.

## Testing Findings
No findings. All 15 assertNoMutation spies are real post-limiter, load-bearing
primitives (full table verified against each route.ts); purge-audit-logs correctly
uses the load-bearing $queryRaw (not dead deleteMany). __resetThrottleForTests()
present in exactly the 4 stub-removal files where the real emit now runs, correctly
absent from the 8 single-emission files (vitest isolate:true rules out cross-file
bleed). The flipped gate self-test is a valid dual-assertion red-proof. No
it.skip/xit residue; no stale parallel/central test tree for the 13 routes (R19).

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 OK · R2 OK · R17 OK · R19 OK · R20 OK (D4 fixed) · R42 OK · RT5 OK · RT7 OK (self-test flip verified) · RT8 OK · RT9 OK · all others n-a.

### Security expert
R42 pass (member-set re-derived: both greps empty, manifest 65 unedited) · RS2 n/a (no new endpoint) · RT5 pass (real primitive reached, live-verified) · RT7 pass (3 live mutation-proofs on the hardest cases) · RT8 pass · RS1/RS3/RS4/RS5/RS6 n/a · no Critical.

### Testing expert
RT1 clear · RT3 clear (fixtures use env overrides, insulated from 13→0) · RT5 clear · RT7 clear (dual-assertion red-proof + live mutation-proof) · RT8 clear (spy table verified) · RT9 n/a · R19 clear · throttle-isolation clear.

## Environment Verification Report
Per Phase 1 VC3: every fail-closed contract path is `verifiable-local`.
- `verified-local`: full vitest (12769 passed), real gate `check-fail-closed-routes-have-test.sh` exit 0, meta-gate exit 0, classifier self-test 53, gate self-test 56, `next build` + Extension build (pre-pr 51/51). RT7 red-proofs executed on throwaway/reverted copies.
- No `blocked-deferred` paths. Integration-lane (SC-T3-4) explicitly out of scope.

## Resolution Status
### Post-review inline fix (tightening-only)
- Stale comment at `scripts/__tests__/check-fail-closed-routes-have-test.test.mjs:49`
  ("0 debt / 16 legacy" → "0 debt / 0 legacy") — inline minor, no assertion, no
  security boundary. Applied verbatim (Testing expert awareness note; not a blocking
  finding). Fits the Step 3-8 tightening-only skip criteria.

All three experts returned "No findings". No Critical/Major/Minor blocking findings.
Code review converged in 1 round.
