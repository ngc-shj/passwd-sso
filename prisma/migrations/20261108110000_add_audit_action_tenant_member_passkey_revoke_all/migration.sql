-- #974: a tenant admin revoked all of a member's passkeys via
-- DELETE /api/tenant/members/[userId]/passkeys.
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_MEMBER_PASSKEY_REVOKE_ALL';
