-- SC3: audit action for automatic password-entry history trimming (system worker).
-- Separate migration so the enum value is committed before any usage.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HISTORY_RETENTION_PURGED';
