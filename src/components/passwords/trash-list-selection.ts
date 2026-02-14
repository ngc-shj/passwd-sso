export function reconcileTrashSelectedIds(
  prev: Set<string>,
  currentIds: readonly string[]
): Set<string> {
  const current = new Set(currentIds);
  return new Set(Array.from(prev).filter((id) => current.has(id)));
}

export function toggleTrashSelectAllIds(
  currentIds: readonly string[],
  checked: boolean
): Set<string> {
  return checked ? new Set(currentIds) : new Set();
}

export function toggleTrashSelectOneId(
  prev: Set<string>,
  id: string,
  checked: boolean
): Set<string> {
  const next = new Set(prev);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}
