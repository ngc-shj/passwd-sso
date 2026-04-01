# Plan Review: fix-webhook-subscribable-events
Date: 2026-04-01
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

**F1 Minor**: TEAM_WEBHOOK_EVENT_GROUPS uses `ENTRY_DELETE` (dispatched action) while audit groups use `ENTRY_TRASH`/`ENTRY_PERMANENT_DELETE` — naming clarity needed
- Problem: `dispatchWebhook` uses `ENTRY_DELETE` for soft-delete. Audit log groups use `ENTRY_TRASH` and `ENTRY_PERMANENT_DELETE`. Correct but potentially confusing.
- Impact: No breakage. Future contributor confusion risk.
- Recommended action: Add clarifying comment in `TEAM_WEBHOOK_EVENT_GROUPS`.

**F2 Minor**: `GROUP_LABEL_MAP` silent fallback if key missing
- Problem: `base-webhook-card.tsx` uses `tAudit(groupLabelMap[key] ?? key)`.
- Impact: No current breakage. Future risk.
- Recommended action: Add sync comment.

**F3 Minor**: `TENANT_WEBHOOK_EVENT_GROUPS` self-referential exclusion not documented
- Recommended action: Add comment explaining loop prevention.

**F4 Major**: `GROUP_LABEL_MAP` final state not explicit in plan Step 4
- Problem: Step 4 says "add groupServiceAccount" but doesn't list all entries.
- Impact: Implementer might miss existing `groupBreakglass`.
- Recommended action: List complete final `GROUP_LABEL_MAP` in plan.
- **Resolution**: Plan updated with full `GROUP_LABEL_MAP` listing.

**F5 Minor**: Unnecessary export of `*_WEBHOOK_EVENT_GROUPS` to `index.ts`
- Recommended action: Skip `index.ts` export; components import from `audit.ts` directly.
- **Resolution**: Plan updated to remove Step 3 (barrel export).

## Security Findings

**S1 Minor**: `WEBHOOK_METADATA_BLOCKLIST` missing `justification`/`requestedScope`
- Problem: SERVICE_ACCOUNT events now subscribable; these fields could leak in future.
- Recommended action: Add to blocklist proactively.
- **Resolution**: Added as implementation step.

**S2 Minor**: `HISTORY_PURGE` retained as subscribable but never dispatched
- Problem: Inconsistent with plan's approach. False security posture for admins.
- Recommended action: Remove from subscribable list (consistent with MCP_CLIENT/DELEGATION treatment).
- **Resolution**: Plan updated to remove `HISTORY_PURGE` from `TENANT_WEBHOOK_EVENT_GROUPS`.

## Testing Findings

**T1 Major**: `audit.test.ts` lacks concrete test cases for new constants
- Problem: Plan says "add tests" without specifying assertions.
- Recommended action: Add explicit tests for group keys, exclusions, derivation consistency.
- **Resolution**: Plan updated with concrete test cases.

**T2 Major**: TEAM_WEBHOOK_EVENT_GROUPS actions confirmed correct (`ENTRY_CREATE/UPDATE/DELETE` — verified via grep of `dispatchWebhook` calls). Existing tests use audit log group events and must be updated.
- **Resolution**: Test expectations to be updated to match actual dispatch actions.

**T3 Minor**: `tenant-webhook-card.test.tsx` missing SERVICE_ACCOUNT group verification
- **Resolution**: Plan updated to include SERVICE_ACCOUNT assertions.

**T4 Minor**: webhook-card-test-factory sample data uses `ENTRY_DELETE` — this is actually correct for the post-fix state.
- **Resolution**: No change needed — `ENTRY_DELETE` remains a valid team webhook event.

## Adjacent Findings
None

## Quality Warnings
None (all flagged items verified with evidence from codebase)

---

## Round 2

Date: 2026-04-01

### Changes from Round 1
All 10 Round 1 findings resolved in plan update:
- HISTORY_PURGE removed from subscribable list
- GROUP_LABEL_MAP final state made explicit
- index.ts barrel export removed
- JSDoc comments added for ENTRY_DELETE distinction and intentional exclusions
- justification/requestedScope added to WEBHOOK_METADATA_BLOCKLIST
- Concrete test cases specified in Step 6

### Functionality Findings (Round 2)
- 2 Minor findings (test name updates): incorporated into plan

### Security Findings (Round 2)
No findings. All Round 1 fixes verified correct.

### Testing Findings (Round 2)
- 3 Major findings (M1-M3): These describe the current state vs planned state — the plan already specifies these changes in Step 6. Added negative assertion details and test name updates to plan.

### Result
All experts returned no actionable plan-level findings. Minor enhancements incorporated.
**Plan review complete.**
