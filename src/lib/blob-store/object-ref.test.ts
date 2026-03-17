import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encodeObjectRef,
  decodeObjectRef,
  buildObjectKey,
  type BlobObjectRef,
} from "@/lib/blob-store/object-ref";
import { BLOB_OBJECT_SCOPE } from "@/lib/blob-store/constants";

describe("encodeObjectRef / decodeObjectRef roundtrip", () => {
  it("encodes and decodes a simple key", () => {
    const ref: BlobObjectRef = { key: "personal/entry-1/attach-1.bin" };
    const encoded = encodeObjectRef(ref);
    const decoded = decodeObjectRef(encoded);
    expect(decoded).toEqual(ref);
  });

  it("encodes to a Uint8Array", () => {
    const ref: BlobObjectRef = { key: "some-key" };
    const encoded = encodeObjectRef(ref);
    expect(encoded).toBeInstanceOf(Uint8Array);
  });

  it("encoded bytes are valid UTF-8 JSON", () => {
    const ref: BlobObjectRef = { key: "team/abc/entry-2/att.bin" };
    const encoded = encodeObjectRef(ref);
    const str = Buffer.from(encoded).toString("utf8");
    expect(() => JSON.parse(str)).not.toThrow();
    expect(JSON.parse(str)).toEqual(ref);
  });

  it("handles keys with special characters", () => {
    const ref: BlobObjectRef = { key: "team/uuid-1234/entry/attachment with spaces & chars" };
    const encoded = encodeObjectRef(ref);
    const decoded = decodeObjectRef(encoded);
    expect(decoded).toEqual(ref);
  });

  it("handles long keys", () => {
    const ref: BlobObjectRef = { key: "a".repeat(500) };
    const encoded = encodeObjectRef(ref);
    const decoded = decodeObjectRef(encoded);
    expect(decoded).toEqual(ref);
  });
});

describe("decodeObjectRef edge cases", () => {
  it("returns null for empty Uint8Array", () => {
    const result = decodeObjectRef(new Uint8Array());
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON bytes", () => {
    const badData = new Uint8Array(Buffer.from("not-json"));
    const result = decodeObjectRef(badData);
    expect(result).toBeNull();
  });

  it("returns null when key is missing", () => {
    const data = new Uint8Array(Buffer.from(JSON.stringify({ other: "field" })));
    const result = decodeObjectRef(data);
    expect(result).toBeNull();
  });

  it("returns null when key is not a string", () => {
    const data = new Uint8Array(Buffer.from(JSON.stringify({ key: 123 })));
    const result = decodeObjectRef(data);
    expect(result).toBeNull();
  });

  it("returns null when key is an empty string", () => {
    const data = new Uint8Array(Buffer.from(JSON.stringify({ key: "" })));
    const result = decodeObjectRef(data);
    expect(result).toBeNull();
  });

  it("returns null when stored value is a JSON primitive (not object)", () => {
    const data = new Uint8Array(Buffer.from(JSON.stringify("just-a-string")));
    const result = decodeObjectRef(data);
    expect(result).toBeNull();
  });

  it("returns null when stored value is null JSON", () => {
    const data = new Uint8Array(Buffer.from("null"));
    const result = decodeObjectRef(data);
    expect(result).toBeNull();
  });

  it("returns only the key property even if extra fields are present", () => {
    const data = new Uint8Array(Buffer.from(JSON.stringify({ key: "valid-key", extra: "ignored" })));
    const result = decodeObjectRef(data);
    expect(result).toEqual({ key: "valid-key" });
  });
});

describe("buildObjectKey", () => {
  beforeEach(() => {
    delete process.env.BLOB_OBJECT_PREFIX;
  });

  afterEach(() => {
    delete process.env.BLOB_OBJECT_PREFIX;
  });

  it("builds a personal key with no prefix", () => {
    const key = buildObjectKey({
      attachmentId: "att-1",
      entryId: "entry-1",
    });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.PERSONAL}/entry-1/att-1.bin`);
  });

  it("builds a team key when teamId is provided", () => {
    const key = buildObjectKey({
      attachmentId: "att-2",
      entryId: "entry-2",
      teamId: "team-abc",
    });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.TEAM}/team-abc/entry-2/att-2.bin`);
  });

  it("prepends BLOB_OBJECT_PREFIX when set", () => {
    process.env.BLOB_OBJECT_PREFIX = "my-prefix";
    const key = buildObjectKey({
      attachmentId: "att-3",
      entryId: "entry-3",
    });
    expect(key).toBe(`my-prefix/${BLOB_OBJECT_SCOPE.PERSONAL}/entry-3/att-3.bin`);
  });

  it("strips trailing slashes from BLOB_OBJECT_PREFIX", () => {
    process.env.BLOB_OBJECT_PREFIX = "my-prefix///";
    const key = buildObjectKey({
      attachmentId: "att-4",
      entryId: "entry-4",
    });
    expect(key).toBe(`my-prefix/${BLOB_OBJECT_SCOPE.PERSONAL}/entry-4/att-4.bin`);
  });

  it("handles empty string BLOB_OBJECT_PREFIX as no prefix", () => {
    process.env.BLOB_OBJECT_PREFIX = "";
    const key = buildObjectKey({
      attachmentId: "att-5",
      entryId: "entry-5",
    });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.PERSONAL}/entry-5/att-5.bin`);
  });

  it("handles whitespace-only BLOB_OBJECT_PREFIX as no prefix (trim)", () => {
    process.env.BLOB_OBJECT_PREFIX = "   ";
    const key = buildObjectKey({
      attachmentId: "att-6",
      entryId: "entry-6",
    });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.PERSONAL}/entry-6/att-6.bin`);
  });

  it("uses BLOB_OBJECT_SCOPE.PERSONAL constant for personal entries", () => {
    const key = buildObjectKey({ attachmentId: "a", entryId: "e" });
    expect(key).toContain(BLOB_OBJECT_SCOPE.PERSONAL);
  });

  it("uses BLOB_OBJECT_SCOPE.TEAM constant for team entries", () => {
    const key = buildObjectKey({ attachmentId: "a", entryId: "e", teamId: "t" });
    expect(key).toContain(BLOB_OBJECT_SCOPE.TEAM);
  });

  it("always ends with .bin extension", () => {
    const key = buildObjectKey({ attachmentId: "att-id", entryId: "ent-id" });
    expect(key.endsWith(".bin")).toBe(true);
  });

  it("includes entryId in path segment", () => {
    const key = buildObjectKey({ attachmentId: "a", entryId: "my-entry-uuid" });
    expect(key).toContain("my-entry-uuid");
  });

  it("includes attachmentId in filename", () => {
    const key = buildObjectKey({ attachmentId: "my-attachment-uuid", entryId: "e" });
    expect(key).toContain("my-attachment-uuid");
  });
});
