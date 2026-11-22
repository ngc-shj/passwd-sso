/**
 * The non-empty string at `key` in a parsed response body, or null when the
 * body is not an object or the field is missing, empty, or not a string.
 * Pairs with `parseJsonBodyOnce`, which yields `null` for an unreadable body.
 */
export function readNonEmptyStringField(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null || !(key in data)) return null;
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" && value !== "" ? value : null;
}
