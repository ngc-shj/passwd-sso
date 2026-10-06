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
