# Plan Review: team-member-direct-add
Date: 2026-03-12
Review round: 2

## Changes from Previous Round
1. logAudit atomicity clarified as fire-and-forget (F1)
2. Search API uses explicit tenantId filter, not RLS-dependent (F2)
3. TEAM_MEMBER_ADD only in AUDIT_ACTION_GROUPS_TEAM (F3)
4. cuid v1 confirmed consistent (F4)
5. Reactivation resets scimManaged: false (S1)
6. Reactivation deletes TeamMemberKey records (S2)
7. Expired invitations: only non-expired PENDING excluded (T2)
8. Design decisions documented (role hierarchy, SCIM scope, audit atomicity)
9. Manual test cases expanded to 10

## Round 2 Findings

### Functionality

#### F5 [Major] TeamInvitation has no userId — email→userId conversion needed (RESOLVED)
Plan Step 5 now explicitly describes: fetch pending invitation emails, then resolve to userIds via User.findMany.

#### F6 [Minor] TeamMemberKey cleanup asymmetry with accept/route.ts (RESOLVED)
Documented as Design Decision #4 and Consideration #8. Separate PR recommended.

#### F7 [Minor] $transaction semantics within RLS context (RESOLVED)
Documented as Design Decision #5. Promise.all behavior noted.

#### F8 [Minor] logAudit targetId specification (RESOLVED)
Plan now specifies: targetType: TEAM_MEMBER, targetId: member.id, metadata includes userId/role/reactivated.

### Security

#### N1 [Major] accept/route.ts TeamMemberKey gap (RESOLVED — out of scope)
Documented as Consideration #8. Pre-existing issue, separate PR to avoid regression.

#### N2 [Minor] LIKE special characters (RESOLVED)
Manual test case #10 covers this. min(1) validation prevents empty queries.

#### N3 [Minor] withTeamTenantRls doesn't return tenantId (RESOLVED)
Plan Step 5 & 6 now explicitly show prisma.team.findUnique to get tenantId inside the callback.

### Testing

#### N1-T [Major] Same as Security N1 — accept/route.ts gap (RESOLVED — out of scope)

#### N2-T [Minor] Invitation creation expiresAt check gap (RESOLVED — out of scope)
Documented as Consideration #9. Pre-existing issue.

#### N3-T [Minor] No auto-test for PERSONAL group exclusion (RESOLVED)
Plan Step 2 explicitly states "NOT to AUDIT_ACTION_GROUPS_PERSONAL". Implementation will verify.

## Summary

All Major findings from Round 1 resolved. All Major findings from Round 2 resolved (out-of-scope items documented in Considerations).
No remaining Critical or Major issues. Minor items all addressed through documentation or plan clarification.
