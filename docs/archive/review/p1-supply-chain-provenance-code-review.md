# Code Review: p1-supply-chain-provenance
Date: 2026-07-16
Review round: 1

## Changes from Previous Round
Initial code review of the implemented branch (C1-C4). Three experts reviewed `git diff main...HEAD` against the plan + deviation log. All load-bearing claims (C1 fail-closed shell paths, C4 member-set completeness, CODEOWNERS gating, no injection) were independently verified against the code. 8 findings merged (3 Major, 5 Minor); no Critical.

## Merged Findings

### Major

**M1 — `detectedBy` accuracy (INV-C4c / Round-2 T2) unimplemented.** (Testing T2 + Functionality F1 — convergence)
`computeUnbackedSensitiveDeps` only branches on `manual` and never verifies a `detectedBy` claim against the actual import shape. For a non-crypto-named member (`next-auth`, `@auth/prisma-adapter`, `@prisma/adapter-pg`, `pg`, `@prisma/client`, `resend`), if its import is removed from all CODE roots but it stays in package.json + manifest, no check fires — the stale `static-import` claim is undetected. Plan line 157 / INV-C4c / Round-2 T2 promised this + a three-branch self-test. Real impact low (metadata drift, not a supply-chain hole) but it's an undocumented deviation from a LOCKED invariant + a missing promised self-test.
Fix: add `computeDetectedByViolations(manifestByPackage, codeSpecifiers)` flagging a `static-import`/`dynamic-import` entry with no CODE occurrence (excluding `manual`), with the T2 self-tests.

**M2 — auto-merge guard misses standard Dependabot auto-merge shapes.** (Security SEC-1)
`check-workflow-supply-chain.mjs:33` `mergeRe` catches `gh pr merge --auto` but misses `peter-evans/enable-pull-request-automerge` (the documented Action), `enablePullRequestAutoMerge` GraphQL, `gh api pulls/N/merge` REST, and reusable-workflow splits (cross-file, unfixable by a per-file grep). Plan INV-C3a frames the guard as THE enforcement. Mitigated by CODEOWNERS on `/.github/workflows/` → any auto-merge workflow still needs owner approval → Major not Critical.
Fix: widen `mergeRe` (add `enable-pull-request-automerge`, `enablePullRequestAutoMerge`, `pulls/[^ ]*/merge`); document CODEOWNERS as the PRIMARY control in the guard header.

**M3 — (B) presence check has no isolated pure-function negative test.** (Testing T1)
The manifest∖DEPS presence check is inlined (`.filter(p => !depSet.has(p))`) and covered only by the committed-tree assertion. Plan line 160 / INV-C4d singled this out as "the one gate previously lacking a unit negative" and required a synthetic-DEPS unit negative. No such unit exists.
Fix: extract `computeMissingDeps(manifestPackages, depSet)` + RED/GREEN units.

### Minor

**m1 — anti-mask regex misses realistic exit-masks.** (Functionality F3 + Security SEC-2 — convergence) `maskRe` misses `| tee`, `|& tee`, `|| exit 0`, `; exit 0`, `set +e`, YAML `continue-on-error: true`. No present offender. Fix: expand `maskRe` (add `exit\s+0`, `continue-on-error`) or narrow the docstring.

**m2 — guard comment overstates provenance-assertion coverage.** (Security SEC-3) `check-workflow-supply-chain.mjs:14` claims coverage for the post-publish provenance assertion but `findMaskedVerifierViolations` matches only `audit\s+signatures`. No live risk (release.yml assertion is fail-closed + CODEOWNERS-gated). Fix: extend the match to the `npm view` provenance assertion OR correct the comment.

**m3 — `--merge\b` regex over-broad (false positive).** (Functionality F2) matches any `--merge` co-occurring with "dependabot"; `gh pr merge` is already covered. Fix: drop bare `--merge\b` or scope to `pr\s+merge`.

**m4 — `toPackageRoot` has only positive assertions.** (Testing T3) strict RT7 wants a fail-if-regresses case. Fix: add a bare-`name` and deep-subpath assertion.

**m5 — (B) real-tree check reads only `dependencies`; a listed devDependency would false-RED.** (Testing T4, Adjacent) No violation found. Fix: record the runtime-dependencies assumption in the deviation log (every listed package is a runtime dep).

## Adjacent Findings
- Testing T4 (devDependency assumption) → Functionality data-model (m5).

## Quality Warnings
None — all findings carry concrete file/line evidence and verified repro.

## Environment Verification Report
- VC1 (npm OIDC provenance emission, CI-only-at-release): the C1 emission path is `verified-CI`-at-next-release; today's live registry state (GT-1) already demonstrates it; the INV-C1b assertion makes future emission fail-closed. Not exercisable pre-release — matches the Phase-1 VC1 constraint.
- VC2 (`npm audit signatures` verifies published registry state, not HEAD): the C2 verifier is `verified-local` (ran `npm audit signatures` in cli/ during investigation, reported verified signatures/attestations) and `verified-CI` on the audit jobs + cron. No blocked-deferred path.

## Recurring Issue Check
### Functionality expert
R42 applied (member-set re-derived from code across 3 workspaces, matched). R44: guard intent is R44 defense but mask regex has FNs (m1). RT7: all pure fns have negative self-tests EXCEPT the detectedBy-contradiction branch (M1). No R21 residue (prove-it-fails were scratch-only). R1-R41,R43 no hits.

### Security expert
R44/RS5: C1 assertion genuinely fail-closed (all shell paths simulated); ci.yml audit steps unmasked; no auto-merge introduced but the backstopping guard has gaps (M2). R42: member-set re-derived, name-invisible auth pkgs CODE-covered, complete. RS2/RS6: C4 gates manifest + enforcing test, owners enum + ≥10-char reason enforced+self-tested. RS1: no `${{}}` in any run: block, no shell interpolation of npm output beyond the fail-closed predicate. RS3: no token in assert step, cron secret-free, OIDC publish. RS4 n/a.

### Testing expert
RT1/RT2/RT5/RT9 met (real manifest + real tree, proven by RED-on-mutation; fs+ts-morph only). RT4/RT8: no vacuity. RT7: partially violated — (B) lacks isolated unit negative (M3), detectedBy-accuracy branch absent (M1), toPackageRoot positive-only (m4). RT3/RT6 n/a.

## Resolution Status

### M1 [Major] detectedBy accuracy (INV-C4c) unimplemented
- Action: added `computeDetectedByViolations(manifestByPackage, codeSpecifiers)` pure fn + a real-tree `(detectedBy accuracy)` assertion per workspace + 5 RED/GREEN self-tests (static-no-code→finding, dynamic-no-code→finding, static-with-code→none, dynamic-confirmed→none, manual-exempt→none). Real tree green ⇒ every manifest static/dynamic claim has a confirming CODE occurrence.
- Modified: src/__tests__/checks/crypto-auth-deps-manifest.test.ts

### M2 [Major] auto-merge guard misses standard shapes
- Action: widened `mergeRe` (peter-evans/enable-pull-request-automerge, enablePullRequestAutoMerge GraphQL, gh api pulls/N/merge REST); documented CODEOWNERS as the PRIMARY control in the guard header (regex = defense-in-depth; cross-file split out of a per-file grep's reach). Added 4 self-tests (3 new shapes fire + git-merge stays quiet).
- Modified: scripts/checks/check-workflow-supply-chain.mjs, scripts/__tests__/check-workflow-supply-chain.test.mjs

### M3 [Major] (B) presence check no isolated unit negative
- Action: extracted `computeMissingDeps(manifestPackages, deps)` pure fn (real-tree (B) now calls it) + RED/GREEN self-tests.
- Modified: src/__tests__/checks/crypto-auth-deps-manifest.test.ts

### m1 [Minor] anti-mask regex misses realistic masks
- Action: extended `maskRe` to `|| exit 0` / `; exit 0`, added a `continue-on-error: true` detector on verifier-running workflows. Self-tests for both.
- Modified: scripts/checks/check-workflow-supply-chain.mjs, scripts/__tests__/check-workflow-supply-chain.test.mjs

### m2 [Minor] guard comment overstates provenance coverage
- Action: extended `findMaskedVerifierViolations` to also match the `npm view … attestations` provenance assertion (comment now accurate); a masked provenance step is now flagged. Self-test added.
- Modified: scripts/checks/check-workflow-supply-chain.mjs, scripts/__tests__/check-workflow-supply-chain.test.mjs

### m3 [Minor] --merge over-broad false positive
- Action: dropped the bare `--merge\b` alternative (gh pr merge already covered); added a git-merge-near-dependabot no-false-positive self-test.
- Modified: scripts/checks/check-workflow-supply-chain.mjs, scripts/__tests__/check-workflow-supply-chain.test.mjs

### m4 [Minor] toPackageRoot positive-only
- Action: added a 3-case self-test (bare name unchanged, unscoped subpath stripped, scoped deep subpath → scope/name).
- Modified: src/__tests__/checks/crypto-auth-deps-manifest.test.ts

### m5 [Minor] (B) reads only dependencies (devDependency assumption)
- Action: recorded the runtime-dependencies assumption in the deviation log (D5) after confirming every listed package is a runtime dependency; no code change needed.
- Modified: docs/archive/review/p1-supply-chain-provenance-deviation.md

Verification: 54 guard+manifest tests pass; full suite 950 files / 12359 tests pass (1 skip); lint clean.
