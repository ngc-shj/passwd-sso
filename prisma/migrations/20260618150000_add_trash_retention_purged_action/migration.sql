-- SC2: add TRASH_RETENTION_PURGED to the AuditAction enum so the retention-gc
-- worker's per-tenant trash auto-purge is distinguishable from credential and
-- audit-log retention purges in the audit log.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRASH_RETENTION_PURGED';
