"use client";

import { useState } from "react";

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
 *   );
 *
 * Replaces the two-step pattern that previously appeared in every entry
 * form:
 *   const baselineSnapshot = useMemo(() => JSON.stringify({...initialData}), []);
 *   const currentSnapshot  = useMemo(() => JSON.stringify({...state}), [state]);
 *   const hasChanges = currentSnapshot !== baselineSnapshot;
 *
 * Implementation notes:
 * - The baseline is captured on the first render via a useState
 *   initializer and is stable across re-renders.
 * - The current snapshot is recomputed on every render; entry forms are
 *   small enough that serializing them is cheaper than tracking deps.
 */
export function useEntryHasChanges(build: () => unknown): boolean {
  const current = JSON.stringify(build());
  const [baseline] = useState(current);
  return current !== baseline;
}
