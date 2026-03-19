# Code Review: refactor-team-password-endpoints
Date: 2026-03-19
Review round: 1

## Changes from Previous Round
Initial code review

## Functionality Findings

### F1 [Minor] `isArchived` field availability — ACCEPTED
API returns this field. No action needed.

### F2 [Minor] team=null spinner behavior — ACCEPTED
Falls through to loading spinner correctly. Intended behavior per plan.

## Security Findings

### S1 [Minor] Optimistic favorite toggle race — EXISTING (pre-refactor)
Not introduced by this refactor. Out of scope.

### S2 [Minor] permanent=true without trashed check — EXISTING (pre-refactor)
Not introduced by this refactor. Out of scope.

## Testing Findings

### T1 [Major] No component URL assertion tests — RESOLVED
Added URL assertion tests to `team-bulk-wiring.test.ts`:
- `team-archived-list`: asserts `apiPath.teamPasswords(teamId)` + `?archived=true`, no `TEAMS_ARCHIVED`
- `team-trash-list`: asserts `apiPath.teamPasswords(teamId)` + `?trash=true`, no `TEAMS_TRASH`

### T2 [Minor] bulk-wiring readFileSync redundancy — ACCEPTED
Existing pattern. Not changing test architecture in this refactor.

## Resolution Status

### T1 [Major] Component URL assertion tests
- Action: Added 2 test cases to `team-bulk-wiring.test.ts`
- Modified file: src/components/team/team-bulk-wiring.test.ts
