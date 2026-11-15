-- `tenant-domain rekey-accounts` moves a tenant's legacy `saml-jackson`
-- accounts onto the per-connection provider and re-encrypts their tokens
-- under the new AAD. Each moved account is recorded under its own action so
-- the tenant's log tells the move apart from an ordinary account link.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCOUNT_PROVIDER_REKEYED';

COMMIT;
