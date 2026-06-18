-- SC7: audit action for automatic append-only log deletion (system worker).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOG_RETENTION_PURGED';
