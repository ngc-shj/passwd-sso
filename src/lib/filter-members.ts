/**
 * Client-side member filtering by name or email.
 */
export function filterMembers<
  T extends { name: string | null; email: string | null },
>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return members;
  return members.filter(
    (m) =>
      (m.name?.toLowerCase().includes(q) ?? false) ||
      (m.email?.toLowerCase().includes(q) ?? false),
  );
}
