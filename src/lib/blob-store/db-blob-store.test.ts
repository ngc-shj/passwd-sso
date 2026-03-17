import { describe, it, expect } from "vitest";
import { dbBlobStore } from "@/lib/blob-store/db-blob-store";
import { BLOB_STORAGE } from "@/lib/blob-store/types";

const DUMMY_CONTEXT = { attachmentId: "att-1", entryId: "entry-1" };

describe("dbBlobStore", () => {
  describe("backend", () => {
    it("has backend = 'db'", () => {
      expect(dbBlobStore.backend).toBe(BLOB_STORAGE.DB);
    });
  });

  describe("validateConfig", () => {
    it("does not throw (no external config required)", () => {
      expect(() => dbBlobStore.validateConfig()).not.toThrow();
    });
  });

  describe("putObject", () => {
    it("returns Uint8Array when given a Uint8Array", async () => {
      const input = new Uint8Array([1, 2, 3, 4]);
      const result = await dbBlobStore.putObject(input, DUMMY_CONTEXT);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(input);
    });

    it("converts Buffer to Uint8Array", async () => {
      const buf = Buffer.from([10, 20, 30]);
      const result = await dbBlobStore.putObject(buf, DUMMY_CONTEXT);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });

    it("preserves data content for Uint8Array input", async () => {
      const input = new Uint8Array([255, 0, 128, 64]);
      const result = await dbBlobStore.putObject(input, DUMMY_CONTEXT);
      expect(Array.from(result)).toEqual([255, 0, 128, 64]);
    });

    it("handles empty Uint8Array", async () => {
      const input = new Uint8Array([]);
      const result = await dbBlobStore.putObject(input, DUMMY_CONTEXT);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
  });

  describe("getObject", () => {
    it("returns a Buffer from Uint8Array input", async () => {
      const stored = new Uint8Array([5, 10, 15]);
      const result = await dbBlobStore.getObject(stored, DUMMY_CONTEXT);
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("preserves data content", async () => {
      const stored = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await dbBlobStore.getObject(stored, DUMMY_CONTEXT);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it("handles empty stored data", async () => {
      const stored = new Uint8Array([]);
      const result = await dbBlobStore.getObject(stored, DUMMY_CONTEXT);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe("deleteObject", () => {
    it("resolves without error (no-op)", async () => {
      const stored = new Uint8Array([1, 2, 3]);
      await expect(dbBlobStore.deleteObject(stored, DUMMY_CONTEXT)).resolves.toBeUndefined();
    });
  });

  describe("toStored", () => {
    it("returns Uint8Array unchanged when given a Uint8Array", () => {
      const input = new Uint8Array([7, 8, 9]);
      const result = dbBlobStore.toStored(input);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toBe(input);
    });

    it("converts Buffer to Uint8Array", () => {
      const buf = Buffer.from([1, 2, 3]);
      const result = dbBlobStore.toStored(buf);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });
  });

  describe("toBuffer", () => {
    it("returns a Buffer from Uint8Array", () => {
      const stored = new Uint8Array([100, 200, 50]);
      const result = dbBlobStore.toBuffer(stored);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(Array.from(result)).toEqual([100, 200, 50]);
    });

    it("handles empty input", () => {
      const result = dbBlobStore.toBuffer(new Uint8Array([]));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe("toBase64", () => {
    it("returns a base64 string from Uint8Array", () => {
      const stored = new Uint8Array(Buffer.from("hello world"));
      const result = dbBlobStore.toBase64(stored);
      expect(result).toBe(Buffer.from("hello world").toString("base64"));
    });

    it("returns empty string for empty input", () => {
      const result = dbBlobStore.toBase64(new Uint8Array([]));
      expect(result).toBe("");
    });

    it("produces valid base64 string (decodable)", () => {
      const original = new Uint8Array([1, 2, 3, 254, 255]);
      const b64 = dbBlobStore.toBase64(original);
      const decoded = Buffer.from(b64, "base64");
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });
  });

  describe("putObject -> getObject roundtrip", () => {
    it("roundtrips binary data through put then get", async () => {
      const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
      const stored = await dbBlobStore.putObject(original, DUMMY_CONTEXT);
      const retrieved = await dbBlobStore.getObject(stored, DUMMY_CONTEXT);
      expect(Array.from(retrieved)).toEqual(Array.from(original));
    });
  });

  describe("toStored -> toBuffer roundtrip", () => {
    it("roundtrips data through toStored then toBuffer", () => {
      const original = new Uint8Array([10, 20, 30, 40]);
      const stored = dbBlobStore.toStored(original);
      const buf = dbBlobStore.toBuffer(stored);
      expect(Array.from(buf)).toEqual(Array.from(original));
    });
  });

  describe("toStored -> toBase64 roundtrip", () => {
    it("roundtrips data through toStored then toBase64 then back", () => {
      const original = new Uint8Array([99, 100, 101]);
      const stored = dbBlobStore.toStored(original);
      const b64 = dbBlobStore.toBase64(stored);
      const decoded = Buffer.from(b64, "base64");
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });
  });
});
