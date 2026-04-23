# Code Review: split-overcrowded-feature-dirs
Date: 2026-04-23
Review round: 1

## Changes from Previous Round
Initial code review on Phase 0 commit `4f089ca2` (tooling + policy; no source file moves).

## Scope
- 21 files changed, +3329/-59 per `git diff main...HEAD --stat`.
- New: .github/CODEOWNERS, .git-blame-ignore-revs, docs/forensics.md, scripts/move-and-rewrite-imports.mjs + fixture test, 6 verify/check scripts, scripts/refactor-phase-verify.mjs.
- Modified: .gitignore, package.json + package-lock.json (ts-morph), scripts/check-crypto-domains.mjs (glob conversion), scripts/pre-pr.sh (wiring), scripts/manual-tests/share-access-audit.ts (cosmetic), plan + review docs.

## Merged Findings

### Critical

| ID | Problem | Impact | Fix | Flagged by |
|---|---|---|---|---|
| C1 | `rewriteAllowlistFile` substring replace corrupts sibling paths: `src/lib/audit → src/lib/audit/audit` also rewrites `src/lib/audit-outbox.ts → src/lib/audit/audit-outbox.ts`. | RLS-bypass allowlist silently contains wrong paths; `verify-allowlist-rename-only.mjs` may pass if prefix-longer rewrote first. Critical gate broken. | Drop bare-variant branch (rewrite only `.ts`/`.tsx`); OR word-boundary regex; OR longest-first ordering with negative-lookahead. | Functionality (F1) |

### Major

| ID | Problem | Impact | Fix | Flagged by |
|---|---|---|---|---|
| M1 | `verify-move-only-diff.mjs` line-filter fails on multi-line imports AND unconditionally strips all lone `}` lines. | Phases 1/2/3 cannot merge (false drift on multi-line imports); AND attacker can smuggle changes via crafted brace-only edits. | Replace line regex with ts-morph AST: collect Import/ExportDeclaration text ranges, diff non-declaration content. Remove closing-brace heuristic. | Functionality (F2, F3), Security (S3) |
| M2 | `execSync` with shell interpolation in codemod: `mkdir -p "${toDir}"` + `git mv "${from}" "${to}"` with unvalidated paths from JSON config. | Crafted config path with `"`, `$(cmd)`, `;`, or `..` → shell command injection in CI runner → exfiltrate env secrets. | Replace with `execFileSync("git", ["mv", from, to])` + `mkdirSync(toDir, {recursive:true})`. Validate paths with `/^[A-Za-z0-9_\-./]+$/` rejecting `..` and escape-from-repo. | Security (S1) |
| M3 | CODEOWNERS `/src/lib/auth*` does NOT match future `src/lib/auth/**` files (same for `crypto*`). | Phase 1+ moves bypass security review on the files being refactored — defeats Phase 0's primary safeguard. | Add `/src/lib/auth/** @ngc-shj` and `/src/lib/crypto/** @ngc-shj`; keep existing flat entries. | Security (S2) |
| M4 | Plan's test-count invariant is spec'd but NOT implemented in any script. Lives only in PR-description prose. | Silent test-loss / newly-skipped drift — the exact regression the refactor aims to prevent. | Add `scripts/capture-test-counts.mjs` that runs `vitest run --reporter=json`, writes baseline on first run, fails on mismatch. Wire into `refactor-phase-verify.mjs`. | Testing (T1) |
| M5 | `refactor-phase-verify.mjs` not wired into GitHub Actions CI. Local pre-pr.sh is the only gate. | Contributor skipping `npm run pre-pr` bypasses verifier server-side. Plan Round-2 S26 explicitly required merge-queue / `merge_group` BEFORE Phase 1. | Add CI job running `node scripts/refactor-phase-verify.mjs --force` on push to `refactor/*` + `merge_group`. | Testing (T2) |
| M6 | Codemod fixture suite missing 2 high-value cases: (a) `rewriteAllowlistFile` path rewrites; (b) `vi.importActual` / `typeof import` rewrites. | RLS-sensitive Phase 1 moves rely on `verify-allowlist-rename-only.mjs` alone; codemod variants untested. | Add 2 fixture tests: (1) seed check-bypass-rls.mjs with ALLOWED_USAGE, run codemod, assert path rewritten + models byte-identical; (2) seed test file with vi.importActual + typeof import, assert both rewritten. | Testing (T3) |

### Minor

| ID | Problem | Fix | Flagged by |
|---|---|---|---|
| m1 | `check-mjs-imports.mjs` generic EXTENSIONS includes `.ts`/`.tsx` → false-pass on broken `.mjs` imports. | Remove from generic list; require explicit `.ts` suffix. | Functionality (F4) |
| m2 | Rename-parity only accepts `R` status; missing `C` (copy-rename) under `diff.renames=copies`. | Accept `R` OR `C`, or force `git -c diff.renames=true --find-renames`. | Functionality (F5) |
| m3 | `check-dynamic-import-specifiers.mjs` filters out `.mjs` files. | Add `.mjs` to ts-morph project with `allowArbitraryExtensions`, OR extend check-mjs-imports.mjs to cover dynamic-import specifiers. | Security (S4) |
| m4 | `LEDGER_EXEMPT` hardcoded path becomes stale post-move; future exempt file with HKDF silently passes. | Startup assertion: exempt entry exists on disk AND contains zero HKDF/AAD tokens. | Security (S5) |
| m5 | `verify-allowlist-rename-only.mjs` regex parser doesn't detect duplicate keys → model-set bypass. | Detect duplicates; fail loudly. OR parse via ts-morph / node --input-type=module. | Security (S6) |
| m6 | No CI replay / proof-of-execution gate for codemod output. | Add `scripts/refactor-phase-replay.mjs`: reset, re-run codemod, diff vs PR tree. | Security (S7) |
| m7 | No `--dry-run` live-divergence test on rewritable input. | Add alias-case test in dry-run: assert source file byte-identical after run + `[alias]` stdout lines. | Testing (T4) |

## Quality Warnings
None (all findings have evidence).

## Recurring Issue Check

### Functionality expert
- R1 (shared utility reimplementation): `resolveAlias`/`EXTENSIONS` duplicated across check-mjs-imports.mjs and check-dynamic-import-specifiers.mjs — future consolidation `scripts/lib/resolve-alias.mjs`. Not blocking.
- R2 (hardcoded constants): no duplication beyond R1.
- R3 (pattern propagation): check-crypto-domains.mjs rewrite clean.
- R10 (circular deps): none.
- R20 (mechanical edit preservation): OK.

### Security expert
- R1-R6: N/A (no runtime code).
- R7 (shell injection): present (M2).
- R8 (input validation at boundary): violated (config loader — M2 fix covers).
- R9 (logging secrets): safe.
- R10-R30 / RS1-RS3: N/A; RS-pattern violations (M3 CODEOWNERS, M1/m5 regex brittleness, m6 replay gate).

### Testing expert
- R1-R30: No recurrence.
- RT1 (mock-real drift): N/A.
- RT2 (async await omission): Clean.
- RT3 (snapshot drift): N/A.

## Resolution Status (Round 1 fixes applied)

### C1 Critical: rewriteAllowlistFile substring corruption — Resolved
- Action: Dropped bare-variant from `variants` array; now only `.ts`/`.tsx` extension pairs. Added `buildAnchoredReplaceRegex()` using lookahead `(?=["'\`\s)},\]]|$)` to require non-path char after match. Regression test added (scripts/__tests__/move-and-rewrite-imports.test.mjs, "rewriteAllowlistFile — C1 regression" describe block).
- Modified files: scripts/move-and-rewrite-imports.mjs:~572-612, scripts/__tests__/move-and-rewrite-imports.test.mjs

### M1 Major: verify-move-only-diff multi-line import false-drift + over-strip — Resolved
- Action: Replaced line-by-line regex with ts-morph AST `stripImportExportDeclarations()`. Walks top-level `ImportDeclaration` / `ExportDeclaration` nodes, removes their text ranges. Lone-`}` filter removed. Falls back to original line-regex (minus lone-`}`) with stderr warning on parse failure.
- Modified file: scripts/verify-move-only-diff.mjs:55-130

### M2 Major: execSync shell interpolation in codemod — Resolved
- Action: Replaced `execSync(mkdir -p "${toDir}")` with `mkdirSync(toDir, {recursive:true})`. Replaced `execSync(git mv "${from}" "${to}")` with `execFileSync("git", ["mv", from, to], ...)`. Added `validateMovePath()` at config load time with `SAFE_PATH_RE = /^[A-Za-z0-9_\-./]+$/`, `..` segment rejection, and resolve-outside-repo check.
- Modified file: scripts/move-and-rewrite-imports.mjs:61-108, ~240-260

### M3 Major: CODEOWNERS pattern gap `/src/lib/auth*` doesn't match `src/lib/auth/**` — Resolved
- Action: Added directory patterns `/src/lib/auth/**`, `/src/lib/crypto/**`, `/src/lib/audit/**`. Added comment explaining why both flat-file and directory patterns are required (GitHub `*` does not cross `/`).
- Modified file: .github/CODEOWNERS

### M4 Major: Test-count invariant not implemented — Resolved
- Action: Created `scripts/capture-test-counts.mjs` that runs `npx vitest run --reporter=json --outputFile=<tmp>`, extracts 5 metrics (numTotalTests/numPassedTests/numPendingTests/numFailedTests/numTodoTests — vitest 4 uses numPendingTests for skipped). First-run records baseline at `.refactor-test-count-baseline` (gitignored). Subsequent runs compare; fails on any mismatch. Wired into `refactor-phase-verify.mjs` as step 13/13.
- Modified/created files: scripts/capture-test-counts.mjs (NEW), scripts/refactor-phase-verify.mjs:108, .gitignore:97-98, plan test-count invariant spec

### M5 Major: refactor-phase-verify not wired to CI — Resolved
- Action: Added `.github/workflows/refactor-phase-verify.yml` that runs on push to `refactor/**` and `merge_group` events. Job: checkout with fetch-depth:0, setup Node from .nvmrc, `npm ci`, run `node scripts/refactor-phase-verify.mjs --force`.
- Created file: .github/workflows/refactor-phase-verify.yml

### M6 Major: Codemod fixture suite missing 2 high-value cases — Resolved
- Action: Added 2 fixture tests: (1) "vi.importActual and typeof import rewrite" asserts 4 specifier sites (2× typeof import args + 1× importActual arg + 1× standalone typeof) all rewritten; (2) "rewriteAllowlistFile — C1 regression" seeds check-bypass-rls.mjs + vitest.config.ts with both `audit.ts` and `audit-outbox.ts` entries, moves only `audit.ts`, asserts `audit-outbox.ts` remains untouched.
- Modified file: scripts/__tests__/move-and-rewrite-imports.test.mjs (9 → 11 tests)

### m1 Minor: check-mjs-imports EXTENSIONS included `.ts`/`.tsx` (false-pass) — Resolved
- Action: Split EXTENSIONS (generic `.mjs`/`.js`/`.json`) from TS_EXTENSIONS. TS_EXTENSIONS only considered when specifier has explicit `.ts`/`.tsx` suffix.
- Modified file: scripts/check-mjs-imports.mjs:120-157

### m2 Minor: rename-parity missed `C` copy-rename status — Resolved
- Action: Changed both scripts to accept `parts[0].startsWith("R") || parts[0].startsWith("C")`.
- Modified files: scripts/check-vitest-coverage-include.mjs:260, scripts/verify-allowlist-rename-only.mjs:113

### m5 Minor: verify-allowlist-rename-only duplicate-key bypass — Resolved
- Action: Added duplicate-path detection in `parseAllowedUsage`. If same key appears twice, throws with explicit message. Caller wraps call in try/catch and exits 1 with clear error.
- Modified file: scripts/verify-allowlist-rename-only.mjs:24-56, ~107-114

---

# Round 2 Review
Date: 2026-04-23

## Changes from Previous Round
Verify-only pass on commit `7384d1db`. All R1 Critical (C1) + Major (M1-M6) + Minor (m1/m2/m5) fixes Resolved with one Partial (F6 below). Three deferred items remain deferred with tracked justifications. Two new Minor security findings (S8/S9), one new Major functionality regression (F6 — m2 fix missed one of three scripts), two new Minor functionality/robustness findings (F7 — fallback fragility; T7 — CI baseline ephemeral), plus T5/T6/T8.

## Round 2 Findings Resolution Status

### F6 Major: verify-move-only-diff.mjs missed in m2 C-status fix — Resolved
- Action: Added `|| parts[0].startsWith("C")` to the rename-parsing loop, matching the sibling scripts. Inline comment references the R2 F6 finding.
- Modified file: scripts/verify-move-only-diff.mjs:146-150

### F7 Minor: verify-move-only-diff fallback fragile — Resolved (fail-closed)
- Action: Removed the line-regex fallback entirely; `stripImportExportDeclarations` now throws on ts-morph parse failure with a clear error instructing the operator to fix the parse failure. Rationale: the fallback could not handle multi-line imports or dynamic-import specifier blanking (the very cases M1 and S8 fixes were designed to cover), so silently degrading to it would re-introduce false positives.
- Modified file: scripts/verify-move-only-diff.mjs:~130-160

### S8 Minor: dynamic import / require / vi.mock specifier blanking — Resolved
- Action: `stripImportExportDeclarations` now also collects StringLiteral argument ranges of `CallExpression` where the callee is `ImportKeyword` (dynamic `import()`), `require`, or `vi.{mock,doMock,importActual,importOriginal}`. Also handles `typeof import("...")` type references via `ImportTypeNode → LiteralTypeNode → StringLiteral`. These ranges are blanked (not the whole call/type) so the surrounding logic remains intact and diffable.
- Modified file: scripts/verify-move-only-diff.mjs:72-115

### S9 Minor: SAFE_PATH_RE allowed absolute `/...` paths — Resolved
- Action: Added an explicit leading-slash rejection to `validateMovePath`.
- Modified file: scripts/move-and-rewrite-imports.mjs:69-73

### T5 Minor: capture-test-counts dead dir-fallback — Resolved
- Action: Removed the `readFileSync / readdirSync` fallback. Unused `readdirSync` import removed. Real ENOENT now surfaces directly.
- Modified file: scripts/capture-test-counts.mjs:51-86

### T6 Minor: tmp dir cleanup not in finally — Resolved
- Action: Wrapped the runVitest body in `try { ... } finally { rmSync(...) }`.
- Modified file: scripts/capture-test-counts.mjs:52-88

### T7 Minor: CI baseline ephemeral → gate no-op — Resolved
- Action: Added a new workflow step that creates a `git worktree` at `main`, runs `npm ci` + `capture-test-counts.mjs --record` in the worktree, copies the resulting baseline to the HEAD checkout, then removes the worktree. The subsequent `refactor-phase-verify.mjs` run compares HEAD against the baseline seeded from main. Baseline remains gitignored; CI re-seeds per run.
- Modified file: .github/workflows/refactor-phase-verify.yml:40-54

### T8 Minor: C1 regression test missed .tsx + longer-sibling cases — Resolved
- Action: Added two new fixture tests: `.tsx variant: moving foo.tsx does not corrupt sibling foo-bar.tsx` (uses `vault-context.tsx` + `vault-context-extra.tsx`), and `longer sibling path with same prefix: moving audit.ts does not corrupt auditory-utils.ts`. The test count now invariant 7236 (was 7234).
- Modified files: scripts/__tests__/move-and-rewrite-imports.test.mjs (added 2 `it` blocks in the "rewriteAllowlistFile — C1 regression" describe)

## Round 2 Verification
- npx eslint . → 0 warnings.
- npx vitest run scripts/__tests__/move-and-rewrite-imports.test.mjs → 13 tests pass.
- npx next build → success.
- node scripts/refactor-phase-verify.mjs → 13/13 scripts pass.

## Deferred (tracked, documented as out of scope for this patch)
- **m3 (.mjs in check-dynamic-import-specifiers)** — scope gap acceptable for Phase 0; `.mjs` files in refactor scope do not use vi.mock / vi.importActual patterns. Anti-Deferral check: Out of scope (different feature). Justification: covered by check-mjs-imports.mjs which verifies all `.mjs` import targets resolve; the specifier-variant check (vi.mock etc.) is TS-test-file specific. TODO(split-overcrowded-feature-dirs): add `.mjs` dynamic-import specifier coverage if Phase 5+ introduces .mjs files with vi.mock.
- **m4 (LEDGER_EXEMPT self-verify)** — low risk today. Worst case: `crypto-blob.ts` grows a HKDF string while on the exempt list (requires PR merge with no reviewer noticing). Likelihood: low (CODEOWNERS gates `/src/lib/crypto*`). Cost to fix: ~15 LOC. Acceptable risk given CODEOWNERS gate.
- **m6 (CI replay gate)** — separate larger feature; not a Round-1 blocker. TODO(split-overcrowded-feature-dirs): add `scripts/refactor-phase-replay.mjs` before Phase 2 (crypto moves) begins.
- **m7 (dry-run live-divergence test)** — nice-to-have; dry-run is short-circuit logic with clear early return. Worst case: bug makes dry-run write files. Likelihood: low (existing template-literal FAIL test uses dry-run path). Cost to fix: ~20 LOC. Acceptable; follow-up PR.

