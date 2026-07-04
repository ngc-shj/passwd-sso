/**
 * Retention-floor clamp shared by the maintenance purge routes
 * (purge-audit-logs, purge-history).
 *
 * A tenant's per-column retention setting is the FLOOR: an operator-supplied
 * `retentionDays` may only lengthen retention, never shorten it below the
 * tenant's configured policy. A NULL column means "keep forever" — the purge
 * must be rejected rather than falling back to the request value, so an
 * operator-token holder cannot override that policy.
 *
 * Extracted so the `=== null` check (NOT a truthy check — `0` is a legal
 * retention value that a truthy shortcut would wrongly treat as "no floor",
 * silently bypassing the floor) lives in exactly one place across the two
 * routes.
 */
export type RetentionFloorResult =
  | { ok: true; effectiveRetentionDays: number }
  | { ok: false };

export function applyRetentionFloor(
  requestedDays: number,
  tenantFloorDays: number | null,
): RetentionFloorResult {
  if (tenantFloorDays === null) return { ok: false };
  return { ok: true, effectiveRetentionDays: Math.max(requestedDays, tenantFloorDays) };
}
