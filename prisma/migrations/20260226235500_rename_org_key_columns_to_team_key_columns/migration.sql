-- Phase: rename remaining org_key* physical columns to team_key*.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'org_key_version'
  ) THEN
    ALTER TABLE "teams" RENAME COLUMN "org_key_version" TO "team_key_version";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_member_keys' AND column_name = 'encrypted_org_key'
  ) THEN
    ALTER TABLE "team_member_keys" RENAME COLUMN "encrypted_org_key" TO "encrypted_team_key";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_member_keys' AND column_name = 'org_key_iv'
  ) THEN
    ALTER TABLE "team_member_keys" RENAME COLUMN "org_key_iv" TO "team_key_iv";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_member_keys' AND column_name = 'org_key_auth_tag'
  ) THEN
    ALTER TABLE "team_member_keys" RENAME COLUMN "org_key_auth_tag" TO "team_key_auth_tag";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_password_entries' AND column_name = 'org_key_version'
  ) THEN
    ALTER TABLE "team_password_entries" RENAME COLUMN "org_key_version" TO "team_key_version";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_password_entry_histories' AND column_name = 'org_key_version'
  ) THEN
    ALTER TABLE "team_password_entry_histories" RENAME COLUMN "org_key_version" TO "team_key_version";
  END IF;
END $$;
