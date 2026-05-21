-- Add new AuditAction enum values for OWASP audit batch 3
-- - AUTH_LOGIN_FAILURE: emitted on failed sign-in (C11 / A09-1)
-- - WEBAUTHN_COUNTER_ZERO_RAPID_REUSE: counter==0 device rapid-reuse
--   warning (C10 / A07-2 defense-in-depth)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUTH_LOGIN_FAILURE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WEBAUTHN_COUNTER_ZERO_RAPID_REUSE';
