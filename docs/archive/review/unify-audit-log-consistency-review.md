# Plan Review: unify-audit-log-consistency
Date: 2026-04-02
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major]: Personal audit log actor type filter omits SERVICE_ACCOUNT
- Problem: Personal page filter has only HUMAN and MCP_AGENT — SERVICE_ACCOUNT is absent, contradicting the consistency objective
- Impact: Users cannot filter by SERVICE_ACCOUNT in personal audit logs, inconsistent with tenant/team
- Recommended action: Add SERVICE_ACCOUNT to personal page actor type filter
- Resolution: **Accepted** — add SERVICE_ACCOUNT to personal page filter

### F2 [Minor]: Shared module uses JSX in `lib/` directory
- Problem: `src/lib/audit-action-icons.tsx` exports JSX, but `lib/` convention is pure utilities (.ts)
- Impact: Minor convention inconsistency
- Recommended action: Place in `src/components/audit/audit-action-icons.tsx` instead
- Resolution: **Accepted** — move to `src/components/audit/`

## Security Findings
No findings.

## Testing Findings
No findings.

## Adjacent Findings
None.

## Quality Warnings
None.
