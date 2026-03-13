// Shared crypto utility functions used by both client and server modules.
// Pure functions with no side-effects — safe to import from any module.

/** Convert Uint8Array to ArrayBuffer (fixes TS 5.9 BufferSource compatibility) */
export function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  ) as ArrayBuffer;
}

/** Encode string to ArrayBuffer via TextEncoder */
export function textEncode(text: string): ArrayBuffer {
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
