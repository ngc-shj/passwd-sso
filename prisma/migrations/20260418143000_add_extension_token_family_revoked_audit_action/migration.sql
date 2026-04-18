-- Add EXTENSION_TOKEN_FAMILY_REVOKED to the AuditAction enum.
-- Emitted by revokeExtensionTokenFamily() when a family is revoked due to
-- absolute-timeout expiry, replay detection, or explicit sign-out.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTENSION_TOKEN_FAMILY_REVOKED';
