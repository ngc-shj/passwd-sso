"use client";

import { useMemo, useRef } from "react";

/**
 * Detect whether the current entry form state differs from the baseline
 * snapshot captured at mount.
 *
 * Usage:
 *   const hasChanges = useEntryHasChanges(
 *     () => ({
 *       title, username, password, url, notes,
 *       selectedTagIds: selectedTags.map((t) => t.id).sort(),
 *       folderId, requireReprompt, travelSafe, expiresAt,
 *     }),
 *     [title, username, password, url, notes, selectedTags, folderId,
 *      requireReprompt, travelSafe, expiresAt],
 *   );
 *
 * Replaces the two-step pattern that previously appeared in every entry
 * form:
 *   const baselineSnapshot = useMemo(() => JSON.stringify({...initialData}), []);
 *   const currentSnapshot  = useMemo(() => JSON.stringify({...state}), [state]);
 *   const hasChanges = currentSnapshot !== baselineSnapshot;
 *
 * Implementation notes:
 * - The baseline is captured on the first render via useRef and is stable
 *   across re-renders (equivalent to initializing a ref lazily from the
 *   first `build()` result).
 * - Callers pass an explicit dep array so the current snapshot is only
 *   recomputed when form fields change.
 */
export function useEntryHasChanges(
  build: () => unknown,
  deps: readonly unknown[],
): boolean {
  const baselineRef = useRef<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps supplied by caller
  const current = useMemo(() => JSON.stringify(build()), deps);
  if (baselineRef.current === null) {
    baselineRef.current = current;
  }
  return current !== baselineRef.current;
}
