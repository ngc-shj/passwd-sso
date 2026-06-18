-- SC6: provenance audit action emitted before deleting an expired security record.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SECURITY_RECORD_RETENTION_PURGED';
