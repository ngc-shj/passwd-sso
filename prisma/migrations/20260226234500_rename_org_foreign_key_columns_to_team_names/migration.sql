-- Phase: rename remaining org_* FK column names to team_* in teamized tables.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_password_entries' AND column_name = 'org_folder_id'
  ) THEN
    ALTER TABLE "team_password_entries" RENAME COLUMN "org_folder_id" TO "team_folder_id";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'team_password_favorites' AND column_name = 'org_password_entry_id'
  ) THEN
    ALTER TABLE "team_password_favorites" RENAME COLUMN "org_password_entry_id" TO "team_password_entry_id";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'share_links' AND column_name = 'org_password_entry_id'
  ) THEN
    ALTER TABLE "share_links" RENAME COLUMN "org_password_entry_id" TO "team_password_entry_id";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'attachments' AND column_name = 'org_password_entry_id'
  ) THEN
    ALTER TABLE "attachments" RENAME COLUMN "org_password_entry_id" TO "team_password_entry_id";
  END IF;
END $$;
