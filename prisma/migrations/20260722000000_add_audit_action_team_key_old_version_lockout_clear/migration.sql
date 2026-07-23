-- Add two AuditAction enum values (external-review-2026-07 remediation, C2 + C5):
--   TEAM_MEMBER_KEY_OLD_VERSION_READ  — a team member fetched a non-latest
--     TeamMemberKey (post-rotation forensics; C2).
--   TENANT_MEMBER_LOCKOUT_CLEAR       — a tenant admin (or self) cleared a
--     member's vault-unlock lockout via /api/tenant/members/[userId]/clear-lockout (C5).
ALTER TYPE "AuditAction" ADD VALUE 'TEAM_MEMBER_KEY_OLD_VERSION_READ';
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_MEMBER_LOCKOUT_CLEAR';
