import { describe, it, expect } from "vitest";
import {
  p1363ToDer,
  base64urlEncode,
  base64urlDecode,
  encodeCoseEC2Key,
  buildAssertionAuthData,
  buildAttestationAuthData,
  generatePasskeyKeypair,
  generateCredentialId,
  buildAttestationObject,
} from "../lib/webauthn-crypto";

// Helper to get hex representation of a Uint8Array
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper to read a big-endian uint32 from 4 bytes
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

describe("p1363ToDer", () => {
  it("throws on input that is not 64 bytes", () => {
    expect(() => p1363ToDer(new Uint8Array(32))).toThrow(
      "Expected 64-byte P1363 signature",
    );
    expect(() => p1363ToDer(new Uint8Array(65))).toThrow(
      "Expected 64-byte P1363 signature",
    );
    expect(() => p1363ToDer(new Uint8Array(0))).toThrow(
      "Expected 64-byte P1363 signature",
    );
  });

  it("normal case: both r and s have high bit clear (no padding needed)", () => {
    // r = [0x01, 0x02, ..., 0x20] (no leading zeros, high bit clear)
    // s = [0x41, 0x42, ..., 0x60] (no leading zeros, high bit clear)
    const sig = new Uint8Array(64);
    for (let i = 0; i < 32; i++) sig[i] = i + 1;       // r: 01 02 ... 20
    for (let i = 0; i < 32; i++) sig[32 + i] = i + 0x41; // s: 41 42 ... 60

    const der = p1363ToDer(sig);

    // Should start with SEQUENCE tag 0x30
    expect(der[0]).toBe(0x30);

    // INTEGER tag for r at offset 2; no leading zeros, no high-bit pad → length 32
    const rOffset = 2;
    expect(der[rOffset]).toBe(0x02);     // INTEGER tag
    expect(der[rOffset + 1]).toBe(32);   // length = 32 (no stripping, no pad)
    expect(der[rOffset + 2]).toBe(0x01); // first byte of r

    // INTEGER for s follows after tag(1) + len(1) + 32 bytes
    const sOffset = rOffset + 2 + 32;
    expect(der[sOffset]).toBe(0x02);     // INTEGER tag
    expect(der[sOffset + 1]).toBe(32);   // length = 32
    expect(der[sOffset + 2]).toBe(0x41); // first byte of s
  });

  it("high bit case: r[0] >= 0x80 requires 0x00 pad byte", () => {
    const sig = new Uint8Array(64);
    // r[0] = 0x80 — high bit set, needs 0x00 pad → DER length = 33
    sig[0] = 0x80;
    for (let i = 1; i < 32; i++) sig[i] = i; // fill rest of r with non-zero
    // s[0] = 0x7f — high bit clear, no padding → DER length = 32
    sig[32] = 0x7f;
    for (let i = 1; i < 32; i++) sig[32 + i] = i;

    const der = p1363ToDer(sig);

    expect(der[0]).toBe(0x30);

    // r starts at offset 2
    const rOffset = 2;
    expect(der[rOffset]).toBe(0x02);     // INTEGER tag
    // r[0]=0x80 has high bit set → pad with 0x00 → length = 33
    expect(der[rOffset + 1]).toBe(33);
    expect(der[rOffset + 2]).toBe(0x00); // padding byte
    expect(der[rOffset + 3]).toBe(0x80); // original first byte of r

    // s starts after r: offset = 2 (seq hdr) + 2 (tag+len) + 33 (r value)
    const sOffset = rOffset + 2 + 33;
    expect(der[sOffset]).toBe(0x02);
    // s[0]=0x7f has high bit clear → no pad → length = 32
    expect(der[sOffset + 1]).toBe(32);
    expect(der[sOffset + 2]).toBe(0x7f);
  });

  it("leading zeros case: strips leading zeros but keeps at least one byte", () => {
    const sig = new Uint8Array(64);
    // r = [0x00, 0x00, 0x01, 0x00, ...rest zeros]
    // Leading zeros are stripped, leaving [0x01, 0x00, ..., 0x00] — 30 bytes
    sig[2] = 0x01; // r bytes 0,1 are 0x00, byte 2 is 0x01, rest zeros

    // s = all zeros — the loop `while (start < bytes.length - 1 && bytes[start] === 0)`
    // stops when start = 31 (bytes.length - 1 = 31), leaving one byte: [0x00]
    // → DER length = 1, value = 0x00

    const der = p1363ToDer(sig);

    // r: two leading zeros stripped → remaining slice is bytes[2..32] = 30 bytes
    // bytes[2] = 0x01 (high bit clear, no pad) → DER length = 30
    const rOffset = 2;
    expect(der[rOffset]).toBe(0x02);
    expect(der[rOffset + 1]).toBe(30); // 32 - 2 leading zeros stripped
    expect(der[rOffset + 2]).toBe(0x01);

    // s = all zeros → stripped to single 0x00 byte → DER length = 1
    const sOffset = rOffset + 2 + 30;
    expect(der[sOffset]).toBe(0x02);
    expect(der[sOffset + 1]).toBe(1);
    expect(der[sOffset + 2]).toBe(0x00);
  });

  it("produces valid DER SEQUENCE structure", () => {
    const sig = new Uint8Array(64);
    // Use a typical-looking signature with non-trivial r and s
    for (let i = 0; i < 32; i++) sig[i] = i + 1;       // r = 01 02 ... 20
    for (let i = 0; i < 32; i++) sig[32 + i] = i + 10; // s = 0a 0b ... 29

    const der = p1363ToDer(sig);

    expect(der[0]).toBe(0x30); // SEQUENCE
    // total length = der[1]
    expect(der.length).toBe(der[1] + 2);
  });
});

describe("base64urlEncode / base64urlDecode", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]);
    const encoded = base64urlEncode(bytes);
    const decoded = base64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("uses URL-safe alphabet (no + or / or = padding)", () => {
    // Use bytes that would produce + and / in standard base64
    // 0xfb = 11111011 → standard base64 would use '+' and '/'
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const encoded = base64urlEncode(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(encoded).toContain("-");
    expect(encoded).toContain("_");
  });

  it("encodes known value: [0x00, 0x00, 0x00] → AAAA", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00]);
    expect(base64urlEncode(bytes)).toBe("AAAA");
  });

  it("decodes back to the same bytes for empty input", () => {
    const bytes = new Uint8Array(0);
    const encoded = base64urlEncode(bytes);
    const decoded = base64urlDecode(encoded);
    expect(decoded.length).toBe(0);
  });

  it("round-trips 32 random-looking bytes", () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 37 + 13) % 256;
    const rt = base64urlDecode(base64urlEncode(bytes));
    expect(Array.from(rt)).toEqual(Array.from(bytes));
  });
});

describe("encodeCoseEC2Key", () => {
  it("throws when input is not 65 bytes", () => {
    expect(() => encodeCoseEC2Key(new Uint8Array(64))).toThrow(
      "Expected uncompressed P-256 public key",
    );
    expect(() => encodeCoseEC2Key(new Uint8Array(66))).toThrow(
      "Expected uncompressed P-256 public key",
    );
    expect(() => encodeCoseEC2Key(new Uint8Array(0))).toThrow(
      "Expected uncompressed P-256 public key",
    );
  });

  it("throws when first byte is not 0x04 (not uncompressed)", () => {
    const key = new Uint8Array(65);
    key[0] = 0x02; // compressed point
    expect(() => encodeCoseEC2Key(key)).toThrow(
      "Expected uncompressed P-256 public key",
    );
  });

  it("produces valid COSE_Key from a 65-byte uncompressed point", () => {
    const rawKey = new Uint8Array(65);
    rawKey[0] = 0x04; // uncompressed point prefix
    // x = bytes 1–32, y = bytes 33–64
    for (let i = 1; i <= 32; i++) rawKey[i] = 0xaa;
    for (let i = 33; i <= 64; i++) rawKey[i] = 0xbb;

    const cose = encodeCoseEC2Key(rawKey);
    const hex = toHex(cose);

    // Should be a CBOR map: 0xa5 (5 entries)
    expect(cose[0]).toBe(0xa5);

    // kty=2: key 0x01, val 0x02
    expect(hex).toContain("0102");
    // alg=-7: key 0x03, val 0x26 (0x20|6)
    expect(hex).toContain("0326");
    // crv=1: key 0x20 (-1), val 0x01
    expect(hex).toContain("2001");
    // x=32 bytes of 0xaa: key 0x21 (-2), bstr header 0x5820, then aa×32
    expect(hex).toContain("21" + "5820" + "aa".repeat(32));
    // y=32 bytes of 0xbb: key 0x22 (-3), bstr header 0x5820, then bb×32
    expect(hex).toContain("22" + "5820" + "bb".repeat(32));
  });

  it("produces COSE_Key from a real generated P-256 key pair", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const rawKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    expect(rawKey.length).toBe(65);
    expect(rawKey[0]).toBe(0x04);

    const cose = encodeCoseEC2Key(rawKey);
    expect(cose[0]).toBe(0xa5); // CBOR map with 5 entries
    // The x and y coordinates should be bytes 1–32 and 33–64 of rawKey
    const x = rawKey.slice(1, 33);
    const y = rawKey.slice(33, 65);
    const hex = toHex(cose);
    expect(hex).toContain("21" + "5820" + toHex(x));
    expect(hex).toContain("22" + "5820" + toHex(y));
  });
});

describe("buildAssertionAuthData", () => {
  it("returns exactly 37 bytes", async () => {
    const authData = await buildAssertionAuthData("example.com", 0);
    expect(authData.length).toBe(37);
  });

  it("first 32 bytes are SHA-256 of the rpId", async () => {
    const rpId = "example.com";
    const authData = await buildAssertionAuthData(rpId, 0);

    const expectedHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    );
    expect(Array.from(authData.slice(0, 32))).toEqual(Array.from(expectedHash));
  });

  it("byte[32] is 0x05 (UP | UV flags)", async () => {
    const authData = await buildAssertionAuthData("example.com", 0);
    // FLAG_UP = 0x01, FLAG_UV = 0x04 → 0x05
    expect(authData[32]).toBe(0x05);
  });

  it("bytes[33–36] encode signCount as big-endian uint32", async () => {
    const signCount = 42;
    const authData = await buildAssertionAuthData("example.com", signCount);
    expect(readUint32BE(authData, 33)).toBe(signCount);
  });

  it("encodes signCount 0x01020304 correctly", async () => {
    const signCount = 0x01020304;
    const authData = await buildAssertionAuthData("example.com", signCount);
    expect(authData[33]).toBe(0x01);
    expect(authData[34]).toBe(0x02);
    expect(authData[35]).toBe(0x03);
    expect(authData[36]).toBe(0x04);
  });

  it("produces different rpId hashes for different rpIds", async () => {
    const auth1 = await buildAssertionAuthData("example.com", 0);
    const auth2 = await buildAssertionAuthData("other.com", 0);
    expect(Array.from(auth1.slice(0, 32))).not.toEqual(
      Array.from(auth2.slice(0, 32)),
    );
  });
});

describe("buildAttestationAuthData", () => {
  it("output is longer than 37 bytes (includes attested credential data)", async () => {
    const credId = new Uint8Array(32).fill(0xcc);
    const coseKey = new Uint8Array(10).fill(0xdd); // mock COSE key bytes
    const authData = await buildAttestationAuthData(
      "example.com",
      0,
      credId,
      coseKey,
    );
    // 37 + 16 (AAGUID) + 2 (credIdLen) + 32 (credId) + 10 (coseKey) = 97
    expect(authData.length).toBe(97);
  });

  it("first 32 bytes are SHA-256 of rpId", async () => {
    const rpId = "example.com";
    const credId = new Uint8Array(16).fill(0x01);
    const coseKey = new Uint8Array(5);
    const authData = await buildAttestationAuthData(rpId, 0, credId, coseKey);

    const expectedHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    );
    expect(Array.from(authData.slice(0, 32))).toEqual(Array.from(expectedHash));
  });

  it("byte[32] is 0x45 (UP | UV | AT flags)", async () => {
    const credId = new Uint8Array(8);
    const coseKey = new Uint8Array(4);
    const authData = await buildAttestationAuthData(
      "example.com",
      0,
      credId,
      coseKey,
    );
    // FLAG_UP=0x01 | FLAG_UV=0x04 | FLAG_AT=0x40 = 0x45
    expect(authData[32]).toBe(0x45);
  });

  it("bytes[33–36] encode signCount as big-endian uint32", async () => {
    const signCount = 1;
    const credId = new Uint8Array(32);
    const coseKey = new Uint8Array(10);
    const authData = await buildAttestationAuthData(
      "example.com",
      signCount,
      credId,
      coseKey,
    );
    expect(readUint32BE(authData, 33)).toBe(signCount);
  });

  it("bytes[37–52] are all-zero AAGUID (software authenticator)", async () => {
    const credId = new Uint8Array(32);
    const coseKey = new Uint8Array(10);
    const authData = await buildAttestationAuthData(
      "example.com",
      0,
      credId,
      coseKey,
    );
    const aaguid = Array.from(authData.slice(37, 53));
    expect(aaguid).toEqual(new Array(16).fill(0));
  });

  it("bytes[53–54] encode credentialId length as big-endian uint16", async () => {
    const credIdLength = 48;
    const credId = new Uint8Array(credIdLength).fill(0xee);
    const coseKey = new Uint8Array(5);
    const authData = await buildAttestationAuthData(
      "example.com",
      0,
      credId,
      coseKey,
    );
    expect(authData[53]).toBe(0x00);
    expect(authData[54]).toBe(credIdLength);
  });

  it("credential ID bytes follow the length field", async () => {
    const credId = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const coseKey = new Uint8Array(3);
    const authData = await buildAttestationAuthData(
      "example.com",
      0,
      credId,
      coseKey,
    );
    // credId starts at offset 55 (37 base + 16 AAGUID + 2 len)
    expect(Array.from(authData.slice(55, 59))).toEqual([0x11, 0x22, 0x33, 0x44]);
  });
});

describe("generatePasskeyKeypair", () => {
  it("returns an object with privateKeyJwk and publicKeyCose", async () => {
    const keypair = await generatePasskeyKeypair();
    expect(keypair).toHaveProperty("privateKeyJwk");
    expect(keypair).toHaveProperty("publicKeyCose");
  });

  it("privateKeyJwk has crv: P-256 and kty: EC", async () => {
    const { privateKeyJwk } = await generatePasskeyKeypair();
    expect(privateKeyJwk.crv).toBe("P-256");
    expect(privateKeyJwk.kty).toBe("EC");
  });

  it("privateKeyJwk has key_ops including 'sign'", async () => {
    const { privateKeyJwk } = await generatePasskeyKeypair();
    expect(privateKeyJwk.key_ops).toContain("sign");
  });

  it("privateKeyJwk is importable for signing", async () => {
    const { privateKeyJwk } = await generatePasskeyKeypair();
    const key = await crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    expect(key).toBeTruthy();
    expect(key.type).toBe("private");
  });

  it("publicKeyCose is a valid CBOR map (starts with 0xa5)", async () => {
    const { publicKeyCose } = await generatePasskeyKeypair();
    expect(publicKeyCose[0]).toBe(0xa5); // CBOR map with 5 entries
  });

  it("generates unique key pairs on each call", async () => {
    const kp1 = await generatePasskeyKeypair();
    const kp2 = await generatePasskeyKeypair();
    // Public keys should differ
    expect(toHex(kp1.publicKeyCose)).not.toBe(toHex(kp2.publicKeyCose));
  });
});

describe("generateCredentialId", () => {
  it("returns a Uint8Array of exactly 32 bytes", () => {
    const id = generateCredentialId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });

  it("generates different IDs on each call (random)", () => {
    const id1 = generateCredentialId();
    const id2 = generateCredentialId();
    expect(toHex(id1)).not.toBe(toHex(id2));
  });
});

describe("buildAttestationObject", () => {
  it("returns a non-empty Uint8Array", () => {
    const authData = new Uint8Array([0x01, 0x02, 0x03]);
    const result = buildAttestationObject(authData);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("starts with CBOR map header 0xa3 (3 entries)", () => {
    const authData = new Uint8Array(37).fill(0x00);
    const result = buildAttestationObject(authData);
    // { fmt, attStmt, authData } = 3 entries → 0xa3
    expect(result[0]).toBe(0xa3);
  });

  it("contains 'none' format string (CBOR: 0x64 6e6f6e65)", () => {
    const authData = new Uint8Array(37);
    const result = buildAttestationObject(authData);
    const hex = toHex(result);
    // "none" as CBOR tstr: 0x64 + 6e6f6e65
    expect(hex).toContain("646e6f6e65");
  });

  it("contains the authData bytes verbatim", () => {
    const authData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = buildAttestationObject(authData);
    const hex = toHex(result);
    // authData as CBOR bstr: 0x44 + deadbeef
    expect(hex).toContain("44deadbeef");
  });

  it("contains an empty attStmt map (CBOR: 0xa0)", () => {
    const authData = new Uint8Array(5);
    const result = buildAttestationObject(authData);
    const hex = toHex(result);
    expect(hex).toContain("a0"); // empty CBOR map
  });

  it("can be decoded by checking that authData is embedded after keys are sorted", () => {
    // Keys sorted: "attStmt", "authData", "fmt"
    // The CBOR map with sorted string keys puts "authData" in the middle
    const authData = new Uint8Array([0xca, 0xfe]);
    const result = buildAttestationObject(authData);
    const hex = toHex(result);

    // "attStmt" text key (0x67 61747453746d74)
    const attStmtKeyPos = hex.indexOf("6761747453746d74");
    // "authData" text key (0x68 6175746844617461)
    const authDataKeyPos = hex.indexOf("686175746844617461");
    // "fmt" text key (0x63 666d74)
    const fmtKeyPos = hex.indexOf("63666d74");

    expect(attStmtKeyPos).toBeGreaterThanOrEqual(0);
    expect(authDataKeyPos).toBeGreaterThanOrEqual(0);
    expect(fmtKeyPos).toBeGreaterThanOrEqual(0);

    // Alphabetical: attStmt < authData < fmt
    expect(attStmtKeyPos).toBeLessThan(authDataKeyPos);
    expect(authDataKeyPos).toBeLessThan(fmtKeyPos);
  });
});
