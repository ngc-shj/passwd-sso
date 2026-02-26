-- Phase: rename physical foreign key columns from org_id to team_id.
-- Keep Prisma field names (orgId) temporarily for runtime compatibility.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'scim_tokens' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "scim_tokens" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'scim_external_mappings' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "scim_external_mappings" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_members' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_members" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_member_keys' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_member_keys" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_password_entries' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_password_entries" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_tags' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_tags" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_invitations' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_invitations" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "audit_logs" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_folders' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE "org_folders" RENAME COLUMN "org_id" TO "team_id";
  END IF;
END $$;
