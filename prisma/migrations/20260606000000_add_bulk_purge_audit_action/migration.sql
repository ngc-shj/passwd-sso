-- Add ENTRY_BULK_PURGE to the AuditAction enum.
-- Emitted by POST /api/passwords/bulk-purge and POST /api/teams/[teamId]/passwords/bulk-purge
-- as the parent summary action when permanently deleting a selected set of trashed
-- entries (companion to the per-entry ENTRY_PERMANENT_DELETE records). Distinct from
-- ENTRY_EMPTY_TRASH, which purges the entire trash rather than a selection.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ENTRY_BULK_PURGE';
