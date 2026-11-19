-- Scratch database only: ALTER TYPE ... ADD VALUE cannot be rolled back and
-- changes the type for the whole database.
ALTER TYPE "TeamRole" ADD VALUE 'RP_UNKNOWN_LABEL';
