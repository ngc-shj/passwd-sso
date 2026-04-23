# Plan Review: split-overcrowded-feature-dirs
Date: 2026-04-22
Review round: 1

## Changes from Previous Round
Initial review.

## Merged Findings (Round 1)

### Critical

| ID | Problem | Impact | Fix | Perspectives |
|----|---------|--------|-----|--------------|
| C1 | `vitest.config.ts` hardcodes file-level `coverage.include` + per-file `coverage.thresholds` for modules the plan moves; not in allowlist. | Coverage report silently shrinks after moves; per-file thresholds become no-ops. Security-critical modules (crypto, auth, audit) drop below 80% line coverage without CI failure → regression window for backdoors. | Add `vitest.config.ts` and `vitest.integration.config.ts` to allowlist. Convert includes to globs where possible. Update `coverage.thresholds` keys after each phase. Add `scripts/check-vitest-coverage-include.mjs` that verifies every entry resolves to ≥1 file. Run `npm run test:coverage` per phase; assert no drop. | Functionality (F1), Security (S12), Testing (T1) |
| C2 | `scripts/check-bypass-rls.mjs` omissions + no rename-only diff gate. Plan covers ~24 of ~30 `src/lib/*.ts` entries; no gate ensures added entry replaces removed with identical model set. | Attacker introduces new path with expanded model set (e.g., `["webhook-dispatcher.ts", ["teamWebhook", "user", "passwordEntry"]]`); reviewer assumes mechanical rename. Cross-tenant `passwordEntry` access → plaintext-envelope exfiltration. | Enumerate every `ALLOWED_USAGE` entry with disposition in plan. Add `scripts/verify-allowlist-rename-only.mjs`: enforces 1:1 path-rename with byte-identical model set + matching `git mv`. Wire into `pre-pr.sh`. | Security (S1/S1', S5) |
| C3 | `scripts/check-crypto-domains.mjs` hardcodes 7-file `cryptoFiles` array + silent skip on missing (L98-102). | New crypto modules bypass ledger (chain-1). Sibling-reuse: moving `deriveEncKey` between crypto files silently reuses HKDF info (chain-2). Deleted path silently skipped (chain-3). Domain separation collapse → cross-protocol key reuse; team member decrypts personal entries. | Convert `cryptoFiles` to glob (`readdirSync("src/lib/crypto", {recursive:true})`). Add discover-all scan for `passwd-sso-[a-z0-9-]+` / `(SCOPE_|AAD_SCOPE_)` tokens across repo. Replace `try/catch {continue}` with `fail()`. Land as Phase 0 prerequisite BEFORE any crypto move. | Security (S2/S2') |
| C4 | Codemod `scripts/move-and-rewrite-imports.mjs` is unreviewed privileged tooling; no CODEOWNERS, no proof-of-execution, no pre-pr gate. | Malicious edit injects `$bypassRls()` wrap on auth Prisma or downgrades PBKDF2 iterations; looks indistinguishable from mechanical refactor churn. 15 PRs × reviewer fatigue → high slip-through. | Phase 0: (a) create `.github/CODEOWNERS` requiring security reviewer for `scripts/*.mjs`, `src/lib/crypto*`, `src/lib/auth*`, `.github/workflows/*`. (b) Pre-pr hook rejecting PRs that mix codemod edits with source moves. (c) Per-PR: run codemod at HEAD vs last-merged-to-main; bitwise diff, fail if differ. (d) For crypto/auth files: `git diff` must show ONLY import-specifier lines. | Security (S11) |

### Major

| ID | Problem | Fix | Perspectives |
|----|---------|-----|--------------|
| M1 | Root-level configs (`next.config.ts`, `sentry.*.config.ts`, `proxy.ts`, `instrumentation*.ts`, `prisma.config.ts`, `eslint.config.mjs`) outside codemod scope but import moved files. | Expand codemod to repo-root `*.ts/*.mjs/*.js` configs. Recognize both `@/lib/...` and `./src/lib/...` specifiers. | Functionality (F2), Security (S13) |
| M2 | Pre-audit regex `src/lib/[a-z]+\.ts` misses `.tsx`, `hooks/`, `components/passwords/` → 1281 doc matches missed (336 in docs/ alone per Opus). | Widen to `src/(lib\|hooks\|components/passwords)/[a-z][a-z0-9-]+\.(ts\|tsx)`. Add `scripts/check-doc-paths.mjs` validating every `src/...` ref in `docs/**/*.md` resolves. | Functionality (F5), Security (S17) |
| M3 | `.github/workflows/ci.yml:144` hardcodes `grep -v 'src/lib/webhook-dispatcher.ts'`; silent break on move; fix-by-removal creates SSRF surface. | Add `.github/workflows/*.yml`, `.github/codeql/*.yml` to allowlist. Replace hardcoded grep with in-file `// allow-plain-fetch` comment contract. | Functionality (F6), Security (S6/S14), Testing (T2) |
| M4 | No mechanical "imports-only" diff gate for security-sensitive moves. Whole-file sha256 is useless (imports always change). | `scripts/verify-move-only-diff.mjs`: strip `import` / `export...from` lines from pre/post; `diff` must be empty. Apply to Phase 1/2/4 files. | Security (S4, S11) |
| M5 | No CODEOWNERS + no `.git-blame-ignore-revs` → review-policy inheritance and forensics both fail-open. Post-move `git blame` attributes every line to refactor-commit author. | Phase 0: create CODEOWNERS (see C4). Create `.git-blame-ignore-revs` (empty); append each phase's move-commit SHA in same PR. Create `docs/forensics.md` with `blame.ignoreRevsFile` instruction. CI check: any `^refactor.*move` commit subject must appear in the file. | Security (S7, S16) |
| M6 | Transitional window inconsistency across CI tooling (ESLint globs vs path-literal gates) during 3-8 week multi-PR refactor. | "Quiesce" rule: single phase PR in flight at a time; merge queue. Rebase in-flight feature branches onto refactor head before merge. `scripts/refactor-phase-verify.mjs` re-runs all `check-*.mjs` on post-merge tree. | Security (S15) |
| M7 | No pre-move secret-leakage scan. Dirty tree + `git mv` + `git add` misuse could stage secrets. | `gitleaks detect --staged` as pre-pr step. Post-move: `git status --porcelain | grep -E '\.env|\.pem|\.key|credentials'` rejects. Assert `.gitignore` unchanged. | Security (S10, S18) |
| M8 | `.mjs` files (`scripts/__tests__/smoke-key-provider.test.mjs:11-13`, `load-test/setup/*.mjs`) use `.ts` relative imports; not covered by `tsc --noEmit`. | Codemod first-class handles `.mjs` with `.ts` imports. `scripts/check-mjs-imports.mjs` resolves every `import()` target, fails on unresolvable. Update load-test comments in Phase 2 PR. | Security (S9/S19), Functionality (F14) |
| M9 | Dynamic-import handling "warns" instead of "fails" → refactor window introduces new unsafe dynamic imports. | Codemod FAILS on any template-literal dynamic import matching moved-path prefix. Dev must refactor to exhaustive switch or explicit module map. Phase 0: audit existing dynamic imports, document each "why safe". | Security (S8/S20) |
| M10 | No test-count invariant check after moves. Vitest silently drops undiscoverable test (typo in target path) → suite green with fewer tests. | Record pre-move `Tests <N> passed` count via `npx vitest run --reporter=json`; assert post-move count equals pre-move. Reduction = lost test. | Testing (T4) |
| M11 | Plan omits `vi.mock("@/lib/...")` rewriting. 250 test files, 1077 occurrences. Mismatched specifier → real module runs (real DB, real crypto, real audit). | Plan step 2 must include: codemod rewrites `vi.mock()` / `vi.doMock()` string literals. Verify by counting pre/post; zero stale refs. | Testing (T5) |
| M12 | `npm run test:integration` not required per phase. Audit-outbox integration tests affected by audit/ move could break silently. | Add `npm run test:integration` to per-PR mandatory list. CI gate blocking. | Testing (T6) |
| M13 | `npm run test:coverage` not required per phase → coverage.thresholds silently decay. | Add `npm run test:coverage` per-PR for phases touching threshold-referenced files (Phase 1 auth-or-token, Phase 2 crypto-server/crypto-team). | Testing (T8) |
| M14 | Directory collision: proposed `src/hooks/forms/` vs existing `src/hooks/form/` (2 files). | Decide canonical name. Recommended: rename proposed to `forms/` (plural) and migrate existing `form/` files → forms/ in Phase 5. | Functionality (F3) |
| M15 | Directory overlap: proposed `src/components/passwords/detail/` vs existing `detail-sections/` (9 files). | Consolidate: either nest as `detail/sections/`, or rename proposed to match existing `detail-sections/`. State resolution explicitly. | Functionality (F4) |

### Minor

| ID | Problem | Fix | Perspectives |
|----|---------|-----|--------------|
| m1 | Plan references non-existent `workers/` (actual: `src/workers/`). | Remove `workers/**` from codemod scope list. | Functionality (F7) |
| m2 | Claim "centralized `src/lib/__tests__/` (23 files)" incorrect — actual 1 file. 107 co-located `src/lib/*.test.ts`. | Correct: 1 file (`prisma-filters.test.ts`) out of scope. 107 co-located tests move with impl. Centralized at `src/__tests__/**` (~60 files) in-scope for codemod imports but NOT moved. | Functionality (F8), Testing (T3) |
| m3 | `src/lib/__tests__/` not in existing-subdir-untouched list. | Add to list. | Functionality (F9) |
| m4 | Per-phase allowlist entry line-number checklist missing. | Enumerate exact lines each phase updates (e.g. Phase 1 = L25, 27-32, 41-46, 48, ...). | Functionality (F10) |
| m5 | `team-auth.ts` duplicate row (auth/ + team/). | Remove from team/ row. | Functionality (F11), Security (S3) |
| m6 | e2e/helpers Phase-2 bullet missing. | Add: "Verify e2e/helpers/crypto.ts, crypto.test.ts, share-link.ts updated for crypto-client.ts move." | Functionality (F12) |
| m7 | Per-phase import count estimate missing. | `rg -l "@/lib/(auth-adapter\|...)" src/ scripts/ e2e/ | wc -l` pre-phase; split if >200. | Functionality (F13) |
| m8 | `src/__tests__/lib/*.test.ts` third category not addressed. | Add: these tests don't move, but `@/lib/<old>` imports and `vi.mock(...)` need rewrite. | Testing (T7) |

## Adjacent Findings

- [Adjacent-F] `check-bypass-rls.mjs` exact-path match means any allowlist typo silently un-gates — routes to Security (covered by C2, M4).

## Quality Warnings

- [UNTESTED-CLAIM] M11 (codemod rewrites `vi.mock`): feasibility assumed; ts-morph can parse string-literal args, verified by inspection.
- [UNTESTED-CLAIM] M4 (imports-only diff gate): feasibility of `import/export...from` stripping verified — both are single-line statements in the codebase (grep confirms).
- [UNTESTED-CLAIM] C2 (rename-only diff gate): feasibility verified — `check-bypass-rls.mjs` uses a static `Map` literal, parseable via AST.
- [UNTESTED-CLAIM] C3 (ledger glob): feasibility high; readdirSync + glob filter is a standard pattern.

## Recurring Issue Check

### Functionality expert
- R1: N/A — R2: ISSUE (see F1/M2/M3) — R3: ISSUE (see F10) — R4-R9: N/A — R10: PARTIAL (madge --circular check recommended) — R11-R17: N/A — R18: CRITICAL GAP (C1/M3/M4) — R19: N/A — R20: OK (ts-morph AST-based) — R21: OK (step 4 grep gate + pre-pr) — R22-R30: N/A

### Security expert
- R1-R2: N/A — R3: Major (M4) — R4-R17: N/A — R18: Critical (C1, C2, C3, M1, M3) — R19-R20: N/A — R21: Major (C4, M4, M6, M9) — R22-R28: N/A — R29: N/A — R30: OK
- RS1: N/A — RS2: N/A — RS3: N/A

### Testing expert
- R1: Covered by M11 (vi.mock rewrite) — R2-R6: N/A — R7: OK (e2e selectors unaffected, e2e/helpers imports covered by codemod scope after M1) — R8-R15: N/A — R16: Covered by M3/M12/M13 — R17: N/A — R18: Testing-side in C1 — R19: Covered by M11 — R20: Adequate (tsc + lint) — R21: Covered by M10/M12/M13 — R22-R28: N/A — R29: N/A
- RT1: Addressed by M11 — RT2: N/A — RT3: N/A

## Next Steps

All Critical (C1-C4) and Major (M1-M15) findings require plan revision. Minor (m1-m8) are fix-if-straightforward. Proceeding to Round 2 plan rewrite.

---

# Round 2 Review
Date: 2026-04-22

## Changes from Previous Round
Plan rewritten to address 4 Critical (C1-C4) + 15 Major (M1-M15) + 8 Minor (m1-m8) findings. Key additions: Phase 0 scripts (`verify-allowlist-rename-only.mjs`, `verify-move-only-diff.mjs`, `check-vitest-coverage-include.mjs`, `check-doc-paths.mjs`, `check-mjs-imports.mjs`, `refactor-phase-verify.mjs`), CODEOWNERS + `.git-blame-ignore-revs`, expanded allowlist table, per-entry disposition for `check-bypass-rls.mjs`, directory collision resolutions, codemod `.mjs` + dynamic-import handling.

## Round 2 Disposition Summary

- **Functionality (F1-F14): all Resolved.** Five new findings: F15 (Critical — target ≤ 30 unachievable, 61 residuals), F16 (Major — 5 components/passwords files unassigned), F17 (Major — Phase 1 too large), F18-F20 (Minor).
- **Security (S1'-S20): all Resolved.** Seven new findings: S21 (Major — codemod misses `await import()` / `vi.importActual` / `vi.importOriginal` / `typeof import()` specifiers, 178+26 sites), S22-S25, S27 (Minor — count / path / wording accuracy), S26 (Major, agent-flagged escalate — merge-queue config dependency not specified).
- **Testing (T1-T8): all Resolved.** Three new findings: T9 (later verified non-issue — `test:coverage` npm script exists), T10 (Minor — expand test-count invariant to 4 metrics), T11 (Minor — `check-vitest-coverage-include.mjs` should enforce rename-parity on thresholds keys).

## Round 2 Fixes Applied to Plan

| ID | Fix applied |
|---|---|
| F15 Critical | Target relaxed to ≤ 40 for `src/lib` with explicit residual enumeration. Added subdirs: `emergency-access/`, `tenant/`, `format/`, `folder/`, `prisma/`, `env/`, `notification/`, `generator/`. |
| F16 Major | Added `components/passwords/export/` subdir; reassigned `password-generator.tsx`, `trash-list.tsx` → `shared/`; `attachment-section.tsx` → `entry/`. |
| F17 Major | Phase 1 split into 1a (tokens, 6), 1b (WebAuthn, 3), 1c (session/lockout/device, 8), 1d (core auth/tenant/team/delegation, 12). |
| F19 Minor | `crypto-blob.ts` added to `LEDGER_EXEMPT` exclusion list in `check-crypto-domains.mjs`. |
| F20 Minor | Absorbed into F15 fix (emergency-access/ subdir created). |
| S21 Major | Codemod scope extended to `await import(string-literal)`, `vi.importActual`, `vi.importOriginal<typeof import()>()`, `typeof import()` type refs. New `scripts/check-dynamic-import-specifiers.mjs` added. |
| S22 Minor | vi.mock count corrected to ~1462 with codemod runtime re-count. |
| S23 Minor | Template-literal dynamic imports corrected to 2 (both in `src/i18n/messages.ts`). |
| S24 Minor | `instrumentation.ts` path corrected to `src/instrumentation.ts` (covered by `src/**`); `instrumentation-client.ts` stays at repo root. |
| S25 Minor | Sentry config wording corrected (uses alias, not relative). |
| S26 Major | Phase 0 prerequisite 6 added: merge-queue config or `merge_group` trigger required before Phase 1. `refactor-phase-verify.mjs` asserts branch not stale vs main. |
| S27 Minor | Future awareness only; no change needed this refactor. |
| T9 | Verified non-issue — `npm run test:coverage` exists in package.json. |
| T10 Minor | Test-count invariant expanded to all 4 metrics (numTotalTests, numPassedTests, numSkippedTests, numFailedTests). |
| T11 Minor | `check-vitest-coverage-include.mjs` extended to enforce rename-parity on `coverage.thresholds` keys. |

## Next Steps

All Round 2 Critical + Major findings addressed. Proceed to Round 3 review to verify no regressions introduced by Round 2 rewrites and to catch any remaining issues.

---

# Round 3 Review
Date: 2026-04-22

## Changes from Previous Round
Plan updated to address Round 2 findings: F15 (target relaxed + 8 new subdirs), F16 (all 5 components/passwords files assigned + `export/` subdir), F17 (Phase 1 split into 1a/1b/1c/1d), F19 (crypto-blob.ts LEDGER_EXEMPT), F20 (emergency-access subdir), S21 (codemod scope extended to dynamic-import / vi.importActual / typeof import variants), S22-S27 (count/path/wording corrections + merge-queue prerequisite), T10 (test-count invariant to 4 metrics), T11 (coverage-include rename-parity).

## Round 3 Disposition Summary

- **Functionality**: F15 Partial (root enumeration was 44 not 40 → target further relaxed to ≤ 45); F16/F17/F19/F20 Resolved. Three new Minor findings: F21 (Phase 3.5 ordering label → renamed to Phase 4d), F22 (`url-helpers.ts` duplicated in enumeration → de-duplicated), F23 (`import-export-format.test.ts` cross-dir placement note — deferred as cosmetic).
- **Security**: All S21-S27 Resolved. One new Minor finding: S28 (instrumentation.ts count 5 → 4) — fixed.
- **Testing**: All T9-T11 Resolved. **No new findings. Merge-ready from Testing perspective.**

## Round 3 Fixes Applied

| ID | Fix applied |
|---|---|
| F15 residual | Target relaxed to ≤ 45 with explicit 44-entry enumeration (de-duplicated) |
| F21 | Renamed "Phase 3.5" → "Phase 4d" with explicit "runs AFTER Phase 4a/4b/4c" clarification |
| F22 | `url-helpers.ts` duplicate removed from residual enumeration |
| F23 | Deferred; noted cross-dir test placement as existing convention (out of refactor scope) |
| S28 | `src/instrumentation.ts` count corrected from 5 to 4 |

## Closeout

All Critical + Major findings across 3 rounds are Resolved. Remaining Round 3 findings are Minor and cosmetic. No expert review is blocking plan execution.

Plan is ready for branch creation and commit. Recommendation: proceed to Phase 0 implementation (codemod + verification scripts + CODEOWNERS + .git-blame-ignore-revs + crypto ledger conversion).

