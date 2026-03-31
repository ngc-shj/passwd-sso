# Plan Review: card-structure-unification
Date: 2026-03-31T12:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Major]: team-rotate-key-button.tsx is already wrapped in Card at page level
- Problem: Step 9 adds a Card wrapper inside the component, but the page (`/src/app/[locale]/admin/teams/[teamId]/security/key-rotation/page.tsx`) already wraps it in Card > CardHeader > CardContent. This would create double-nested Cards.
- Impact: Broken layout, violated "no prop changes" requirement
- Recommended action: Remove team-rotate-key-button.tsx from plan scope
- **Resolution: APPLIED** — Removed from plan Step 4, added exclusion note to Considerations

### F-2 [Major]: Test mocks missing CardHeader/CardTitle/CardDescription/CardContent exports
- Problem: 5 test files mock `@/components/ui/card` with only `Card` export. After refactor, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` will be undefined in tests.
- Impact: vitest run will fail for all 5 test files
- Recommended action: Update each test file's mock to include all Card sub-components
- **Resolution: APPLIED** — Added Step 6 (test mock updates) to plan

### F-3 [Minor]: Sessions i18n keys are redundant
- Problem: Plan adds `cardTitle`/`cardDescription` but Sessions.json already has `title`/`description` keys
- Impact: Unnecessary duplicate keys
- Recommended action: Reuse existing keys
- **Resolution: APPLIED** — Updated Step 1 to reuse existing Sessions keys

### F-4 [Minor]: tenant-audit-log-card variant="all" is dead code
- Problem: `variant="all"` code path is never called. Plan should explicitly remove it.
- Impact: Dead code retained post-refactor
- Recommended action: Explicitly delete variant="all" branch and unused i18n keys
- **Resolution: APPLIED** — Updated Step 5 to explicitly remove dead code

## Security Findings

No findings. Pure UI structural refactoring with no impact on auth, crypto, validation, or data handling.

## Testing Findings

### T-1 [Major]: Card mock incompleteness (same as F-2)
- Merged with F-2 above

### T-2 [Major]: i18n cross-locale alignment risk
- Problem: `messages-consistency.test.ts` checks that en and ja have identical key sets. Missing ja keys will cause test failure.
- Impact: vitest fails if ja keys are not added simultaneously
- Recommended action: Explicitly note "both locales" in plan Step 1
- **Resolution: APPLIED** — Updated Step 1 with bold emphasis on simultaneous addition

### T-3 [Minor]: No rendering tests for team-policy-settings
- Problem: Only `validatePolicy` unit tests exist, no JSX rendering tests
- Impact: JSX-level regressions undetectable by tests (but caught by build)
- Recommended action: Out of scope for this PR, acceptable risk
- **Resolution: DEFERRED** — Not in scope for this refactoring

## Adjacent Findings
None

## Quality Warnings
None
