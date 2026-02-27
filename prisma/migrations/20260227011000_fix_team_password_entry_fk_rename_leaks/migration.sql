-- Fix rename leaks around org_password_entry_id -> team_password_entry_id.
-- Targets:
--   - password_shares column + related index/FK name
--   - attachments index/FK names
--   - team_password_favorites index/FK names

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'password_shares'
      AND column_name = 'org_password_entry_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'password_shares'
      AND column_name = 'team_password_entry_id'
  ) THEN
    ALTER TABLE "password_shares"
      RENAME COLUMN "org_password_entry_id" TO "team_password_entry_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'password_shares'
      AND indexname = 'password_shares_org_password_entry_id_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'password_shares'
      AND indexname = 'password_shares_team_password_entry_id_idx'
  ) THEN
    ALTER INDEX "password_shares_org_password_entry_id_idx"
      RENAME TO "password_shares_team_password_entry_id_idx";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'password_shares_org_password_entry_id_fkey'
  ) THEN
    ALTER TABLE "password_shares"
      RENAME CONSTRAINT "password_shares_org_password_entry_id_fkey"
      TO "password_shares_team_password_entry_id_fkey";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'attachments'
      AND indexname = 'attachments_org_password_entry_id_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'attachments'
      AND indexname = 'attachments_team_password_entry_id_idx'
  ) THEN
    ALTER INDEX "attachments_org_password_entry_id_idx"
      RENAME TO "attachments_team_password_entry_id_idx";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'attachments_org_password_entry_id_fkey'
  ) THEN
    ALTER TABLE "attachments"
      RENAME CONSTRAINT "attachments_org_password_entry_id_fkey"
      TO "attachments_team_password_entry_id_fkey";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'team_password_favorites'
      AND indexname = 'org_password_favorites_user_id_org_password_entry_id_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'team_password_favorites'
      AND indexname = 'team_password_favorites_user_id_team_password_entry_id_key'
  ) THEN
    ALTER INDEX "org_password_favorites_user_id_org_password_entry_id_key"
      RENAME TO "team_password_favorites_user_id_team_password_entry_id_key";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'org_password_favorites_org_password_entry_id_fkey'
  ) THEN
    ALTER TABLE "team_password_favorites"
      RENAME CONSTRAINT "org_password_favorites_org_password_entry_id_fkey"
      TO "team_password_favorites_team_password_entry_id_fkey";
  END IF;
END $$;
