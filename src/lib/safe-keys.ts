/** Guard against prototype pollution via user-controlled property names. */
export function isProtoKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Build a plain object from entries, skipping prototype-pollution keys.
 * Uses Map internally so CodeQL does not flag dynamic property writes.
 */
export function safeRecord(
  entries: Iterable<[string, unknown]>,
): Record<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [k, v] of entries) {
    if (!isProtoKey(k)) map.set(k, v);
  }
  return Object.fromEntries(map);
}
