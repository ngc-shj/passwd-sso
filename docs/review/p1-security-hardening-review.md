# Plan Review: p1-security-hardening

Date: 2026-03-07
Review round: 3

## Changes from Previous Round

Round 2 had 1 finding (F6: Section 1b omitted tenantId for team member
removal). Fixed by changing to
`invalidateUserSessions(target.userId, { tenantId: target.tenantId })`.

## Round 2 Resolution Verification

- F6 (tenantId in 1b): Section 1b now passes `{ tenantId: target.tenantId }`,
  consistent with section 1c's multi-tenant guidance.

## Functionality Findings

### F7: SCIM PUT and PATCH are separate handlers but plan treats them as one

- **Problem:** Section 1c used "PATCH/PUT with `active: false`" as a single
  bullet, but PUT and PATCH are completely independent handlers with different
  code paths. The PUT handler returns `auditAction` from `withTenantRls`,
  while PATCH has its own deactivation logic. Treating them as one risks
  missing the PUT handler during implementation.
- **Impact:** Low — the intent was correct, but ambiguous wording could lead
  to the PUT handler being overlooked.
- **Recommended action:** Split into explicit PUT and PATCH bullets with
  implementation guidance for each.
- **Resolution:** Fixed. Section 1c now has separate bullets for PUT handler
  and PATCH handler, with explicit `auditAction === SCIM_USER_DEACTIVATE`
  check guidance for each.

## Security Findings

No findings.

## Testing Findings

No findings.
