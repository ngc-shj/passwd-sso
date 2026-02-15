-- Bootstrap audit enums/table when applying on fresh databases.
-- This keeps migration deploy idempotent even if older audit migrations
-- were squashed outside this repository history.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuditScope') THEN
    CREATE TYPE "AuditScope" AS ENUM ('PERSONAL', 'ORG');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuditAction') THEN
    CREATE TYPE "AuditAction" AS ENUM (
      'AUTH_LOGIN',
      'AUTH_LOGOUT',
      'ENTRY_BULK_ARCHIVE',
      'ENTRY_BULK_DELETE',
      'ENTRY_BULK_UNARCHIVE',
      'ENTRY_CREATE',
      'ENTRY_UPDATE',
      'ENTRY_DELETE',
      'ENTRY_RESTORE',
      'ENTRY_EXPORT',
      'ATTACHMENT_UPLOAD',
      'ATTACHMENT_DELETE',
      'ORG_MEMBER_INVITE',
      'ORG_MEMBER_REMOVE',
      'ORG_ROLE_UPDATE',
      'SHARE_CREATE',
      'SHARE_REVOKE',
      'EMERGENCY_GRANT_CREATE',
      'EMERGENCY_GRANT_ACCEPT',
      'EMERGENCY_GRANT_REJECT',
      'EMERGENCY_GRANT_CONFIRM',
      'EMERGENCY_ACCESS_REQUEST',
      'EMERGENCY_ACCESS_ACTIVATE',
      'EMERGENCY_ACCESS_REVOKE',
      'EMERGENCY_VAULT_ACCESS'
    );
  END IF;
END$$;

-- Ensure action exists when enum already present.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ENTRY_BULK_UNARCHIVE';

-- Create audit_logs table if absent (fresh DB bootstrap path).
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT NOT NULL,
  "scope" "AuditScope" NOT NULL,
  "action" "AuditAction" NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" TEXT,
  "target_type" TEXT,
  "target_id" TEXT,
  "metadata" JSONB,
  "ip" VARCHAR(45),
  "user_agent" VARCHAR(512),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_org_id_created_at_idx" ON "audit_logs"("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");
