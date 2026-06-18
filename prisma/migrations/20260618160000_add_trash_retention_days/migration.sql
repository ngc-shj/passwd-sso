-- SC2: per-tenant trash auto-purge grace period. Additive nullable column;
-- NULL = never auto-purge (mirrors audit_log_retention_days). No backfill.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trash_retention_days" INTEGER;
