-- Add AUTH_PASSKEY_REAUTH to the AuditAction enum so the in-session passkey
-- step-up can be distinguished from full sign-in (AUTH_LOGIN) in audit logs.
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_PASSKEY_REAUTH';
