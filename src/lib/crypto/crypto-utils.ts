// Shared crypto utility functions used by both client and server modules.
// Pure functions with no side-effects — safe to import from any module.

/**
 * Pass-through helper for SubtleCrypto APIs that take `BufferSource`.
 *
 * Originally converted `Uint8Array → ArrayBuffer` (via slice, then via
 * new+set) to satisfy TS 5.9 BufferSource expectations.
 *
 * Now a no-op: returning the input Uint8Array directly is correct because
 *   1. SubtleCrypto's `BufferSource = ArrayBufferView | ArrayBuffer` —
 *      a `Uint8Array` is an `ArrayBufferView`, so the type holds.
 *   2. jsdom 28 + Node 20 rejects plain `ArrayBuffer` in its webidl
 *      `BufferSource` check (even when `instanceof ArrayBuffer === true`),
 *      but accepts any TypedArray. Returning the original Uint8Array
 *      preserves both the realm and bypasses the failing check.
 *   3. Skipping the slice/copy is also a small perf win — every call
 *      site previously paid one allocation + one copy.
 *
 * Return type narrowed to `BufferSource` so call sites continue to be
 * accepted by SubtleCrypto signatures unchanged. `Uint8Array` would
 * also work and is what is actually returned at runtime.
 */
export function toArrayBuffer(arr: Uint8Array): BufferSource {
  // TS 5.9 narrows Uint8Array.buffer to ArrayBufferLike (could be
  // SharedArrayBuffer); BufferSource requires ArrayBufferView<ArrayBuffer>.
  // At runtime our Uint8Arrays are always backed by plain ArrayBuffer, so
  // the cast is safe.
  return arr as BufferSource;
}

/** Encode string to BufferSource via TextEncoder (for SubtleCrypto APIs) */
export function textEncode(text: string): BufferSource {
  return toArrayBuffer(new TextEncoder().encode(text));
}

/** Encode bytes to lowercase hex string */
export function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode hex string to Uint8Array */
export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexDecode: input length must be even, got ${hex.length}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexDecode: input contains non-hex characters");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
