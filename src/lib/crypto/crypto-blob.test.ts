/**
 * Tests for crypto-blob.ts column mappers. These are pure helpers that map
 * `{ ciphertext, iv, authTag }` to Prisma column shapes — no crypto, no I/O.
 *
 * Round-trip tests use REAL `encryptServerData` / `decryptServerData`
 * (NOT mocked) to verify the mapping doesn't drop or transpose fields.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { toBlobColumns, toOverviewColumns, type EncryptedField } from "./crypto-blob";
import { encryptServerData, decryptServerData } from "./crypto-server";

describe("crypto-blob", () => {
  describe("toBlobColumns", () => {
    it("maps EncryptedField fields to encryptedBlob/blobIv/blobAuthTag", () => {
      const f: EncryptedField = {
        ciphertext: "CT_bytes",
        iv: "IV_bytes",
        authTag: "TAG_bytes",
      };
      expect(toBlobColumns(f)).toEqual({
        encryptedBlob: "CT_bytes",
        blobIv: "IV_bytes",
        blobAuthTag: "TAG_bytes",
      });
    });

    it("keeps original field values byte-identical (no transformation)", () => {
      const f: EncryptedField = {
        ciphertext: "abcd1234",
        iv: "0123456789ab",
        authTag: "ffffffffffffffffffffffffffffffff",
      };
      const cols = toBlobColumns(f);
      expect(cols.encryptedBlob).toBe(f.ciphertext);
      expect(cols.blobIv).toBe(f.iv);
      expect(cols.blobAuthTag).toBe(f.authTag);
    });

    it("does NOT include overview columns", () => {
      const cols = toBlobColumns({ ciphertext: "c", iv: "i", authTag: "t" });
      expect(cols).not.toHaveProperty("encryptedOverview");
      expect(cols).not.toHaveProperty("overviewIv");
      expect(cols).not.toHaveProperty("overviewAuthTag");
    });

    it("handles empty strings", () => {
      const cols = toBlobColumns({ ciphertext: "", iv: "", authTag: "" });
      expect(cols).toEqual({ encryptedBlob: "", blobIv: "", blobAuthTag: "" });
    });
  });

  describe("toOverviewColumns", () => {
    it("maps EncryptedField fields to encryptedOverview/overviewIv/overviewAuthTag", () => {
      const f: EncryptedField = {
        ciphertext: "CT2",
        iv: "IV2",
        authTag: "TAG2",
      };
      expect(toOverviewColumns(f)).toEqual({
        encryptedOverview: "CT2",
        overviewIv: "IV2",
        overviewAuthTag: "TAG2",
      });
    });

    it("does NOT include blob columns", () => {
      const cols = toOverviewColumns({ ciphertext: "c", iv: "i", authTag: "t" });
      expect(cols).not.toHaveProperty("encryptedBlob");
      expect(cols).not.toHaveProperty("blobIv");
      expect(cols).not.toHaveProperty("blobAuthTag");
    });

    it("handles empty strings", () => {
      const cols = toOverviewColumns({ ciphertext: "", iv: "", authTag: "" });
      expect(cols).toEqual({ encryptedOverview: "", overviewIv: "", overviewAuthTag: "" });
    });
  });

  describe("round-trip with real crypto-server", () => {
    it("blob columns survive encrypt → toBlobColumns → manual decrypt", () => {
      const teamKey = randomBytes(32);
      const plaintext = JSON.stringify({ password: "p4ssw0rd!", title: "GitHub" });

      const encrypted = encryptServerData(plaintext, teamKey);
      const cols = toBlobColumns(encrypted);

      // Reconstruct shape from "DB columns" and decrypt
      const reconstructed: EncryptedField = {
        ciphertext: cols.encryptedBlob,
        iv: cols.blobIv,
        authTag: cols.blobAuthTag,
      };
      const decrypted = decryptServerData(reconstructed, teamKey);
      expect(decrypted).toBe(plaintext);
    });

    it("overview columns survive encrypt → toOverviewColumns → manual decrypt", () => {
      const teamKey = randomBytes(32);
      const plaintext = JSON.stringify({ title: "x", urlHost: "example.com" });

      const encrypted = encryptServerData(plaintext, teamKey);
      const cols = toOverviewColumns(encrypted);

      const reconstructed: EncryptedField = {
        ciphertext: cols.encryptedOverview,
        iv: cols.overviewIv,
        authTag: cols.overviewAuthTag,
      };
      expect(decryptServerData(reconstructed, teamKey)).toBe(plaintext);
    });

    it("round-trips empty plaintext", () => {
      const teamKey = randomBytes(32);
      const encrypted = encryptServerData("", teamKey);
      const cols = toBlobColumns(encrypted);
      const reconstructed: EncryptedField = {
        ciphertext: cols.encryptedBlob,
        iv: cols.blobIv,
        authTag: cols.blobAuthTag,
      };
      expect(decryptServerData(reconstructed, teamKey)).toBe("");
    });

    it("round-trips a 64 KiB plaintext (large overview-style payload)", () => {
      const teamKey = randomBytes(32);
      const plaintext = "x".repeat(64 * 1024);
      const encrypted = encryptServerData(plaintext, teamKey);
      const cols = toOverviewColumns(encrypted);
      const reconstructed: EncryptedField = {
        ciphertext: cols.encryptedOverview,
        iv: cols.overviewIv,
        authTag: cols.overviewAuthTag,
      };
      expect(decryptServerData(reconstructed, teamKey)).toBe(plaintext);
    });

    it("blob and overview column sets do not collide on field names", () => {
      const f: EncryptedField = { ciphertext: "c", iv: "i", authTag: "t" };
      const blob = toBlobColumns(f);
      const overview = toOverviewColumns(f);
      // No key overlap — important so callers can spread BOTH into one
      // Prisma update without one shadowing the other.
      const blobKeys = Object.keys(blob);
      const overviewKeys = Object.keys(overview);
      const overlap = blobKeys.filter((k) => overviewKeys.includes(k));
      expect(overlap).toEqual([]);
    });
  });
});
