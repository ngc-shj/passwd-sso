// Shared user display name utility

/**
 * Returns a human-readable display name for a user object.
 * Prefers `name` over `email`; falls back to `fallback` (default `"—"`).
 */
export function formatUserName(
  user: { name: string | null; email: string | null } | null | undefined,
  fallback = "—",
): string {
  if (!user) return fallback;
  return user.name?.trim() || user.email || fallback;
}
