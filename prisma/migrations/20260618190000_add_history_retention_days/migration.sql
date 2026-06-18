-- SC3: per-tenant password-entry history auto-trim retention. NULL = never auto-trim.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "history_retention_days" INTEGER;
