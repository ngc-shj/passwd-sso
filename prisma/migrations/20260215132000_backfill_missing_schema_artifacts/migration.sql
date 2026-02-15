-- Backfill schema artifacts that are present in prisma/schema.prisma
-- but missing from older migration history.
-- This migration is idempotent so it can run safely on dev DBs that were
-- already patched manually.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryType') THEN
    CREATE TYPE "EntryType" AS ENUM ('LOGIN', 'SECURE_NOTE', 'CREDIT_CARD', 'IDENTITY', 'PASSKEY');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmergencyAccessStatus') THEN
    CREATE TYPE "EmergencyAccessStatus" AS ENUM ('PENDING', 'ACCEPTED', 'IDLE', 'STALE', 'REQUESTED', 'ACTIVATED', 'REVOKED', 'REJECTED');
  END IF;
END$$;

ALTER TABLE "org_password_entries"
  ADD COLUMN IF NOT EXISTS "aad_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "entry_type" "EntryType" NOT NULL DEFAULT 'LOGIN';

ALTER TABLE "password_entries"
  ADD COLUMN IF NOT EXISTS "aad_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "entry_type" "EntryType" NOT NULL DEFAULT 'LOGIN';

CREATE TABLE IF NOT EXISTS "extension_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "scope" VARCHAR(255) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  CONSTRAINT "extension_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "password_shares" (
  "id" TEXT NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "entry_type" "EntryType" NOT NULL,
  "encrypted_data" TEXT NOT NULL,
  "data_iv" VARCHAR(24) NOT NULL,
  "data_auth_tag" VARCHAR(32) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "max_views" INTEGER,
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "revoked_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "password_entry_id" TEXT,
  "org_password_entry_id" TEXT,
  CONSTRAINT "password_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "share_access_logs" (
  "id" TEXT NOT NULL,
  "share_id" TEXT NOT NULL,
  "ip" VARCHAR(45),
  "user_agent" VARCHAR(512),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "share_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "attachments" (
  "id" TEXT NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "encrypted_data" BYTEA NOT NULL,
  "iv" VARCHAR(24) NOT NULL,
  "auth_tag" VARCHAR(32) NOT NULL,
  "key_version" INTEGER,
  "aad_version" INTEGER NOT NULL DEFAULT 0,
  "password_entry_id" TEXT,
  "org_password_entry_id" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "emergency_access_grants" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "grantee_id" TEXT,
  "grantee_email" TEXT NOT NULL,
  "status" "EmergencyAccessStatus" NOT NULL DEFAULT 'PENDING',
  "wait_days" INTEGER NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "token_expires_at" TIMESTAMP(3) NOT NULL,
  "key_algorithm" VARCHAR(32) NOT NULL DEFAULT 'ECDH-P256',
  "grantee_public_key" TEXT,
  "owner_ephemeral_public_key" TEXT,
  "encrypted_secret_key" TEXT,
  "secret_key_iv" VARCHAR(24),
  "secret_key_auth_tag" VARCHAR(32),
  "hkdf_salt" VARCHAR(64),
  "wrap_version" INTEGER NOT NULL DEFAULT 1,
  "key_version" INTEGER,
  "kem_ciphertext" TEXT,
  "kem_public_key" TEXT,
  "requested_at" TIMESTAMP(3),
  "activated_at" TIMESTAMP(3),
  "wait_expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "emergency_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "emergency_access_key_pairs" (
  "id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "encrypted_private_key" TEXT NOT NULL,
  "private_key_iv" VARCHAR(24) NOT NULL,
  "private_key_auth_tag" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emergency_access_key_pairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "extension_tokens_token_hash_key" ON "extension_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "extension_tokens_user_id_revoked_at_idx" ON "extension_tokens"("user_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "extension_tokens_expires_at_idx" ON "extension_tokens"("expires_at");

CREATE UNIQUE INDEX IF NOT EXISTS "password_shares_token_hash_key" ON "password_shares"("token_hash");
CREATE INDEX IF NOT EXISTS "password_shares_password_entry_id_idx" ON "password_shares"("password_entry_id");
CREATE INDEX IF NOT EXISTS "password_shares_org_password_entry_id_idx" ON "password_shares"("org_password_entry_id");
CREATE INDEX IF NOT EXISTS "password_shares_expires_at_idx" ON "password_shares"("expires_at");

CREATE INDEX IF NOT EXISTS "share_access_logs_share_id_created_at_idx" ON "share_access_logs"("share_id", "created_at");

CREATE INDEX IF NOT EXISTS "attachments_password_entry_id_idx" ON "attachments"("password_entry_id");
CREATE INDEX IF NOT EXISTS "attachments_org_password_entry_id_idx" ON "attachments"("org_password_entry_id");

CREATE UNIQUE INDEX IF NOT EXISTS "emergency_access_grants_token_hash_key" ON "emergency_access_grants"("token_hash");
CREATE INDEX IF NOT EXISTS "emergency_access_grants_owner_id_idx" ON "emergency_access_grants"("owner_id");
CREATE INDEX IF NOT EXISTS "emergency_access_grants_grantee_id_idx" ON "emergency_access_grants"("grantee_id");
CREATE INDEX IF NOT EXISTS "emergency_access_grants_status_idx" ON "emergency_access_grants"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "emergency_access_key_pairs_grant_id_key" ON "emergency_access_key_pairs"("grant_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'extension_tokens_user_id_fkey') THEN
    ALTER TABLE "extension_tokens"
      ADD CONSTRAINT "extension_tokens_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_shares_created_by_id_fkey') THEN
    ALTER TABLE "password_shares"
      ADD CONSTRAINT "password_shares_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_shares_password_entry_id_fkey') THEN
    ALTER TABLE "password_shares"
      ADD CONSTRAINT "password_shares_password_entry_id_fkey"
      FOREIGN KEY ("password_entry_id") REFERENCES "password_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_shares_org_password_entry_id_fkey') THEN
    ALTER TABLE "password_shares"
      ADD CONSTRAINT "password_shares_org_password_entry_id_fkey"
      FOREIGN KEY ("org_password_entry_id") REFERENCES "org_password_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_access_logs_share_id_fkey') THEN
    ALTER TABLE "share_access_logs"
      ADD CONSTRAINT "share_access_logs_share_id_fkey"
      FOREIGN KEY ("share_id") REFERENCES "password_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_password_entry_id_fkey') THEN
    ALTER TABLE "attachments"
      ADD CONSTRAINT "attachments_password_entry_id_fkey"
      FOREIGN KEY ("password_entry_id") REFERENCES "password_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_org_password_entry_id_fkey') THEN
    ALTER TABLE "attachments"
      ADD CONSTRAINT "attachments_org_password_entry_id_fkey"
      FOREIGN KEY ("org_password_entry_id") REFERENCES "org_password_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_created_by_id_fkey') THEN
    ALTER TABLE "attachments"
      ADD CONSTRAINT "attachments_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_access_grants_owner_id_fkey') THEN
    ALTER TABLE "emergency_access_grants"
      ADD CONSTRAINT "emergency_access_grants_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_access_grants_grantee_id_fkey') THEN
    ALTER TABLE "emergency_access_grants"
      ADD CONSTRAINT "emergency_access_grants_grantee_id_fkey"
      FOREIGN KEY ("grantee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_access_key_pairs_grant_id_fkey') THEN
    ALTER TABLE "emergency_access_key_pairs"
      ADD CONSTRAINT "emergency_access_key_pairs_grant_id_fkey"
      FOREIGN KEY ("grant_id") REFERENCES "emergency_access_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
