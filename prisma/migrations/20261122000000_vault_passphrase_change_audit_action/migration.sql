-- A vault passphrase change re-wraps the secret key and revokes the user's
-- other sessions; it is recorded under its own action, like a recovery reset.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VAULT_PASSPHRASE_CHANGE';

COMMIT;
