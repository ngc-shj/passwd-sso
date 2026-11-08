-- #1009: the retention GC worker pruned a team's unreferenced TeamMemberKey
-- versions. ADD VALUE gets its own migration: a new enum value cannot be used
-- in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER_KEY_PRUNED';
