// Minimal CBOR encoder for WebAuthn attestation objects and COSE keys.
// Supports only the subset needed: unsigned/negative integers, byte strings,
// text strings, arrays, maps (both string and integer keys).
// No external dependencies — follows RFC 8949.

export function cborEncode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeValue(value, parts);
  return concat(parts);
}

export type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | CborMap;

export interface CborMap {
  [key: string]: CborValue;
}

// Encode a CBOR map with integer keys (used for COSE key maps).
// Keys are sorted by canonical CBOR ordering (lowest value first).
export function cborEncodeIntKeyMap(
  entries: Array<[number, CborValue]>,
): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    // CBOR canonical: positive before negative, then by magnitude
    const aPos = a[0] >= 0;
    const bPos = b[0] >= 0;
    if (aPos !== bPos) return aPos ? -1 : 1;
    return aPos ? a[0] - b[0] : b[0] - a[0]; // for negative, larger abs value = smaller CBOR
  });
  const parts: Uint8Array[] = [];
  writeHead(5, sorted.length, parts); // major type 5 = map
  for (const [key, val] of sorted) {
    encodeInteger(key, parts);
    encodeValue(val, parts);
  }
  return concat(parts);
}

// ── Internal helpers ──

function encodeValue(value: CborValue, parts: Uint8Array[]): void {
  if (typeof value === "number") {
    encodeInteger(value, parts);
  } else if (typeof value === "string") {
    const encoded = new TextEncoder().encode(value);
    writeHead(3, encoded.length, parts); // major type 3 = text string
    parts.push(encoded);
  } else if (value instanceof Uint8Array) {
    writeHead(2, value.length, parts); // major type 2 = byte string
    parts.push(value);
  } else if (Array.isArray(value)) {
    writeHead(4, value.length, parts); // major type 4 = array
    for (const item of value) {
      encodeValue(item, parts);
    }
  } else {
    // Map with string keys — sort by key for deterministic encoding
    const keys = Object.keys(value).sort();
    writeHead(5, keys.length, parts); // major type 5 = map
    for (const key of keys) {
      encodeValue(key, parts); // text string key
      encodeValue(value[key], parts);
    }
  }
}

function encodeInteger(n: number, parts: Uint8Array[]): void {
  if (n >= 0) {
    writeHead(0, n, parts); // major type 0 = unsigned integer
  } else {
    writeHead(1, -1 - n, parts); // major type 1 = negative integer
  }
}

function writeHead(
  majorType: number,
  value: number,
  parts: Uint8Array[],
): void {
  const mt = majorType << 5;
  if (value < 24) {
    parts.push(new Uint8Array([mt | value]));
  } else if (value < 0x100) {
    parts.push(new Uint8Array([mt | 24, value]));
  } else if (value < 0x10000) {
    parts.push(new Uint8Array([mt | 25, (value >> 8) & 0xff, value & 0xff]));
  } else if (value < 0x100000000) {
    parts.push(
      new Uint8Array([
        mt | 26,
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
      ]),
    );
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
