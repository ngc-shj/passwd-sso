-- Audit actions for team-key-rotation-rekey (C2-C4). ADD VALUE needs its own
-- migration: a new enum value cannot be used in the transaction that adds it.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_KEY_ROTATION_CARRY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_ENTRY_REKEY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_ATTACHMENT_MIGRATE';

COMMIT;
