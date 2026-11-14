-- Audit action for departed-member-leaked-authority C5: team invitation
-- accept. ADD VALUE needs its own migration: a new enum value cannot be used
-- in the transaction that adds it.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_INVITE_ACCEPT';

COMMIT;
