-- Unify session timeout policy
-- Design: docs/security/session-timeout-design.md
-- Plan:   docs/archive/review/unify-session-timeout-policy-plan.md

-- ─── Tenants ──────────────────────────────────────────────────────
-- Add new non-nullable columns with server-side defaults (safe for existing rows)
ALTER TABLE "tenants"
  ADD COLUMN "session_absolute_timeout_minutes" INTEGER NOT NULL DEFAULT 43200,
  ADD COLUMN "extension_token_idle_timeout_minutes" INTEGER NOT NULL DEFAULT 10080,
  ADD COLUMN "extension_token_absolute_timeout_minutes" INTEGER NOT NULL DEFAULT 43200;

-- Backfill NULL session_idle_timeout_minutes with default, then flip to NOT NULL
UPDATE "tenants"
   SET "session_idle_timeout_minutes" = 480
 WHERE "session_idle_timeout_minutes" IS NULL;

ALTER TABLE "tenants"
  ALTER COLUMN "session_idle_timeout_minutes" SET NOT NULL,
  ALTER COLUMN "session_idle_timeout_minutes" SET DEFAULT 480;

-- ─── Team Policies ────────────────────────────────────────────────
-- Add new nullable override columns
ALTER TABLE "team_policies"
  ADD COLUMN "session_idle_timeout_minutes" INTEGER,
  ADD COLUMN "session_absolute_timeout_minutes" INTEGER;

-- Carry semantics from legacy max_session_duration_minutes (absolute, createdAt-based)
UPDATE "team_policies"
   SET "session_absolute_timeout_minutes" = "max_session_duration_minutes"
 WHERE "max_session_duration_minutes" IS NOT NULL;

-- NOTE: "max_session_duration_minutes" column is KEPT this release.
-- Removed in a follow-up cleanup migration after all code stops reading it.

-- ─── Sessions ─────────────────────────────────────────────────────
-- Add nullable provider column. NULL for existing rows = non-AAL3 path in resolver.
ALTER TABLE "sessions"
  ADD COLUMN "provider" VARCHAR(64);

-- ─── Extension Tokens ─────────────────────────────────────────────
-- Add family tracking columns (nullable in this migration).
-- Backfill existing rows so Batch D can safely flip to NOT NULL once all callers set these fields.
ALTER TABLE "extension_tokens"
  ADD COLUMN "family_id" UUID,
  ADD COLUMN "family_created_at" TIMESTAMPTZ(3);

UPDATE "extension_tokens"
   SET "family_id" = "id",
       "family_created_at" = "created_at"
 WHERE "family_id" IS NULL;

CREATE INDEX "extension_tokens_family_id_revoked_at_idx"
  ON "extension_tokens" ("family_id", "revoked_at");

-- NOTE: NOT NULL flip deferred to a follow-up migration once code unconditionally populates these
-- columns on INSERT (Batch D: issueExtensionToken + refresh route).
