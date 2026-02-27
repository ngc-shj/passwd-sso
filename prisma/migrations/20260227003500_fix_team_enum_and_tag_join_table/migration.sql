-- Fix migration gaps after org -> team rename:
-- 1) enum type OrgRole -> TeamRole
-- 2) implicit M:N join table _OrgPasswordEntryToOrgTag -> _TeamPasswordEntryToTeamTag

DO $$
BEGIN
  -- Case A: only OrgRole exists -> rename type directly.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgRole')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TeamRole') THEN
    ALTER TYPE "OrgRole" RENAME TO "TeamRole";
  END IF;

  -- Case B: both exist -> migrate remaining OrgRole columns, then drop OrgRole when unused.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgRole')
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TeamRole') THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'role' AND udt_name = 'OrgRole'
    ) THEN
      ALTER TABLE "team_members"
        ALTER COLUMN "role" TYPE "TeamRole"
        USING ("role"::text::"TeamRole");
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'team_invitations' AND column_name = 'role' AND udt_name = 'OrgRole'
    ) THEN
      ALTER TABLE "team_invitations"
        ALTER COLUMN "role" TYPE "TeamRole"
        USING ("role"::text::"TeamRole");
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE udt_schema = 'public' AND udt_name = 'OrgRole'
    ) THEN
      DROP TYPE "OrgRole";
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = '_OrgPasswordEntryToOrgTag' AND relkind = 'r'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = '_TeamPasswordEntryToTeamTag' AND relkind = 'r'
  ) THEN
    ALTER TABLE "_OrgPasswordEntryToOrgTag" RENAME TO "_TeamPasswordEntryToTeamTag";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = '_OrgPasswordEntryToOrgTag_AB_pkey' AND relkind = 'i'
  ) THEN
    ALTER INDEX "_OrgPasswordEntryToOrgTag_AB_pkey" RENAME TO "_TeamPasswordEntryToTeamTag_AB_pkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = '_OrgPasswordEntryToOrgTag_B_index' AND relkind = 'i'
  ) THEN
    ALTER INDEX "_OrgPasswordEntryToOrgTag_B_index" RENAME TO "_TeamPasswordEntryToTeamTag_B_index";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = '_OrgPasswordEntryToOrgTag_A_fkey'
  ) THEN
    ALTER TABLE "_TeamPasswordEntryToTeamTag"
      RENAME CONSTRAINT "_OrgPasswordEntryToOrgTag_A_fkey" TO "_TeamPasswordEntryToTeamTag_A_fkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = '_OrgPasswordEntryToOrgTag_B_fkey'
  ) THEN
    ALTER TABLE "_TeamPasswordEntryToTeamTag"
      RENAME CONSTRAINT "_OrgPasswordEntryToOrgTag_B_fkey" TO "_TeamPasswordEntryToTeamTag_B_fkey";
  END IF;
END $$;
