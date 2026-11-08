-- #974: a tenant admin revoked a member's passkey via
-- DELETE /api/tenant/members/[userId]/passkeys/[credentialId].
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_MEMBER_PASSKEY_REVOKE';
