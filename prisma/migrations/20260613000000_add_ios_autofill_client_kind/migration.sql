-- Add the IOS_AUTOFILL client kind for the short-lived, DPoP-bound,
-- passwords:write-only token the host app mints for its AutoFill extension
-- (passkey registration upload). ADD VALUE must run in its own migration —
-- Postgres forbids using a newly added enum value in the same transaction.
ALTER TYPE "ExtensionTokenClientKind" ADD VALUE IF NOT EXISTS 'IOS_AUTOFILL';
