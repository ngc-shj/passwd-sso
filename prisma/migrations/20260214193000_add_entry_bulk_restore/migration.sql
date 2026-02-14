-- Add bulk restore action for audit logs
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ENTRY_BULK_RESTORE';
