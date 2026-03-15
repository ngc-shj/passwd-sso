# Code Review: unify-settings-page
Date: 2026-03-15T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Major): autoExpandInactive prevents toggle from closing inactive section
- **File**: tenant-webhook-card.tsx, team-webhook-card.tsx
- **Problem**: `(showInactive || autoExpandInactive)` condition means user cannot close section when limitReached
- **Fix**: Replaced with useEffect that sets showInactive=true when limitReached, then uses showInactive only

### F2 (Minor): Unnecessary String() wrap for i18n count parameter
- **File**: tenant-webhook-card.tsx L307, team-webhook-card.tsx L309
- **Fix**: Removed String() wrapper

## Security Findings

All findings (S1-S5) relate to pre-existing code not modified by this PR:
- S1-S2: Missing assertOrigin on webhook API routes (existing code)
- S3: SSRF via DNS rebinding in webhook delivery (existing API code, not UI)
- S4: Webhook secret rendered as plaintext input (existing behavior)
- S5: Client-only admin gate for tenant settings (existing architecture)

No security issues introduced by this change.

## Testing Findings

All findings (T1-T7) relate to pre-existing test patterns not changed by this PR:
- T1: Collapsible mock always renders (existing mock for event group checkboxes)
- T2-T4: Missing assertions in existing tests (form reset, toast.success negation, delete refresh)
- T5-T7: Minor existing test quality issues

No testing issues introduced by this change.

## Adjacent Findings
None

## Resolution Status

### F1 (Major) autoExpandInactive toggle fix
- Action: Replaced autoExpandInactive computed value with useEffect that sets showInactive state; display condition now uses showInactive only
- Modified files: tenant-webhook-card.tsx, team-webhook-card.tsx

### F2 (Minor) String() removal
- Action: Removed String() wrapper from inactiveWebhooks count parameter
- Modified files: tenant-webhook-card.tsx, team-webhook-card.tsx
