# Code Review: overview-pairing-and-reexport-guard
Date: 2026-07-18
Review round: 3 — external post-push review round (rounds 1-2 log below)

## Round 3 — external static review findings (user-provided, post-push)

An external static review of the pushed branch surfaced two Major evasion gaps in the C2 re-export gate plus resolver precision items. All verified against the code and fixed in review(2):

### R3-1 [Major→fixed] `@/`-alias star/namespace re-exports undetected
The resolver handled only `./`/`../`; `export * from "@/lib/vault/vault-reset"` (the repo's dominant import style) evaded cases (b)/(c). **Fixed**: unified `resolveSpecifierToRel` maps `@/*` → `<SCAN_ROOT rel>/*` (tsconfig `"@/*": ["./src/*"]`, computed from SCAN_ROOT so fixtures resolve identically), with candidates `<p>.ts` / `<p>.tsx` / `<p>/index.ts` / `<p>/index.tsx` — directory-index barrels (R3-3) resolve too.

### R3-2 [Major→fixed] Object/class binding named re-exports undetected
Destructive registrations for object/static-class wrappers are dotted (`vaultService.purgeUserEntries`, `VaultService.purgeAll`) but named-re-export matching compared only the bare binding name — `export { vaultService } from ...` evaded, breaking the anti-evasion guarantee for wrapper forms the checker explicitly supports. **Fixed**: matching is binding-prefix-aware (`n === sourceName || n.startsWith(sourceName + ".")`) and each member path is propagated under the post-alias local name (`vaultService.purge` re-exported `as service` registers `service.purge`), preserving semantics across multi-hop dotted chains.

### R3-3 [Minor→fixed] Resolver did not try `/index.ts` (directory barrels) — folded into R3-1's candidate list.
### R3-4 [Minor→fixed] Unresolved named re-exports flat-matched even for true package imports (false-positive/exemption-erosion risk). **Fixed**: three-way rule — resolved target → scoped set only; repo-shaped (relative or `@/`) but unresolved → flat fallback fail-closed (pinned fixture retained); true package import → skipped entirely (new green fixture).

### R3-5 [Observation — follow-up, not this PR] Blob-only general updates can leave `encryptedOverview` stale relative to a changed blob (title edits etc.). C1 is precisely an overview-only-mutation ban plus key-version-guard closure, not a full blob↔overview content-consistency guarantee — the server cannot inspect E2E ciphertext to distinguish counter-only from content changes. External review's suggested design (dedicated passkey-counter endpoint or an explicit `operation` discriminator, making the general PUT require both fields; re-examine whether v1 needs the blob-only exception at all) is recorded as a follow-up item; out of scope for this PR per the review's own merge criteria.

### Round 3 verification
- New fixtures (8): `@/` star, `@/` namespace, directory-index barrel, object-binding named, 2-hop aliased object chain (member propagated under each hop's local name), static-class binding, aliased class binding — all red with single-failure-code isolation; package-import same-name re-export — green (skip rule).
- Checker self-test 55/55; real tree exit 0 (no new false positives on existing `@/`/barrel usage); eslint clean on both files.

## Round 2 — incremental review of fix commit 2326bc597
All three perspectives: **No findings**. Round-1 findings F1/F2 verified resolved. Empirical verification highlights:
- Fixpoint re-scan: adversarial scan-order fixture (alphabetically-first evader re-exporting from a not-yet-registered mid-chain file) — both hops flagged; scoping change does not weaken transitive closure.
- `export { type A, b } from` mixed declarations: declaration-level `isTypeOnly()` is false for mixed, per-specifier skip removes only `type A`; runtime `b` still flagged. No detection gap.
- R43 (vs round 1's state, not just main): the F2 narrowing removes only false positives; mutation test proved the flat fallback remains load-bearing for exactly the unresolved-specifier fixtures (new pin + pre-existing route.ts fixture both go red when fallback removed).
- RT7: the three new fixtures each fail for their claimed distinct reason; restore-verified clean (orchestrator residue grep: worktree clean, `isTypeOnly` ×2 present).
- Suite: checker self-test 47/47; real tree exit 0.

Termination: all experts returned No findings at Round 2 → loop ends (Step 3-8). No R42 ①b accretion signature (the C2 detection-case set expanded once — type-only/collision precision, added with mutation-verified fixtures in the same round; the class remains closed by the mutation-verified CI guard itself, which is wired into pre-pr/CI).

## Changes from Previous Round
Initial review (incremental atop the Phase 2 self-R-check baseline, which reported No findings with RT7 mutation-proof of both new guards).

## Functionality Findings
No findings.
- Seed disposition: the single Ollama seed ([Major] `getAliasNode()?.getText()` returns "as x") **Rejected — does not reproduce**: empirical ts-morph probe shows `getAliasNode()?.getText()` returns just the alias identifier (`"x"`); the seed's premise is wrong about the API and its suggested fix (`getName()`) would break fixture 8 (2-hop named chain) by registering the pre-alias name.
- Verified: fixpoint termination (monotonic flagged-set, bounded loop); pass ordering (re-export pass feeds `destructiveExportsByModule` before the route pass consumes it — composable); `resolveRelativeSpecifierToRel` fails safe on `..`-past-root; `.refine` composes transparently with `parseBody`/`z.treeifyError` (same as team precedent); Implementation Checklist ⇔ diff cross-check complete (the two unlisted sibling test trees verified unaffected, not skipped).
- Below-threshold visibility note (not a finding): the resolver tries only `<path>.ts`, never `<path>/index.ts` — a future directory-barrel `export * from "./dir"` hiding a destructive wrapper would evade case (b) resolution (named re-exports stay covered via the flat fallback). Zero occurrences today; recorded for a future hardening pass.

## Security Findings
### F1 [Minor][Adjacent→fixed] Type-only re-exports false-positive
`export type { executeVaultReset } from ...` (compile-time-erased, no call surface) tripped `REEXPORTED_DESTRUCTIVE_WRAPPER`. False positives on a security gate train reflexive exemption. **Fixed in 2326bc597**: `decl.isTypeOnly()` / `named.isTypeOnly()` skipped; green fixture added.
### F2 [Minor][Adjacent→fixed] Flat name-set cross-module collision false-positive
A same-named but unrelated symbol re-exported from a cleanly-resolved in-scope module was flagged because matching consulted the flat cross-module name union. **Fixed in 2326bc597**: resolved targets match only their own registered export set; the flat fallback now applies solely when resolution fails (fail-closed for `.tsx`/generated targets — pinned by a new red fixture so the fallback cannot silently regress).
- Adversarial evasion sweep otherwise clean: mixed star→named chains, `export { default as x } from` (moot — default exports already NON_GREP_MATCHABLE-rejected), `./x.ts`/`./a/../b`/case-variant specifiers, out-of-scope `.tsx` targets — all detected or fail-closed.
- C1 bypass check: `updateE2EPasswordSchema` has exactly 2 consumers; no `.partial()/.omit()/.extend()/.pick()/.merge()` derivative exists — refine not bypassable.
- R43: both boundaries strictly narrow vs main. RS4: no personal data in diff.

## Testing Findings
No findings.
- Load-sensitivity note root-caused as environmental: no spawnSync timeout/maxBuffer to trip, per-test `mkdtempSync` isolation, sequential execution, deterministic sort + fixpoint; 3 consecutive full-suite runs green.
- Sub-agent test red flags: none across the 5 changed test files (mock binding, awaits, shapes all verified — v1 `keyVersion: 2` matches its guard mock deliberately, not coincidentally).
- Coverage: all C1/C2 acceptance criteria have tests; metadata-only PUT covered by pre-existing tests; e2e tree has zero `encryptedOverview` references.
- RT7 re-proven this round: refine removal → exactly the 3 expected tests red, rest green (restored, residue-grepped).

## Adjacent Findings
Sec F1/F2 were tagged [Adjacent] (outside the locked C2 contract's enumerated cases) — both fixed rather than deferred.

## Quality Warnings
None.

## Seed Finding Disposition (preserved per expert)
- Functionality: seed Rejected — does not reproduce (see above; empirical probe + fixture-8 counter-evidence).
- Security: seed returned No findings — nothing to disposition.
- Testing: seed returned No findings — nothing to disposition.

## Recurring Issue Check
### Functionality expert
R1-R44: pass or n/a per expert report; notable — R3 pass (5-consumer walkthrough), R5 pass (guard tx unchanged), R17 pass (reuses encryptedFieldSchema/team idiom/checker maps), R19 pass (3 trees enumerated, 2 verified-unaffected), R21 pass, R34 pass (history/restore sibling checked — unaffected), R40 pass-with-note, R42 pass (writer set re-derived, matches), R44 pass (unpiped exit codes).
### Security expert
R1-R44 + RS1-RS6: pass or n/a; notable — R42 re-applied to C2's own coverage (surfaced F1/F2, both fixed), R43 pass (narrowing only), RS3 satisfied (the fix IS boundary validation), RS4 clean, RT7/RT8 re-verified.
### Testing expert
R1-R44 + RT1-RT9: pass or n/a; notable — R7 pass (e2e grep clean), R19 pass, R21 satisfied (independent re-run), R42 pass, RT1 pass, RT5 pass (real handlers), RT7 pass (mutation-proved), RT8 pass, RT9 n/a.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 beyond `verifiable-local`; all executed: targeted vitest (1101), full vitest (12,569), next build, real-DB integration (key-version-guard), extension suite (58), pre-pr.sh (51 gates), checker real-tree run. All pass, exit codes observed unpiped (R44).

## Resolution Status
### F1 [Minor] Type-only re-export false positive — FIXED
- Action: skip `isTypeOnly()` at declaration and specifier level; green fixture pins non-flagging.
- Modified: scripts/checks/check-destructive-wrapper-derivation.mjs, scripts/__tests__/check-destructive-wrapper-derivation.test.mjs (commit 2326bc597)
### F2 [Minor] Flat-name cross-module false positive — FIXED
- Action: scoped matching for resolved targets; flat fallback restricted to unresolved specifiers; collision green fixture + unresolved-fallback red fixture pin both sides.
- Modified: same files (commit 2326bc597)
- Post-fix verification: checker self-test 47/47; real tree exit 0.
