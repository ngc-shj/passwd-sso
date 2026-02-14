export function reconcileSelectedIds(prev: Set<string>, entryIds: string[]): Set<string> {
  if (prev.size === 0) return prev;
  const ids = new Set(entryIds);
  const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
  return next.size === prev.size ? prev : next;
}

export function toggleSelectAllIds(entryIds: string[], checked: boolean): Set<string> {
  return checked ? new Set(entryIds) : new Set();
}

export function toggleSelectOneId(prev: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(prev);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}
