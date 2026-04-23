/**
 * Standard Prisma where clause for "active" entries (not deleted, not archived).
 * Used in both _count queries and list queries to ensure consistency.
 *
 * WARNING: Changing this object affects ALL count and list queries across
 * personal/team endpoints. Verify both count and list behavior after changes.
 *
 * DO NOT use in: emergency-access vault entries, rotate-key endpoints
 * (these intentionally include archived entries).
 */
export const ACTIVE_ENTRY_WHERE = { deletedAt: null, isArchived: false };
