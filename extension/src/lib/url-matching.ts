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

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

export function isHostMatch(entryHost: string, tabHost: string): boolean {
  const e = normalizeHost(entryHost);
  const t = normalizeHost(tabHost);
  if (e === t) return true;
  return t.endsWith(`.${e}`);
}

export function sortByUrlMatch<T extends { urlHost: string }>(
  entries: T[],
  tabHost: string | null,
): T[] {
  if (!tabHost) return entries;
  const matched: T[] = [];
  const other: T[] = [];
  for (const entry of entries) {
    if (entry.urlHost && isHostMatch(entry.urlHost, tabHost)) {
      matched.push(entry);
    } else {
      other.push(entry);
    }
  }
  return [...matched, ...other];
}
