# Code Review: fix-watchtower-team-audit-scope

Date: 2026-03-07T00:00:00+09:00
Review round: 1

## Changes from Previous Round

Initial review

## Functionality Findings

### F-1: Missing team membership verification (CRITICAL)
- **File**: `src/app/api/watchtower/alert/route.ts`
- **Problem**: When `teamId` is provided, the route does not verify that the authenticated user is a member of that team. Any authenticated user can inject TEAM-scoped audit logs for any team.
- **Impact**: Unauthorized users can pollute team audit logs and trigger notifications in team context.
- **Recommended fix**: Call `requireTeamMember(session.user.id, teamId)` before proceeding when `teamId` is provided. Return 404 if not a member (consistent with other team endpoints).

### F-2: Notification sent only to requesting user
- **File**: `src/app/api/watchtower/alert/route.ts:77-83`
- **Problem**: In team context, notification is sent only to the requesting user, not all team members.
- **Impact**: Low — acceptable if this is intentional (the requesting user triggered the scan). Document the decision.
- **Recommended fix**: No code change needed if intentional. Noted as design decision.

## Security Findings

### S-1: Missing team membership verification (CRITICAL)
- **File**: `src/app/api/watchtower/alert/route.ts`
- **Problem**: Same as F-1. This is an authorization bypass — any authenticated user can specify any `teamId`.
- **Impact**: Privilege escalation / data integrity violation in team audit logs.
- **Recommended fix**: Add `requireTeamMember()` check with try/catch returning appropriate HTTP error.

### S-2: Whitespace-only teamId accepted
- **File**: `src/app/api/watchtower/alert/route.ts:28`
- **Problem**: `z.string().min(1)` allows whitespace-only strings like `" "`.
- **Impact**: Low — would fail membership check after S-1 fix, but still worth tightening.
- **Recommended fix**: Use `z.string().trim().min(1)` or `z.string().cuid()`.

## Testing Findings

### T-1: No test for unauthorized team access
- **File**: `src/app/api/watchtower/alert/route.test.ts`
- **Problem**: No test verifies that non-members are rejected when specifying a `teamId`.
- **Impact**: The critical security fix (F-1/S-1) would have no test coverage.
- **Recommended fix**: Add test case where `requireTeamMember` throws and verify 404 response.

### T-2: Missing response status assertion in team rate limit test
- **File**: `src/app/api/watchtower/alert/route.test.ts:152-156`
- **Problem**: The "uses team rate limit key" test only checks `mockCheck` but not response status.
- **Impact**: Low — but adds robustness.
- **Recommended fix**: Add `expect(res.status).toBe(200)` assertion.

## Resolution Status

(pending fixes)
