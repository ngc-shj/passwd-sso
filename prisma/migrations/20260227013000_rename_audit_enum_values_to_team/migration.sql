-- Rename audit enum values from ORG* to TEAM*.
-- Safe to run multiple times (idempotent).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'AuditScope'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AuditScope' AND e.enumlabel = 'ORG'
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AuditScope' AND e.enumlabel = 'TEAM'
    ) THEN
      ALTER TYPE "AuditScope" RENAME VALUE 'ORG' TO 'TEAM';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'AuditAction'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_MEMBER_INVITE')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_MEMBER_INVITE') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_MEMBER_INVITE' TO 'TEAM_MEMBER_INVITE';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_MEMBER_REMOVE')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_MEMBER_REMOVE') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_MEMBER_REMOVE' TO 'TEAM_MEMBER_REMOVE';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_ROLE_UPDATE')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_ROLE_UPDATE') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_ROLE_UPDATE' TO 'TEAM_ROLE_UPDATE';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_E2E_MIGRATION')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_E2E_MIGRATION') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_E2E_MIGRATION' TO 'TEAM_E2E_MIGRATION';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_KEY_ROTATION')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_KEY_ROTATION') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_KEY_ROTATION' TO 'TEAM_KEY_ROTATION';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'ORG_MEMBER_KEY_DISTRIBUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' AND e.enumlabel = 'TEAM_MEMBER_KEY_DISTRIBUTE') THEN
      ALTER TYPE "AuditAction" RENAME VALUE 'ORG_MEMBER_KEY_DISTRIBUTE' TO 'TEAM_MEMBER_KEY_DISTRIBUTE';
    END IF;
  END IF;
END $$;
