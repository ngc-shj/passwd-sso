/** Guard against prototype pollution via user-controlled property names. */
export function isProtoKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}
