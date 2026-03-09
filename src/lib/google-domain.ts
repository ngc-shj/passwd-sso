/**
 * Parse allowed Google Workspace domains from GOOGLE_WORKSPACE_DOMAINS env var.
 * Supports comma-separated values (e.g. "example.com,example.co.jp").
 * Returns empty array when unset/empty (= allow all Google accounts).
 */
export function parseAllowedGoogleDomains(): string[] {
  const raw = process.env.GOOGLE_WORKSPACE_DOMAINS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}
