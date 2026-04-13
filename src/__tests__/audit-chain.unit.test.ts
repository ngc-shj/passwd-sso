import { describe, it, expect } from "vitest";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
  type ChainInput,
} from "@/lib/audit-chain";

describe("audit-chain", () => {
  describe("buildChainInput", () => {
    it("normalizes createdAt to ISO 8601 UTC with Z suffix", () => {
      const result = buildChainInput({
        id: "550e8400-e29b-41d4-a716-446655440000",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
        chainSeq: 1n,
        prevHash: Buffer.from([0x00]),
        payload: { action: "ENTRY_CREATE" },
      });

      expect(result.createdAt).toBe("2026-01-15T10:30:00.000Z");
      expect(result.createdAt).toMatch(/Z$/);
    });

    it("serializes chainSeq as string to avoid IEEE 754 precision loss", () => {
      const result = buildChainInput({
        id: "550e8400-e29b-41d4-a716-446655440000",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
        chainSeq: 9007199254740993n, // > Number.MAX_SAFE_INTEGER
        prevHash: Buffer.from([0x00]),
        payload: {},
      });

      expect(result.chainSeq).toBe("9007199254740993");
      expect(typeof result.chainSeq).toBe("string");
    });

    it("hex-encodes prevHash — single byte genesis \\x00", () => {
      const result = buildChainInput({
        id: "test-id",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
        chainSeq: 1n,
        prevHash: Buffer.from([0x00]),
        payload: {},
      });

      expect(result.prevHash).toBe("00");
    });

    it("hex-encodes prevHash — 32-byte SHA-256 output", () => {
      const hash32 = Buffer.alloc(32, 0xab);
      const result = buildChainInput({
        id: "test-id",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
        chainSeq: 2n,
        prevHash: hash32,
        payload: {},
      });

      expect(result.prevHash).toBe("ab".repeat(32));
    });
  });

  describe("computeCanonicalBytes", () => {
    it("produces deterministic JCS (RFC 8785) canonical bytes", () => {
      const input: ChainInput = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        createdAt: "2026-01-15T10:30:00.000Z",
        chainSeq: "1",
        prevHash: "00",
        payload: { action: "ENTRY_CREATE", title: "test" },
      };

      const bytes = computeCanonicalBytes(input);
      const str = bytes.toString("utf-8");

      // JCS sorts keys alphabetically
      expect(str).toBe(
        '{"chainSeq":"1","createdAt":"2026-01-15T10:30:00.000Z","id":"550e8400-e29b-41d4-a716-446655440000","payload":{"action":"ENTRY_CREATE","title":"test"},"prevHash":"00"}',
      );
    });

    it("produces identical output for equivalent inputs regardless of key insertion order", () => {
      const input1: ChainInput = {
        id: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
        chainSeq: "1",
        prevHash: "00",
        payload: { b: 2, a: 1 },
      };

      // Same data, different object creation order
      const input2: ChainInput = {
        payload: { a: 1, b: 2 },
        prevHash: "00",
        chainSeq: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "a",
      };

      const bytes1 = computeCanonicalBytes(input1);
      const bytes2 = computeCanonicalBytes(input2);

      expect(bytes1.equals(bytes2)).toBe(true);
    });
  });

  describe("computeEventHash", () => {
    it("returns a 32-byte SHA-256 digest", () => {
      const prevHash = Buffer.from([0x00]);
      const canonical = Buffer.from("test", "utf-8");
      const result = computeEventHash(prevHash, canonical);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(32);
    });

    // Golden-value test vector 1: genesis prevHash (single byte \x00)
    it("matches golden vector 1 — genesis chain entry", () => {
      const input: ChainInput = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        createdAt: "2026-01-15T10:30:00.000Z",
        chainSeq: "1",
        prevHash: "00",
        payload: { action: "ENTRY_CREATE", title: "test" },
      };

      const prevHash = Buffer.from([0x00]);
      const canonical = computeCanonicalBytes(input);
      const eventHash = computeEventHash(prevHash, canonical);

      expect(eventHash.toString("hex")).toBe(
        "ae91cbf650e0bd0638be63b8d75b3e739efde36df9edfcde1cf153f499bf681d",
      );
    });

    // Golden-value test vector 2: normal 32-byte prevHash (chained from vector 1)
    it("matches golden vector 2 — chained entry with 32-byte prevHash", () => {
      const prevHash = Buffer.from(
        "ae91cbf650e0bd0638be63b8d75b3e739efde36df9edfcde1cf153f499bf681d",
        "hex",
      );

      const input: ChainInput = {
        id: "660e8400-e29b-41d4-a716-446655440001",
        createdAt: "2026-01-15T10:30:01.000Z",
        chainSeq: "2",
        prevHash: prevHash.toString("hex"),
        payload: { action: "ENTRY_UPDATE", title: "updated" },
      };

      const canonical = computeCanonicalBytes(input);
      const eventHash = computeEventHash(prevHash, canonical);

      expect(eventHash.toString("hex")).toBe(
        "4050642603fe1d4a79d3937446f7927c98cb1793f6099cd06f2ae3175f765a0d",
      );
    });

    it("produces different hashes for different prevHash values", () => {
      const canonical = Buffer.from("same-data", "utf-8");
      const hash1 = computeEventHash(Buffer.from([0x00]), canonical);
      const hash2 = computeEventHash(Buffer.from([0x01]), canonical);

      expect(hash1.equals(hash2)).toBe(false);
    });
  });

  describe("end-to-end chain", () => {
    it("buildChainInput → computeCanonicalBytes → computeEventHash produces consistent chain", () => {
      const genesis = Buffer.from([0x00]);

      // Entry 1
      const input1 = buildChainInput({
        id: "id-1",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
        chainSeq: 1n,
        prevHash: genesis,
        payload: { action: "CREATE" },
      });
      const canonical1 = computeCanonicalBytes(input1);
      const hash1 = computeEventHash(genesis, canonical1);

      // Entry 2 — prevHash is hash1
      const input2 = buildChainInput({
        id: "id-2",
        createdAt: new Date("2026-01-15T10:30:01.000Z"),
        chainSeq: 2n,
        prevHash: hash1,
        payload: { action: "UPDATE" },
      });
      const canonical2 = computeCanonicalBytes(input2);
      const hash2 = computeEventHash(hash1, canonical2);

      // Verify chain properties
      expect(hash1.length).toBe(32);
      expect(hash2.length).toBe(32);
      expect(hash1.equals(hash2)).toBe(false);

      // Verify determinism — same inputs produce same hash
      const canonical1b = computeCanonicalBytes(input1);
      const hash1b = computeEventHash(genesis, canonical1b);
      expect(hash1.equals(hash1b)).toBe(true);
    });
  });
});
