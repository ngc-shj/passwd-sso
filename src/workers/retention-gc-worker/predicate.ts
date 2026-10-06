/**
 * Structured predicate type and SQL renderer for retention-GC registry entries.
 *
 * This is the S1 containment boundary: all GC predicates MUST be expressed as
 * PredicateClause[], never raw SQL strings. The renderer validates every
 * column name against a strict allowlist and renders values only as SQL
 * boolean literals from a closed set — there is NO free-form interpolation path.
 */

import { sqlIdentifier, trustedSql, joinSql, type SqlFragment } from "@/lib/prisma/raw-sql";

// Structured predicate clause — not a free-form SQL string (S1).
// Each column runs the ^[a-z_]+$ allowlist; value is a closed set (null/boolean literal).
export type PredicateClause =
  | { column: string; op: "IS NULL" | "IS NOT NULL" }
  | { column: string; op: "="; value: boolean };

/**
 * Render a PredicateClause[] into an AND-joined SQL fragment.
 *
 * Security contract:
 * - Every column is validated against ^[a-z_]+$ (and not a reserved keyword)
 *   via sqlIdentifier before use.
 * - IS NULL / IS NOT NULL ops produce no value interpolation at all.
 * - The "=" op renders only the SQL literals `true` or `false`; the
 *   boolean comes from the typed `value: boolean` field, not from user input.
 * - There is NO code path that interpolates a caller-supplied string value.
 *
 * @example
 *   renderSql(renderPredicate([{column:"is_dcr",op:"=",value:true},{column:"tenant_id",op:"IS NULL"}]))
 *   // => "is_dcr = true AND tenant_id IS NULL"
 */
export function renderPredicate(clauses: PredicateClause[]): SqlFragment {
  const parts = clauses.map((clause) => {
    const column = sqlIdentifier(clause.column);
    switch (clause.op) {
      case "IS NULL":
        return trustedSql`${column} IS NULL`;
      case "IS NOT NULL":
        return trustedSql`${column} IS NOT NULL`;
      case "=":
        // value is typed as boolean; render as SQL literal only.
        return clause.value
          ? trustedSql`${column} = true`
          : trustedSql`${column} = false`;
    }
  });
  return joinSql(parts, trustedSql` AND `);
}
