/**
 * Travel Mode — client-side filtering for travel-safe entries.
 *
 * `travelSafe` is stored inside the encrypted blob, so the server
 * cannot filter. Filtering happens entirely on the client.
 *
 * Entries without a `travelSafe` field default to `true` (travel-safe)
 * to avoid hiding all entries for users who enable Travel Mode before
 * tagging any entries.
 */

export interface TravelSafeEntry {
  travelSafe?: boolean;
}

/**
 * Filter entries based on Travel Mode state.
 * When travelModeActive is true, only entries with travelSafe !== false
 * are returned. When false, all entries are returned unfiltered.
 */
export function filterTravelSafe<T extends TravelSafeEntry>(
  entries: T[],
  travelModeActive: boolean,
): T[] {
  if (!travelModeActive) return entries;
  return entries.filter((entry) => entry.travelSafe !== false);
}
