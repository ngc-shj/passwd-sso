-- Audit actions for leftover-team-actor-authority: invitation cancel (C2) and
-- the operator re-admission script (C8). ADD VALUE needs its own migration: a
-- new enum value cannot be used in the transaction that adds it.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_INVITE_CANCEL';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_OPERATOR_READMIT';

COMMIT;
