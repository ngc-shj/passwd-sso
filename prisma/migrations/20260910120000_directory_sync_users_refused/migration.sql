-- Both statements in ONE transaction: Prisma does not wrap PostgreSQL
-- migrations, and a half-applied schema here would leave the column present
-- without the audit action the same release starts emitting.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+ as long as the
-- new value is not USED in the same transaction, and nothing here uses it.
BEGIN;

-- Memberships the cross-tenant guard declined to activate during a sync run.
-- Separate from users_updated: counting a refusal as an update is what let a run
-- that left the user deactivated report as a clean sync.
ALTER TABLE "directory_sync_logs"
  ADD COLUMN "users_refused" INTEGER NOT NULL DEFAULT 0;

-- The refusal needs an audit action of its own: the run's own log row carries a
-- count, but only the audit trail says WHICH membership was declined, and a
-- tenant admin reading it must be able to tell a refusal from a reactivation.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DIRECTORY_SYNC_ACTIVATION_REFUSED';

COMMIT;
