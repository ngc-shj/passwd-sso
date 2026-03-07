# Evaluation: compliance/license-audit

Date: 2026-02-17
Branch: `compliance/license-audit`
Scope: current branch code (including working-tree changes)

## Summary
- Quality is strong and close to production-ready for dependency license governance.
- Recent local fixes improved robustness (allowlist parse error handling + version mismatch enforcement/tests).

## Functional
- `scripts/check-licenses.mjs` now:
  - fails strict on `unreviewed`, `expired`, `schema issues`, and `version mismatches`.
  - prints clear parse errors for malformed allowlist JSON.
- Version mismatch reporting is actionable (`approved=... installed=...`).

## Security / Compliance
- Strong controls are present:
  - strict CI gates for app and extension.
  - expired approvals are blocked.
  - allowlist metadata supports audit trail (`approvedBy`, `reviewedAt`, `expiresAt`, `ticket`, `evidenceUrl`).
- Residual low-risk gap:
  - `packageVersion` matching is exact-string; if policy intends semver ranges, implementation/policy can diverge.

## Test
- Coverage for license checker CLI is solid and improved.
- Verified passing:
  - `npx vitest run scripts/__tests__/check-licenses.test.mjs` (9 tests)
  - `npm run licenses:check:strict`
  - `npm run licenses:check:ext:strict`
- Also verified full test suite and lint:
  - `npm run lint` pass
  - `npm test` pass (102 files, 989 tests)

## Findings
1. `Low` Policy/implementation semantics mismatch risk for `packageVersion`
- If docs allow semver range values, exact equality checks may false-fail.
- Either restrict docs to exact versions or implement semver range parsing.

## Comparison to previous evaluation
- Result: **Different (improved)**.
- Why:
  - Previous report flagged missing/weak areas around parse-error UX and version governance.
  - Current branch state includes both fixes and corresponding tests, reducing risk.
