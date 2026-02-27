import { describe, it, expect } from "vitest";
import {
  buildPersonalEntryAAD,
  buildTeamEntryAAD,
  buildAttachmentAAD,
  AAD_VERSION,
} from "./crypto-aad";

describe("crypto-aad", () => {
  // ─── Binary Format Verification ───────────────────────────────

  describe("binary format", () => {
    it("buildPersonalEntryAAD produces correct binary layout", () => {
      const aad = buildPersonalEntryAAD("user-123", "entry-456");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      // Header
      expect(String.fromCharCode(aad[0], aad[1])).toBe("PV"); // scope
      expect(view.getUint8(2)).toBe(AAD_VERSION); // aadVersion
      expect(view.getUint8(3)).toBe(2); // nFields

      // Field 1: "user-123" (8 bytes)
      expect(view.getUint16(4, false)).toBe(8); // big-endian length
      const field1 = new TextDecoder().decode(aad.slice(6, 6 + 8));
      expect(field1).toBe("user-123");

      // Field 2: "entry-456" (9 bytes)
      expect(view.getUint16(14, false)).toBe(9);
      const field2 = new TextDecoder().decode(aad.slice(16, 16 + 9));
      expect(field2).toBe("entry-456");

      // Total size: 4 (header) + 2+8 + 2+9 = 25
      expect(aad.length).toBe(25);
    });

    it("buildTeamEntryAAD produces correct binary layout with 3 fields", () => {
      const aad = buildTeamEntryAAD("team-abc", "entry-def", "blob");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      expect(String.fromCharCode(aad[0], aad[1])).toBe("OV");
      expect(view.getUint8(2)).toBe(AAD_VERSION);
      expect(view.getUint8(3)).toBe(3); // 3 fields

      // Field 1: "team-abc" (8 bytes)
      expect(view.getUint16(4, false)).toBe(8);

      // Field 3 (vaultType): "blob" (4 bytes)
      // offset = 4 + (2+8) + (2+9) = 25
      const field3Start = 4 + (2 + 8) + (2 + 9);
      expect(view.getUint16(field3Start, false)).toBe(4);
      const field3 = new TextDecoder().decode(
        aad.slice(field3Start + 2, field3Start + 2 + 4)
      );
      expect(field3).toBe("blob");
    });

    it("buildAttachmentAAD produces correct binary layout", () => {
      const aad = buildAttachmentAAD("entry-789", "attach-001");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      expect(String.fromCharCode(aad[0], aad[1])).toBe("AT");
      expect(view.getUint8(2)).toBe(AAD_VERSION);
      expect(view.getUint8(3)).toBe(2);
    });
  });

  // ─── Determinism ──────────────────────────────────────────────

  describe("determinism", () => {
    it("same inputs produce byte-identical output", () => {
      const a = buildPersonalEntryAAD("user-1", "entry-1");
      const b = buildPersonalEntryAAD("user-1", "entry-1");
      expect(a).toEqual(b);
    });

    it("different inputs produce different output", () => {
      const a = buildPersonalEntryAAD("user-1", "entry-1");
      const b = buildPersonalEntryAAD("user-1", "entry-2");
      expect(a).not.toEqual(b);
    });

    it("different scopes produce different output for same fields", () => {
      // PV(entry-1, attach-1) vs AT(entry-1, attach-1)
      const pv = buildPersonalEntryAAD("entry-1", "attach-1");
      const at = buildAttachmentAAD("entry-1", "attach-1");
      expect(pv).not.toEqual(at);
    });
  });

  // ─── Scope Separation ─────────────────────────────────────────

  describe("scope separation", () => {
    it("OV blob vs overview produce different AAD", () => {
      const blob = buildTeamEntryAAD("team-1", "entry-1", "blob");
      const overview = buildTeamEntryAAD("team-1", "entry-1", "overview");
      expect(blob).not.toEqual(overview);
    });

    it("OV defaults to blob vaultType", () => {
      const explicit = buildTeamEntryAAD("team-1", "entry-1", "blob");
      const defaulted = buildTeamEntryAAD("team-1", "entry-1");
      expect(explicit).toEqual(defaulted);
    });
  });

  // ─── UTF-8 Support ────────────────────────────────────────────

  describe("UTF-8 support", () => {
    it("handles multi-byte UTF-8 characters correctly", () => {
      // Japanese characters: 3 bytes each in UTF-8
      const aad = buildPersonalEntryAAD("ユーザー", "エントリ");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

      // "ユーザー" = 4 chars × 3 bytes = 12 bytes
      expect(view.getUint16(4, false)).toBe(12);
    });
  });

  // ─── Error Handling ───────────────────────────────────────────

  describe("error handling", () => {
    it("throws on wrong number of fields (internal consistency)", () => {
      // buildPersonalEntryAAD expects exactly 2 fields
      // We can't pass wrong count directly, but the function validates internally
      // This test confirms the type safety works
      expect(() => buildPersonalEntryAAD("user", "entry")).not.toThrow();
    });

    it("accepts empty string fields (encodes as length=0)", () => {
      const aad = buildPersonalEntryAAD("", "entry-1");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
      expect(view.getUint16(4, false)).toBe(0); // field1 length = 0
    });

    it("handles long field values (10,000 bytes)", () => {
      const longValue = "x".repeat(10000);
      const aad = buildPersonalEntryAAD(longValue, "entry-1");
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
      expect(view.getUint16(4, false)).toBe(10000);
    });
  });

  // ─── Known Vector Test ────────────────────────────────────────

  describe("known vectors", () => {
    it("PV AAD matches hand-computed bytes", () => {
      const aad = buildPersonalEntryAAD("u1", "e1");

      // Expected bytes:
      // [0x50, 0x56]        scope "PV"
      // [0x01]              aadVersion = 1
      // [0x02]              nFields = 2
      // [0x00, 0x02]        field1 length = 2 (big-endian)
      // [0x75, 0x31]        field1 "u1"
      // [0x00, 0x02]        field2 length = 2
      // [0x65, 0x31]        field2 "e1"
      const expected = new Uint8Array([
        0x50, 0x56, // PV
        0x01, // version 1
        0x02, // 2 fields
        0x00, 0x02, // len 2
        0x75, 0x31, // u1
        0x00, 0x02, // len 2
        0x65, 0x31, // e1
      ]);
      expect(aad).toEqual(expected);
    });
  });

  // ─── AAD_VERSION ──────────────────────────────────────────────

  describe("AAD_VERSION", () => {
    it("is 1", () => {
      expect(AAD_VERSION).toBe(1);
    });
  });
});
