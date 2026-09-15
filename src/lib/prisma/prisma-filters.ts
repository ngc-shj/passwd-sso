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

/**
 * Escape `%`, `_` and `\\` for a Prisma `contains` / `startsWith` / `endsWith`
 * filter, which Prisma hands to LIKE/ILIKE without escaping: in user-supplied
 * text those characters are otherwise wildcards.
 *
 * For an exact case-insensitive match use `{ in: [value], mode: "insensitive" }`
 * instead. `equals` with `mode: "insensitive"` is an unescaped ILIKE too, while
 * `in` compiles to LOWER(column) IN (LOWER($1)) (audit-tenant-adjudicator round 8,
 * R8-S1/R8-S4).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
