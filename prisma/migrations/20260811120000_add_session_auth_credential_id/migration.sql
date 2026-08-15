-- Bind step-up reauth to the credential that established the session
-- (C1 + C7's declarative half): sessions.auth_credential_id records the
-- webauthn_credentials row a passkey sign-in was verified against. NULL
-- means "no binding" — every existing row lands there, since this is
-- additive-only (R24); no strict constraint here.
--
-- Wrapped explicitly: Prisma does not put PostgreSQL migrations in a
-- transaction, so five statements unwrapped means a failure partway leaves a
-- half-applied schema while the old code is still live. `ALTER TYPE … ADD
-- VALUE` is transactional from PostgreSQL 12 on; the restriction that remains
-- is that the new value cannot be USED in the same transaction, which nothing
-- here does.
BEGIN;

ALTER TABLE "sessions"
  ADD COLUMN "auth_credential_id" UUID;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_auth_credential_id_fkey"
    FOREIGN KEY ("auth_credential_id") REFERENCES "webauthn_credentials"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sessions_auth_credential_id_idx" ON "sessions"("auth_credential_id");

-- C7: audit actions for the two new step-up denial shapes this change
-- introduces (credential mismatch, and no live binding to reauth against).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUTH_PASSKEY_REAUTH_UNAVAILABLE';

COMMIT;
