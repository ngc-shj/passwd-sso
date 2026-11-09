# Code Review: scim-team-role-raise-approval
Date: 2026-11-09
Review round: 1

## Changes from Previous Round
Initial review, incremental on a clean Phase 2 self-check. Seeds unavailable — full-diff review.

## Functionality Findings
- F1 [Minor] A held raise read as a first-time admission in the audit-log UI: `getTargetLabel` had
  no branch for the SCIM actions, so `previouslyActive` / `previousRole` were visible only in
  metadata, export and webhooks.

## Security Findings
No findings. Verified: no SCIM path raises an active role in place (PATCH and PUT reach only
`applyAddOperations`); a held row authorizes nothing and no reactivation path (approve, invitation
accept, manual PUT/transfer, tenant return, key distribution) admits it without approval; key
deletes follow the rows written; audit in the SCIM transaction.

## Testing Findings
- QA-1 [Minor] The ROLE_UPDATE-empty assertions in A7d and R9 can no longer fail.
- QA-2 [Minor] Route A7e asserted the key-delete count, not whose keys.
- QA-3 [Minor] No red-proof for `previouslyActive` keyed on the transition kind.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
Effects from rows written: OK. Transition kinds vs audit mapping vs count: OK. Positive controls: OK.
Vacuous tests: OK. Doc claims vs code: F1. en/ja parity: OK.

### Security expert
Effects from the pre-read: fixed in both arms. Audit in transaction: OK. Child rows scoped: OK. Lock
coverage: OK (19 → 21). Negative assertions with controls: OK. Bypass-class enumeration: every
reactivation path refuses or needs approval.

### Testing expert
Vacuous negatives: QA-1 (redundant, not the only check). Positive controls: OK. Sleeps: none.
Mock/Prisma shape: OK. Mock leak: none. Cleanup: OK.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. Integration `verified-local`; CI pending.

## Resolution Status

### Round 1
- F1 — Action: `getCommonTargetLabel` shows `TEAM_MEMBER_SCIM_ROLE_UPDATE` and a
  `TEAM_MEMBER_SCIM_PENDING` with `previouslyActive: true` with the existing `roleChange` template
  (`previousRole → role`); a pending-row raise (no `previouslyActive`) still renders no label. Three
  cells in `src/lib/audit/audit-target-label.test.ts`.
- QA-1 — Action: kept as regression markers with a comment saying the key and PENDING assertions
  carry those cells.
- QA-2 — Action: A7e asserts the two key-delete calls' `userId` sets (reactivate users, then hold
  users; never the demoted ones).
- QA-3 — Action: mutant M4 (key on `previousRole`) recorded in the deviation log: route A7e ×2 and
  integration A10 ×2 red.
