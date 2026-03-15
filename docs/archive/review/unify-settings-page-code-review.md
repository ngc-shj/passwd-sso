# Code Review: unify-settings-page
Date: 2026-03-15T00:00:00+09:00
Review round: 2

## Changes from Previous Round
Round 1 fixes applied:
- F1 (autoExpandInactive toggle) → resolved via useEffect pattern
- F2 (String() wrap) → resolved

Additional user-driven changes since round 1:
- Webhook cards split into separate form + list Cards
- Team policy categorized into sections
- Sub-tabs merged (Add from Tenant + Invite → Add Member)
- Transfer ownership search added
- Passkey discoverable badge added
- Delete team placement fixed
- Slug read-only styling + 保管庫 terminology fix

## Functionality Findings

### F1 (Minor) Unused Webhook import — RESOLVED
- Both webhook card components imported Webhook icon but no longer used it
- Action: Removed from imports

### F2 (Minor) Transfer empty state message — RESOLVED
- When no transfer candidates exist, showed "no matching members" (search message)
- Action: Added conditional: show "noTransferCandidates" when search is empty

### F3 (Minor) tabGeneralDesc omits delete mention — SKIPPED
- Intentional: Owner-only feature should not be advertised in general tab description

## Security Findings
No findings (UI-only refactoring, no auth/data changes)

## Testing Findings

### T1 (Major) autoExpand behavior untested — RESOLVED
- Added test in both webhook card test files: 5 webhooks (4 active + 1 inactive) at limit → inactive auto-expanded

### T2 (Minor) validationError branch untested — SKIPPED
- Pre-existing untested branch, not introduced by this change

### T3 (Minor) Test naming inaccuracy — SKIPPED
- Pre-existing test, not modified by this change

## Adjacent Findings
None

## Resolution Status

### F1 Unused Webhook import
- Action: Removed `Webhook` from import in both files
- Modified: tenant-webhook-card.tsx:29, team-webhook-card.tsx:28

### F2 Transfer empty state
- Action: Conditional message based on transferSearch.trim()
- Modified: teams/[teamId]/settings/page.tsx, Team.json (en/ja)

### T1 autoExpand test
- Action: Added test case to both webhook test files
- Modified: tenant-webhook-card.test.tsx, team-webhook-card.test.tsx
