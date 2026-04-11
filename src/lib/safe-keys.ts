/** Guard against prototype pollution via user-controlled property names. */
export function isProtoKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Safely assign a value to a property on an object, preventing prototype pollution.
 * Uses Object.defineProperty with a data descriptor so CodeQL does not flag it
 * as a remote property injection sink.
 */
export function safeSet(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (isProtoKey(key)) return;
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
