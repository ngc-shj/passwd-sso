import { describe, it, expect } from "vitest";
import { buildPersonalEntryAAD } from "../../lib/crypto-aad.js";

describe("crypto-aad", () => {
  describe("binary format", () => {
    it("buildPersonalEntryAAD produces correct binary layout", () => {
      const aad = buildPersonalEntryAAD("user-123", "entry-456", "blob");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      // Header
      expect(String.fromCharCode(aad[0], aad[1])).toBe("PV"); // scope
      expect(view.getUint8(2)).toBe(1); // aadVersion
      expect(view.getUint8(3)).toBe(3); // nFields (was 2, now 3 with vaultType)

      // Field 1: "user-123" (8 bytes)
      expect(view.getUint16(4, false)).toBe(8);
      const field1 = new TextDecoder().decode(aad.slice(6, 6 + 8));
      expect(field1).toBe("user-123");

      // Field 2: "entry-456" (9 bytes)
      expect(view.getUint16(14, false)).toBe(9);
      const field2 = new TextDecoder().decode(aad.slice(16, 16 + 9));
      expect(field2).toBe("entry-456");

      // Field 3: "blob" (4 bytes)
      const field3Start = 4 + (2 + 8) + (2 + 9);
      expect(view.getUint16(field3Start, false)).toBe(4);
      const field3 = new TextDecoder().decode(
        aad.slice(field3Start + 2, field3Start + 2 + 4),
      );
      expect(field3).toBe("blob");

      // Total size: 4 (header) + 2+8 + 2+9 + 2+4 = 31
      expect(aad.length).toBe(31);
    });

    it("PV blob vs overview produce different AAD", () => {
      const blob = buildPersonalEntryAAD("u1", "e1", "blob");
      const overview = buildPersonalEntryAAD("u1", "e1", "overview");
      expect(blob).not.toEqual(overview);
    });
  });

  describe("determinism", () => {
    it("same inputs produce byte-identical output", () => {
      const a = buildPersonalEntryAAD("user-1", "entry-1", "blob");
      const b = buildPersonalEntryAAD("user-1", "entry-1", "blob");
      expect(a).toEqual(b);
    });

    it("different inputs produce different output", () => {
      const a = buildPersonalEntryAAD("user-1", "entry-1", "blob");
      const b = buildPersonalEntryAAD("user-1", "entry-2", "blob");
      expect(a).not.toEqual(b);
    });
  });

  describe("UTF-8 support", () => {
    it("handles multi-byte UTF-8 characters correctly", () => {
      const aad = buildPersonalEntryAAD("ユーザー", "エントリ", "blob");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      // "ユーザー" = 4 chars × 3 bytes = 12 bytes
      expect(view.getUint16(4, false)).toBe(12);
    });
  });

  describe("error handling", () => {
    it("accepts empty string fields", () => {
      const aad = buildPersonalEntryAAD("", "entry-1", "blob");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
      expect(view.getUint16(4, false)).toBe(0);
    });
  });

  // IMPORTANT: Keep the byte snapshot below BYTE-IDENTICAL to the matching
  // `known vectors` block in src/lib/crypto-aad.test.ts. If either side
  // diverges, the CLI cannot decrypt server-encrypted entries (or vice versa).
  // Any change to the AAD wire format (AAD_VERSION bump, field order, etc.)
  // MUST be applied to src/lib/crypto-aad.ts, cli/src/lib/crypto-aad.ts,
  // and BOTH snapshot blocks in the same PR.
  describe("known vectors (interop with web client)", () => {
    it("PV AAD matches hand-computed bytes", () => {
      const aad = buildPersonalEntryAAD("u1", "e1", "blob");

      const expected = new Uint8Array([
        0x50, 0x56, // PV
        0x01, // version 1
        0x03, // 3 fields (was 2 — vaultType added)
        0x00, 0x02, // len 2
        0x75, 0x31, // u1
        0x00, 0x02, // len 2
        0x65, 0x31, // e1
        0x00, 0x04, // len 4
        0x62, 0x6c, 0x6f, 0x62, // "blob"
      ]);
      expect(aad).toEqual(expected);
    });
  });
});
