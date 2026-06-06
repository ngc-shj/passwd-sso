-- Add SSH_KEY_SIGN and SSH_KEY_SIGN_DENIED to the AuditAction enum.
-- Emitted by POST /api/vault/ssh/sign-authorize when the SSH agent
-- requests per-signature authorization. SSH_KEY_SIGN records a granted
-- signature (entry found, active, owned by the requesting user);
-- SSH_KEY_SIGN_DENIED records a refused signature (entry missing, archived,
-- soft-deleted, or owned by a different user). Both belong to the new
-- group:ssh personal-scope audit group.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SSH_KEY_SIGN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SSH_KEY_SIGN_DENIED';
