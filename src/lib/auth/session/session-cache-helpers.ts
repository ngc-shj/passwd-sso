import { invalidateCachedSessionByDigest } from "@/lib/auth/session/session-cache";

/**
 * Best-effort bulk invalidation. Each call is independently best-effort
 * (errors caught + throttled-logged inside invalidateCachedSessionByDigest);
 * never throws to the caller.
 *
 * H4: inputs are STORED DIGESTS (Session.sessionToken values), not raw cookie
 * tokens — the DB no longer holds raw tokens. Every caller reads the value from
 * a `select: { sessionToken: true }`, which is the digest, and the cache is
 * keyed by that same digest, so no re-hashing happens here (re-hashing would
 * double-hash and silently miss the real cache key).
 *
 * Returns `{ total, failed }` so security-critical callers (vault reset,
 * member removal) can surface tombstone-write failures into audit metadata.
 * Throttled-logging alone is insufficient for forensic reconstruction.
 *
 * For high-cardinality bulk invalidation (tenant policy change with
 * thousands of sessions), prefer Redis pipelining at the call site
 * (invalidateCachedSessionsBulkByDigest). This helper is for the common 1–N case.
 */
export async function invalidateCachedSessions(
  digests: ReadonlyArray<string>,
): Promise<{ total: number; failed: number }> {
  if (digests.length === 0) return { total: 0, failed: 0 };
  const results = await Promise.all(
    digests.map((d) => invalidateCachedSessionByDigest(d)),
  );
  const failed = results.reduce((acc, ok) => acc + (ok ? 0 : 1), 0);
  return { total: digests.length, failed };
}
