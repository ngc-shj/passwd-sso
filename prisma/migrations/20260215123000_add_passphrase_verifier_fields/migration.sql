-- Add passphrase verifier fields used by current Prisma User model.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "passphrase_verifier_hmac" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "passphrase_verifier_version" INTEGER NOT NULL DEFAULT 1;
