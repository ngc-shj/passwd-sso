-- Audit actions for team-tenant-departure (C9). ADD VALUE needs its own
-- migration: a new enum value cannot be used in the transaction that adds it.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_TENANT_DEACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_TENANT_RESTORE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN';

COMMIT;
