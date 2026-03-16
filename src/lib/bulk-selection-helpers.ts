import { MAX_BULK_IDS } from "@/lib/validations/common";

export const MAX_BULK_SELECTION = MAX_BULK_IDS;

/**
 * Remove IDs from `prev` that no longer exist in `currentIds`.
 *
 * Returns `prev` unchanged (by reference) when `prev` is empty or when
 * no IDs were removed, enabling React state bailout to avoid unnecessary
 * re-renders.
 */
export function reconcileSelectedIds(
  prev: Set<string>,
  currentIds: readonly string[],
): Set<string> {
  if (prev.size === 0) return prev;
  const ids = new Set(currentIds);
  const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
  return next.size === prev.size ? prev : next;
}

export function toggleSelectAllIds(
  entryIds: readonly string[],
  checked: boolean,
  max: number = MAX_BULK_SELECTION,
): Set<string> {
  if (!checked) return new Set();
  return new Set(entryIds.slice(0, max));
}

export function toggleSelectOneId(
  prev: Set<string>,
  id: string,
  checked: boolean,
  max: number = MAX_BULK_SELECTION,
): Set<string> {
  const next = new Set(prev);
  if (checked) {
    if (next.size >= max) return prev;
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}
