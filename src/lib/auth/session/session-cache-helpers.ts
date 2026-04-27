import { invalidateCachedSession } from "@/lib/auth/session/session-cache";

/**
 * Best-effort bulk invalidation. Each call is independently best-effort
 * (errors caught + throttled-logged inside invalidateCachedSession);
 * never throws to the caller.
 *
 * For high-cardinality bulk invalidation (tenant policy change with
 * thousands of sessions), prefer Redis pipelining at the call site —
 * see plan §C3 row #9. This helper is for the common 1–N case.
 */
export async function invalidateCachedSessions(
  tokens: ReadonlyArray<string>,
): Promise<void> {
  if (tokens.length === 0) return;
  await Promise.all(tokens.map((t) => invalidateCachedSession(t)));
}
