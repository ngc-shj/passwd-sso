-- Phase: rename physical org_* table names to team_*.
-- Keep Prisma model names (Org*) temporarily for application compatibility.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_members' AND relkind = 'r') THEN
    ALTER TABLE "org_members" RENAME TO "team_members";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_member_keys' AND relkind = 'r') THEN
    ALTER TABLE "org_member_keys" RENAME TO "team_member_keys";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_password_entries' AND relkind = 'r') THEN
    ALTER TABLE "org_password_entries" RENAME TO "team_password_entries";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_tags' AND relkind = 'r') THEN
    ALTER TABLE "org_tags" RENAME TO "team_tags";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_password_favorites' AND relkind = 'r') THEN
    ALTER TABLE "org_password_favorites" RENAME TO "team_password_favorites";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_invitations' AND relkind = 'r') THEN
    ALTER TABLE "org_invitations" RENAME TO "team_invitations";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_folders' AND relkind = 'r') THEN
    ALTER TABLE "org_folders" RENAME TO "team_folders";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_password_entry_histories' AND relkind = 'r') THEN
    ALTER TABLE "org_password_entry_histories" RENAME TO "team_password_entry_histories";
  END IF;
END $$;
