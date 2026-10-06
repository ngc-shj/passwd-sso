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
