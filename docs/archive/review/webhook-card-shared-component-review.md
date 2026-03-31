# Plan Review: webhook-card-shared-component
Date: 2026-03-31
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major]: `fetchDeps` mechanism breaks stale closure for `teamId`
- Problem: `config` is recreated each render as an object literal. Using it in `useCallback` deps causes infinite loop; omitting it causes stale closures for `deleteEndpoint` and other functions.
- Impact: `teamId` change won't trigger refetch, or infinite re-render loop.
- Recommended action: Destructure config at top; use individual primitives in hook deps; store `deleteEndpoint` in `useRef`.
- **Resolution**: Reflected in plan (Key Design Decision #2, Step 1).

### F2 [Minor]: `groupLabelMap` type could be stricter
- Problem: `Record<string, string>` allows missing keys without type error. New groups silently fall back.
- Impact: Display bug for new groups (not runtime error).
- Recommended action: Improve type annotation during implementation.
- **Resolution**: Noted for implementation phase.

### F3 [Minor]: `renderWebhookItem` closure not explicit in plan
- Problem: Plan didn't specify that `renderWebhookItem` must remain an internal closure.
- Impact: Risk of scope loss if incorrectly extracted as separate component.
- Recommended action: Add explicit note in plan.
- **Resolution**: Reflected in plan (Key Design Decision #6, Step 1).

## Security Findings

### S1 [Minor]: `fetchDeps?: unknown[]` too loosely typed
- Problem: Overlaps with F1. `unknown[]` accepts any value, potentially causing unstable reference comparison.
- Impact: Low — currently only `[teamId]` is passed.
- Recommended action: Addressed by F1 resolution (destructure individual values).
- **Resolution**: Merged with F1.

### S2 [Minor]: `deleteEndpoint` function accepts arbitrary URL strings
- Problem: Theoretical URL injection risk since function returns arbitrary string.
- Impact: Low — current usage exclusively uses `apiPath.*` helpers; frontend-only code.
- Recommended action: Add JSDoc comment noting `apiPath.*` requirement.
- **Resolution**: Noted for implementation phase.

## Testing Findings

### T1 [Major]: `createWebhookCardTests` factory contract undefined
- Problem: Plan lacked `opts` type definition. Risk of incorrect factory boundary.
- Impact: Incorrect mock setup (e.g., `useLocale` handling).
- Recommended action: Define `opts` type in plan.
- **Resolution**: Reflected in plan (Step 4 with full type definition).

### T2 [Minor]: `Collapsible` mock ignores `open` prop
- Problem: Both test files mock `Collapsible` without respecting `open` state. Auto-expand test could be false positive.
- Impact: Won't detect regression in auto-expand logic.
- Recommended action: Fix mock in factory.
- **Resolution**: Reflected in plan (Step 4 note).

### T3 [Minor]: Missing positive assertion for team event groups
- Problem: Team tests only exclude webhook group but don't assert expected events are present.
- Impact: Silent event group filter breakage undetected.
- Recommended action: Add positive assertion test for team.
- **Resolution**: Reflected in plan (Step 6, Testing Strategy).

## Adjacent Findings

### [Adjacent] S3 [Major]: Unknown event keys from server displayed in UI
- Origin: Security expert
- Routes to: Functionality expert scope
- Problem: `tAudit(e)` passes server-returned event names directly. Unknown keys display raw string. React auto-escapes, so no XSS.
- Impact: UI pollution with unknown keys. Pre-existing issue, not introduced by this refactor.
- Recommended action: Out of scope for this refactor. Track as separate improvement.

## Quality Warnings
None
