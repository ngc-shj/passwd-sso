import { invalidateCachedSession } from "@/lib/auth/session/session-cache";

/**
 * Best-effort bulk invalidation. Each call is independently best-effort
 * (errors caught + throttled-logged inside invalidateCachedSession);
 * never throws to the caller.
 *
 * Returns `{ total, failed }` so security-critical callers (vault reset,
 * member removal) can surface tombstone-write failures into audit metadata.
 * Throttled-logging alone is insufficient for forensic reconstruction —
 * see invalidateCachedSession docstring.
 *
 * For high-cardinality bulk invalidation (tenant policy change with
 * thousands of sessions), prefer Redis pipelining at the call site —
 * see plan §C3 row #9. This helper is for the common 1–N case.
 */
export async function invalidateCachedSessions(
  tokens: ReadonlyArray<string>,
): Promise<{ total: number; failed: number }> {
  if (tokens.length === 0) return { total: 0, failed: 0 };
  const results = await Promise.all(
    tokens.map((t) => invalidateCachedSession(t)),
  );
  const failed = results.reduce((acc, ok) => acc + (ok ? 0 : 1), 0);
  return { total: tokens.length, failed };
}
