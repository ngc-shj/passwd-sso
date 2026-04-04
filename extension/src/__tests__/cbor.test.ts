import { describe, it, expect } from "vitest";
import { cborEncode, cborEncodeIntKeyMap } from "../lib/cbor";

// Helper to compare Uint8Array to a hex string
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper to build a Uint8Array from a hex string
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("cborEncode — unsigned integers", () => {
  // RFC 8949 §3.1: major type 0, additional info < 24 → single byte
  it("encodes 0 as 0x00", () => {
    expect(toHex(cborEncode(0))).toBe("00");
  });

  it("encodes 1 as 0x01", () => {
    expect(toHex(cborEncode(1))).toBe("01");
  });

  it("encodes 23 as 0x17 (max single-byte unsigned)", () => {
    expect(toHex(cborEncode(23))).toBe("17");
  });

  // additional info 24: one extra byte follows (0x18, val)
  it("encodes 24 as 0x1818", () => {
    expect(toHex(cborEncode(24))).toBe("1818");
  });

  it("encodes 255 as 0x18ff", () => {
    expect(toHex(cborEncode(255))).toBe("18ff");
  });

  // additional info 25: two extra bytes follow (0x19, hi, lo)
  it("encodes 256 as 0x190100", () => {
    expect(toHex(cborEncode(256))).toBe("190100");
  });

  it("encodes 65535 as 0x19ffff", () => {
    expect(toHex(cborEncode(65535))).toBe("19ffff");
  });
});

describe("cborEncode — negative integers", () => {
  // Major type 1: encoded value = -1 - n, so -1 → 0, -24 → 23, -25 → 24
  it("encodes -1 as 0x20", () => {
    // major type 1 (0x20) | 0 = 0x20
    expect(toHex(cborEncode(-1))).toBe("20");
  });

  it("encodes -7 as 0x26", () => {
    // -1 - (-7) = 6 → 0x20 | 6 = 0x26
    expect(toHex(cborEncode(-7))).toBe("26");
  });

  it("encodes -24 as 0x37", () => {
    // -1 - (-24) = 23 → 0x20 | 23 = 0x37
    expect(toHex(cborEncode(-24))).toBe("37");
  });

  it("encodes -25 as 0x3818", () => {
    // -1 - (-25) = 24 → needs extra byte: 0x20 | 24 = 0x38, then 0x18
    expect(toHex(cborEncode(-25))).toBe("3818");
  });
});

describe("cborEncode — byte strings", () => {
  // Major type 2: 0x40 | length
  it("encodes empty byte string as 0x40", () => {
    expect(toHex(cborEncode(new Uint8Array(0)))).toBe("40");
  });

  it("encodes a 3-byte string with correct header", () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    // 0x43 (major 2, length 3) followed by 01 02 03
    expect(toHex(cborEncode(bytes))).toBe("43010203");
  });

  it("encodes a 24-byte string with two-byte length header", () => {
    const bytes = new Uint8Array(24).fill(0xab);
    // 0x58 0x18 (major 2, additional 24, length = 24) then 24 × 0xab
    const result = cborEncode(bytes);
    expect(result[0]).toBe(0x58); // 0x40 | 24
    expect(result[1]).toBe(24);
    expect(result.length).toBe(26);
    expect(Array.from(result.slice(2))).toEqual(Array.from(bytes));
  });
});

describe("cborEncode — text strings", () => {
  // Major type 3: 0x60 | length
  it("encodes empty text string as 0x60", () => {
    expect(toHex(cborEncode(""))).toBe("60");
  });

  it('encodes "a" as 0x6161', () => {
    // 0x61 (major 3, length 1) + 0x61 (ASCII 'a')
    expect(toHex(cborEncode("a"))).toBe("6161");
  });

  it('encodes "none" correctly (RFC 8949 example)', () => {
    // length 4: 0x64 then 6e 6f 6e 65
    expect(toHex(cborEncode("none"))).toBe("646e6f6e65");
  });

  it("encodes multi-byte UTF-8 (byte length, not char length)", () => {
    // "é" = U+00E9 → UTF-8: 0xC3 0xA9 → length 2
    expect(toHex(cborEncode("é"))).toBe("62c3a9");
  });
});

describe("cborEncode — arrays", () => {
  // Major type 4: 0x80 | length
  it("encodes empty array as 0x80", () => {
    expect(toHex(cborEncode([]))).toBe("80");
  });

  it("encodes [1, 2, 3] as 0x83010203", () => {
    // 0x83 (major 4, length 3) + 0x01 0x02 0x03
    expect(toHex(cborEncode([1, 2, 3]))).toBe("83010203");
  });

  it("encodes nested arrays", () => {
    // [[1]] → 0x81 (array len 1) + 0x81 (array len 1) + 0x01
    expect(toHex(cborEncode([[1]]))).toBe("818101");
  });

  it("encodes mixed-type array", () => {
    // [1, "a"] → 0x82 01 61 61
    expect(toHex(cborEncode([1, "a"]))).toBe("82016161");
  });
});

describe("cborEncode — maps with string keys", () => {
  // Major type 5: 0xa0 | count, keys sorted alphabetically
  it("encodes empty map as 0xa0", () => {
    expect(toHex(cborEncode({}))).toBe("a0");
  });

  it("encodes single-entry map {a: 1}", () => {
    // 0xa1 (map, 1 entry) + 0x61 0x61 ("a") + 0x01 (1)
    expect(toHex(cborEncode({ a: 1 }))).toBe("a1616101");
  });

  it("sorts string keys deterministically", () => {
    // {b: 2, a: 1} should encode with "a" before "b"
    const result = toHex(cborEncode({ b: 2, a: 1 }));
    const resultForward = toHex(cborEncode({ a: 1, b: 2 }));
    // Both should produce the same bytes
    expect(result).toBe(resultForward);
    // "a" (0x61 0x61) should appear before "b" (0x61 0x62)
    expect(result.indexOf("6161")).toBeLessThan(result.indexOf("6162"));
  });

  it("encodes attestation object structure (fmt/attStmt/authData sorted)", () => {
    // Keys: "attStmt", "authData", "fmt" — alphabetical order
    const authData = new Uint8Array([0xde, 0xad]);
    const result = cborEncode({ fmt: "none", attStmt: {}, authData });
    // 0xa3 = map with 3 entries
    expect(result[0]).toBe(0xa3);
    // Verify "attStmt" comes before "authData" before "fmt"
    const hex = toHex(result);
    // "attStmt" as tstr: 67 61747453746d74
    const attStmtPos = hex.indexOf("6761747453746d74");
    // "authData" as tstr: 68 6175746844617461
    const authDataPos = hex.indexOf("686175746844617461");
    // "fmt" as tstr: 63 666d74
    const fmtPos = hex.indexOf("63666d74");
    expect(attStmtPos).toBeLessThan(authDataPos);
    expect(authDataPos).toBeLessThan(fmtPos);
  });
});

describe("cborEncodeIntKeyMap — integer key sorting", () => {
  it("sorts positive keys before negative keys", () => {
    const result = cborEncodeIntKeyMap([
      [-1, 1],
      [1, 2],
    ]);
    const hex = toHex(result);
    // 0xa2 = map with 2 entries
    expect(result[0]).toBe(0xa2);
    // positive key 1 (0x01) should appear before negative key -1 (0x20)
    const posPos = hex.indexOf("0102"); // key=1 (0x01), val=2 (0x02)
    const negPos = hex.indexOf("2001"); // key=-1 (0x20), val=1 (0x01)
    expect(posPos).toBeLessThan(negPos);
  });

  it("sorts positive keys by ascending magnitude", () => {
    const result = cborEncodeIntKeyMap([
      [3, "c"],
      [1, "a"],
      [2, "b"],
    ]);
    const hex = toHex(result);
    const pos1 = hex.indexOf("016161"); // key=1, val="a"
    const pos2 = hex.indexOf("026162"); // key=2, val="b"
    const pos3 = hex.indexOf("036163"); // key=3, val="c"
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  it("sorts negative keys: smaller absolute value first (-1 before -2)", () => {
    // CBOR canonical: for negatives, larger absolute value = larger CBOR integer
    // so -1 (stored as 0) sorts before -2 (stored as 1)
    const result = cborEncodeIntKeyMap([
      [-2, "b"],
      [-1, "a"],
    ]);
    const hex = toHex(result);
    const neg1Pos = hex.indexOf("206161"); // key=-1 (0x20), val="a"
    const neg2Pos = hex.indexOf("216162"); // key=-2 (0x21), val="b"
    expect(neg1Pos).toBeLessThan(neg2Pos);
  });

  it("encodes a realistic COSE_Key (kty=2, alg=-7, crv=1, x=32 bytes, y=32 bytes)", () => {
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);

    const result = cborEncodeIntKeyMap([
      [1, 2],    // kty: EC2
      [3, -7],   // alg: ES256
      [-1, 1],   // crv: P-256
      [-2, x],   // x coordinate
      [-3, y],   // y coordinate
    ]);

    const hex = toHex(result);

    // Map header: 0xa5 (map with 5 entries)
    expect(result[0]).toBe(0xa5);

    // Positive keys first: kty (1→2), alg (3→-7)
    // key=1 (0x01), val=2 (0x02)
    expect(hex).toContain("0102");
    // key=3 (0x03), val=-7 (0x26 = 0x20 | 6)
    expect(hex).toContain("0326");

    // Negative keys after: crv (-1→1), x (-2→32 bytes), y (-3→32 bytes)
    // key=-1 (0x20), val=1 (0x01)
    expect(hex).toContain("2001");

    // x: key=-2 (0x21), val=bstr 32 bytes (0x5820 then 32 × 0x11)
    const xEncoded = "21" + "5820" + "11".repeat(32);
    expect(hex).toContain(xEncoded);

    // y: key=-3 (0x22), val=bstr 32 bytes (0x5820 then 32 × 0x22)
    const yEncoded = "22" + "5820" + "22".repeat(32);
    expect(hex).toContain(yEncoded);

    // Positive keys appear before negative keys in the output
    const posSection = hex.indexOf("0102");
    const negSection = hex.indexOf("2001");
    expect(posSection).toBeLessThan(negSection);
  });
});
