-- Phase 2: Audit anchor external-commitment publisher foundation

-- 1. AuditChainAnchor columns (additive)
ALTER TABLE "audit_chain_anchors" ADD COLUMN "epoch" INTEGER DEFAULT 1;
ALTER TABLE "audit_chain_anchors" ADD COLUMN "publish_paused_until" TIMESTAMPTZ(3);
ALTER TABLE "audit_chain_anchors" ADD COLUMN "last_published_at" TIMESTAMPTZ(3);

-- 2. Backfill existing rows
UPDATE "audit_chain_anchors" SET "epoch" = 1 WHERE "epoch" IS NULL;

-- 3. system_settings table
CREATE TABLE IF NOT EXISTS "system_settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
ALTER TABLE "system_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY system_settings_bypass ON "system_settings"
  USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on')
  WITH CHECK (COALESCE(current_setting('app.bypass_rls', true), '') = 'on');

-- 4. AuditAction enum extension (idempotent via IF NOT EXISTS)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUDIT_ANCHOR_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUDIT_ANCHOR_PUBLISH_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUDIT_ANCHOR_PUBLISH_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUDIT_ANCHOR_KEY_ROTATED';

-- 5. Create passwd_anchor_publisher role (no password — set out-of-band via initdb or scripts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_anchor_publisher') THEN
    CREATE ROLE passwd_anchor_publisher WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- 6. Grant database access (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_anchor_publisher', current_database());
END $$;

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_anchor_publisher;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_anchor_publisher;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_anchor_publisher;

-- Minimal schema access
GRANT USAGE ON SCHEMA public TO passwd_anchor_publisher;

-- Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
-- REFERENCES on future tables to the publisher role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE REFERENCES ON TABLES FROM passwd_anchor_publisher;

-- Minimum table privileges:
--   audit_chain_anchors: SELECT to read anchor rows; UPDATE on publish-tracking columns only.
--   tenants:             SELECT for FK existence check inside enqueueAuditInTx.
--   audit_outbox:        INSERT to enqueue SYSTEM-attributed audit rows for publish events.
--   system_settings:     SELECT/INSERT/UPDATE for publish-state key-value storage.
GRANT SELECT ON TABLE "audit_chain_anchors" TO passwd_anchor_publisher;
GRANT UPDATE ("publish_paused_until", "last_published_at") ON "audit_chain_anchors" TO passwd_anchor_publisher;
GRANT SELECT ON TABLE "tenants" TO passwd_anchor_publisher;
GRANT INSERT ON TABLE "audit_outbox" TO passwd_anchor_publisher;
GRANT SELECT, INSERT, UPDATE ON TABLE "system_settings" TO passwd_anchor_publisher;
