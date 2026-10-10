export function extractHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

/**
 * `value` itself when it is a serialized http(s) origin (scheme, host and port
 * only, as `URL.origin` produces it), otherwise null. A full URL is refused,
 * so the result can be compared to `self.origin` / a probed origin with `===`.
 */
export function parseHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin === value ? value : null;
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

export function isHostMatch(entryHost: string, tabHost: string): boolean {
  const e = normalizeHost(entryHost);
  const t = normalizeHost(tabHost);
  if (e === t) return true;
  return t.endsWith(`.${e}`);
}

export function sortByUrlMatch<T extends { urlHost: string; additionalUrlHosts?: string[] }>(
  entries: T[],
  tabHost: string | null,
): T[] {
  if (!tabHost) return entries;
  const matched: T[] = [];
  const other: T[] = [];
  for (const entry of entries) {
    const primaryMatch = entry.urlHost && isHostMatch(entry.urlHost, tabHost);
    const additionalMatch = (entry.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost));
    if (primaryMatch || additionalMatch) {
      matched.push(entry);
    } else {
      other.push(entry);
    }
  }
  return [...matched, ...other];
}
