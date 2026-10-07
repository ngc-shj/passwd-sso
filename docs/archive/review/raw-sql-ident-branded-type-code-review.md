# Code Review: raw-sql-ident-branded-type
Date: 2026-10-06
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening: no actionable finding (self-resolving analysis). Functionality seed truncated → full-diff review.

## Functionality Findings
No findings. Verified: worker bundle boot smoke (VE1), NF1 diff check, Implementation Checklist vs diff, no genuine value on a log/metadata path.

## Security Findings (Opus)
- F1 [Critical, escalate] `import r = Prisma.raw` treated as a type position.
- F2 [Critical, escalate] start-anchored Prisma pattern missed `node_modules/@prisma/...` paths.
- F3 [Major] UNSCANNED_IMPORT ignored require()/import()/import-equals.
- F4 [Major] `renderSql(...)` accepted without the canonical import; literal-keyed globals and a shadow `raw-sql.js` forge it.
- F5 [Minor] `RegExp.prototype.exec` / `Set.prototype.has` looked up at call time.
- F6 [Minor, Adjacent] `.jsx` and symlinks unscanned.
- D-5 verdict: acceptable under the threat model; recommended a measured allowlist instead of a blanket residual.
- Note: the reviewer briefly wrote a probe file into the repo (`src/__probe_tmp_never.ts`) and deleted it; nothing committed.

## Testing Findings
- T-F1 [Minor] raw-sql.ts self-exemption unproven; T-F2 [Minor] gate self-exemption unproven; T-F3 [Minor] RAW_METHOD backtick literal row missing. Seed 3 (whitespace-pin comment) rejected: comments already present.

## Adjacent Findings
F6 (scan scope).

## Recurring Issue Check
### Functionality expert
R1–R3, R5, R9, R10, R12, R16–R20, R22, R29, R32–R34, R36, R40–R42, R44–R46, R49, R50, R55, R57 Clear; others N/A.
### Security expert
R3 (F3), R42 (F3, F4, F6), R47 (F1, F2, F4), R49 (F5) hit; R46 premise gap (F4); RS3 clean; others N/A.
### Testing expert
RT1, RT5, RT6, RT7, RT9, RT10, RT11, R19, R33 clean.

## Environment Verification Report
- VE1 — `verified-local`: `bash scripts/checks/check-worker-bundle-smoke.sh` (functionality reviewer) and pre-pr's worker-bundle smoke.
- VE2 — `verified-local`: `docker compose stop audit-outbox-worker retention-gc-worker && npm run test:integration` → 118 files pass (after D-10).

## Resolution Status
All round-1 findings fixed in one commit (review(1)); each red-proven on a scratch copy (unfixed → allow, fixed → deny with the named reason):
- F1: `IMPORT_EQUALS_ENTITY` rule; QualifiedName skipped only in real type references.
- F2: segment-based Prisma match; `node_modules` segment denied in module specifiers.
- F3: UNSCANNED_IMPORT covers require()/import()/import-equals literals.
- F4: (a) canonical import required for allowed-position uses; (b) literal naming one of the four names denies; (c) shadow raw-sql candidates deny, `.js` resolution checks real siblings.
- F5: `regExec` / `reservedHas` bound at load; tamper tests.
- F6: `.jsx` scanned; `SYMLINK_SCAN_TARGET`.
- D-5: `NON_LITERAL_IMPORT_ALLOWLIST` (check-env-docs.ts ×4, messages.ts ×2, crypto-client.ts ×1); others and count drift deny.
- T-F1..T-F3: rows added.
Verification: 187/187 targeted tests, gate OK on the tree (~12.5s), tsc and eslint clean.

---

# Round 2
Date: 2026-10-06

## Changes from Previous Round
Reviewed the review(1) fixes (72fdbe3f8). All round-1 findings confirmed resolved, no regressions.

## Functionality Findings
- F-R2-1 [Major] NON_LITERAL_IMPORT_ALLOWLIST: a deleted or renamed allowlisted file was never detected (the comment claimed no drift in either direction); count-mismatch message did not say where to update.
- F-R2-2 [Minor] each rule re-walks the AST per file.
- F-R2-3 [Minor, Adjacent] Residual did not state that the canonical-import requirement does not follow re-exports.

## Security Findings (Opus)
- N1 [Major] a test-path literal handed to a loader under another name (`createRequire(...)(...)`, `module.require`, `require.call`, `new Worker(new URL(...))`) escaped UNSCANNED_IMPORT.
- N2 [Minor] shadow set omitted `raw-sql.tsx` (Next/esbuild resolve `.tsx` before `.ts`).

## Testing Findings
- [Major] node_modules specifier position scoping had no allow row.
- [Minor] shadow `raw-sql/index.tsx` / `index.js` deny rows; per-extension allow rows (.mts/.cts/.js/.mjs/.cjs/.jsx); allow + count-mismatch rows for check-env-docs.ts ×4 and crypto-client.ts ×1.

## Resolution Status
Fixed in review(2) (961e3e05c), each red-proven on a scratch copy:
- N1: any expression-position literal resolving into an excluded test path denies, whatever its parent. Exempt: the gate itself and `scripts/checks/classify-fail-closed-test.mjs` (measured: 1 data literal naming the helper module). Header and Residual reworded.
- N2: shadow set derived from the scanned extension set (every non-`.ts` sibling; every `raw-sql/index.<ext>`).
- F-R2-1: post-loop coverage check denies a stale allowlist key; mismatch message names the file to update; comment corrected.
- F-R2-3: Residual line added (re-export of the four names is already denied, so no barrel can exist).
- Testing: all rows added. `require("x", "node_modules/y")` pinned as allow (only `arguments[0]` is a specifier; red-proof: forcing the position check to true flips it).
- F-R2-2: Skipped — performance only; gate runtime 12.6–12.9s vs 12.5s baseline, runs in pre-pr's parallel batch. Anti-Deferral: cost-to-fix is a rule-loop restructure across ~15 rules touching a security gate for no detection change; worst case is seconds of CI time.
Verification: 214/214 targeted tests (gate + raw-sql), gate OK on the tree, eslint clean.

---

# Round 3
Date: 2026-10-07

## Changes from Previous Round
Reviewed review(2) (961e3e05c). Security (Opus) + functionality/testing (combined).

## Security Findings (Opus)
- S-R3-1 [Major, verified bypass] `"@/lib/prisma/raw-sql/"` / `"./raw-sql/."` normalized to raw-sql and were credited as a canonical raw-sql.ts import, while tsx/Node resolve the directory (`raw-sql/package.json` "main" → an unscanned `*.test.ts` forging renderSql). Pre-existing resolver defect, not introduced by round 2.
- S-R3-2 [Minor] N1 header overclaimed "any name or call shape" (fires only for `./`, `../`, `@/` literals); `?raw` suffixes and case variants slipped the test-path match.
- S-R3-3 [Minor] whole-file exemption of classify-fail-closed-test.mjs wider than its one measured literal.
- F-R2-1: no findings.

## Functionality Findings
- [Minor] N1 scan double-reported literals already inspected by checkUnscannedImport.

## Testing Findings
- [Major] the node_modules position-scoping allow row had no exact `node_modules` segment, so it passed with the position guard deleted.
- [Minor] "(N2)" label on index.tsx/index.js rows overclaimed; missing deny row for the exempt literal in a non-exempt file.

## Resolution Status
Fixed in review(3), each red-proven on a scratch copy:
- S-R3-1: (a) a specifier whose last raw segment is empty/`.`/`..` resolves only to directory candidates, never `raw-sql.ts`; (b) an on-disk `src/lib/prisma/raw-sql/` directory (case-insensitive) denies, subsuming the `raw-sql/index.<ext>` shadow entries.
- S-R3-2: `?`/`#` suffix stripped and test paths matched case-insensitively in resolvesToUnscannedPath; header narrowed; non-prefixed `new URL()`, path-join and absolute specifiers listed in the Residual.
- S-R3-3: exemption is per literal with a measured count (`"@/__tests__/helpers/fail-closed"` ×1).
- Functionality: module-specifier-position literals skipped in the N1 scan (same three shapes checkUnscannedImport inspects); single-report test.
- Testing: position-scoping row uses `"foo/node_modules/bar"`; labels corrected; non-exempt-file deny row added.
Verification: 225/225 targeted tests, gate OK on the tree (~13s), eslint clean.

---

# Round 4
Date: 2026-10-07

## Changes from Previous Round
Security-only round (Opus) on review(3) (24dad1613), asked to treat S-R3-1 as a class: every way the gate's model of specifier resolution can diverge from tsx / Node / TypeScript / esbuild.

## Security Findings (Opus)
- S-R4-1 [Major, verified] UNSCANNED_IMPORT treated only test paths as unscanned: `../../docs/forge`, `@/../cli/src/forge`, `./h.TS` loaded raw SQL past both layers.
- S-R4-2 [Major, verified] canonical-import credit compared lowercased paths: `@/lib/Prisma/raw-sql` (directory with package.json main) and `@/lib/prisma/raw-sql.TS` executed a forged renderSql on case-sensitive Linux.
- S-R4-3 [Minor, verified] `./h%2Etest.mjs` — Node ESM percent-decodes, the gate did not.
- S-R4-4 [Minor] `..` above the repo root silently clamped.
- Clean: the round-3 exclusion, `specifierEndsAsDirectory`, `checkRawSqlDirectoryShadow`, `?#` stripping, per-literal exemption counting; no tsconfig `baseUrl`, single `paths` target, no package.json `imports`/`exports`/`main`.

## Resolution Status
Mechanism change (deviation D-12) in review(4) (0a1e23f49) instead of a fifth shape patch:
- One `resolveOnDisk` walks Node/TS candidates in order against exact-case readdir listings; returns FILE / PACKAGE_DIR / CASE_MISMATCH / ESCAPES_ROOT / SUSPICIOUS (`%`) / NOT_FOUND.
- Grant: canonical only when FILE is exactly `src/lib/prisma/raw-sql.ts`. Deny-side raw-sql matching stays case-insensitive.
- UNSCANNED_IMPORT: any target other than a scanned file or `.json` denies; NOT_FOUND falls back to the test-path shape. Measured per-literal exemptions: classify-fail-closed-test.mjs (1), generate-team-key-fixture.ts (2, extension crypto for a cross-codebase golden fixture), next-env.d.ts (2, counted by occurrence since `.next/` is absent on CI), layout.tsx `./globals.css` (1).
- A `.`/`..`-only literal outside a module-specifier position is judged by what that ancestor directory can load (package.json main/exports denies; index file judged as a target; above the root allowed), replacing 19 per-file exemptions for the scripts/ repo-root idiom.
- All round-4 probes are deny rows; each resolver branch and the ancestor-literal rule red-proven on a scratch copy.
Verification: 254/254 targeted tests, gate OK on the tree (~13.5s), eslint clean.

---

# Round 5
Date: 2026-10-07

## Changes from Previous Round
Security + correctness (Opus) on review(4) (0a1e23f49), the on-disk resolver.

## Security Findings (Opus)
- S-R5-1 [Major, same class, verified] pre-resolution divergence: the gate always stripped `?`/`#` and never URL-normalized, while tsx CJS keeps `#` in a file name (`../src/lib/prisma/raw-sql#x` credited as raw-sql.ts, tsx ran an unscanned forgery), plain Node CJS keeps `?`/`#`, and Node ESM `new URL()` strips tab/LF, trims spaces, maps `\` to `/`.
- F-R5-1 [Major, tangential] `npm run dev` regenerates the gitignored `next-env.d.ts` with `./.next/dev/types/...`, failing the local gate (pre-pr) after any dev session.
- M1 [Minor] malformed package.json crashed the ancestor rule with a raw stack.
- M2 [Minor] "outside the Layer 2 scan" message gave no next step.
- M3 [Minor] exemptions key on (file, literal, count), not on what the target loads — not in the Residual.
- Clean: candidate order vs tsx/Node/TS/esbuild, file-over-directory, `@/..`, symlinked targets, `.d.ts`, grant side otherwise.

## Resolution Status
Fixed in review(5):
- S-R5-1: refuse the undecidable class. Module-specifier positions and the grant: a repo-shaped specifier outside `[A-Za-z0-9@._/-]` is SUSPICIOUS (deny, never credited); `?#` stripping removed from resolution. Measured: 6436 such specifiers on the tree, all inside the charset. Other literals (171 repo-shaped, 1 with spaces — a message string): judged under four readings (raw, `?#`-stripped, URL-normalized, both); any reading reaching an unscanned target or test path, or containing `%`, denies.
- F-R5-1: `next-env.d.ts` excluded from the scan as a named generated, gitignored file; its exemption removed.
- M1: malformed / non-object package.json reported as an UNSCANNED_IMPORT violation naming the file.
- M2: message names UNSCANNED_LITERAL_EXEMPTIONS and the `.json`-only data rule.
- M3: Residual line added.
Each branch red-proven on a scratch copy (10 mutations). Verification: 272/272 targeted tests, gate OK (~13.5s), eslint clean.
