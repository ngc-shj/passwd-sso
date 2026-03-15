# Plan Review: unify-settings-page
Date: 2026-03-15T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Major): Webhook limitReached check includes inactive webhooks
- **Problem**: When inactive webhooks are collapsed, users may not realize they can delete inactive ones to free slots
- **Impact**: Users hit "limit reached" even though free (inactive) slots exist
- **Recommended action**: Auto-expand inactive section when `limitReached && inactiveWebhooks.length > 0`

### F2 (Major): Missing Separator import in plan
- **Problem**: Plan uses Separator but does not mention adding imports
- **Impact**: Build failure if import is forgotten
- **Recommended action**: Add import instruction to plan

### F3 (Minor): Step 6a header description scope unclear
- **Problem**: Header description applies only to main return path, not error/loading
- **Recommended action**: Clarify in plan

## Security Findings

### S1 (Minor): Webhook URLs remain in DOM when collapsed
- **Problem**: No new risk vs current state
- **Recommended action**: Future task, not in scope

### S2 (Minor): TabDescription accepts ReactNode but only receives strings
- **Problem**: Overly permissive type
- **Recommended action**: Restrict to `string` type

## Testing Findings

### T1 (Major): No tests for active/inactive collapse behavior
- **Problem**: Steps 5 & 7 add collapsible sections but no tests specified
- **Recommended action**: Add collapse visibility and toggle tests

### T2 (Major): CollapsibleContent mock ignores open state
- **Problem**: False-positive risk in tests
- **Recommended action**: Update mock to be state-aware

### T3 (Minor): No test for TabDescription component
- **Recommended action**: Add minimal smoke test

### T4 (Minor): i18n interpolation not verifiable with current mock
- **Recommended action**: Update translation mock to reflect params

## Adjacent Findings
None
