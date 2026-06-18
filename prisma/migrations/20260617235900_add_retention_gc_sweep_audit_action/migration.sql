-- Add the RETENTION_GC_SWEEP audit action for the generic retention-gc-worker.
-- Separate migration (runs before the role-grant migration) so the new enum
-- value is committed before any code path uses it — Postgres forbids using a
-- newly-added enum value in the same transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RETENTION_GC_SWEEP';
