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
): Set<string> {
  return checked ? new Set(entryIds) : new Set();
}

export function toggleSelectOneId(
  prev: Set<string>,
  id: string,
  checked: boolean,
): Set<string> {
  const next = new Set(prev);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}
