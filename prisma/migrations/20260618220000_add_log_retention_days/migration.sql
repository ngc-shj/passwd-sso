-- SC7: per-tenant append-only log auto-delete retention (per table). NULL = never.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "share_access_log_retention_days" INTEGER;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "directory_sync_log_retention_days" INTEGER;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "notification_retention_days" INTEGER;
