import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeObjectRef,
  decodeObjectRef,
  buildObjectKey,
  newBlobGeneration,
  validateObjectRefKey,
  resolveObjectRefKey,
  BlobRefInvalidError,
  parseObjectKey,
  blobMarkerKey,
  MAX_OBJECT_REF_BYTES,
  type BlobObjectRef,
} from "@/lib/blob-store/object-ref";
import { BLOB_OBJECT_SCOPE } from "@/lib/blob-store/constants";
import type { AttachmentBlobPutContext } from "@/lib/blob-store/types";

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

describe("MAX_OBJECT_REF_BYTES", () => {
  it("is a 1024-byte key inside the JSON wrapper", () => {
    expect(MAX_OBJECT_REF_BYTES).toBe(1024 + '{"key":""}'.length);
  });

  it("fits the ref of a maximal key", () => {
    const encoded = encodeObjectRef({ key: "a".repeat(1024) });
    expect(encoded.length).toBe(MAX_OBJECT_REF_BYTES);
    expect(decodeObjectRef(encoded)).toEqual({ key: "a".repeat(1024) });
  });

  it("refuses a ref one byte over", () => {
    expect(() => encodeObjectRef({ key: "a".repeat(1025) })).toThrow(`Blob object ref exceeds ${MAX_OBJECT_REF_BYTES} bytes`);
  });

  it("counts encoded bytes, not characters: escaping and multi-byte text push a shorter key over", () => {
    // 1023 characters, but each `"` is written as `\"`.
    expect(() => encodeObjectRef({ key: `${"a".repeat(1021)}""` })).toThrow();
    // 512 characters of 3-byte UTF-8.
    expect(() => encodeObjectRef({ key: "\u3042".repeat(512) })).toThrow();
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

const GEN = "0123456789abcdef0123456789abcdef";

describe("newBlobGeneration", () => {
  it("returns 32 lowercase hex characters", () => {
    expect(newBlobGeneration()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a fresh value per call", () => {
    expect(newBlobGeneration()).not.toBe(newBlobGeneration());
  });
});

describe("buildObjectKey", () => {
  beforeEach(() => {
    delete process.env.BLOB_OBJECT_PREFIX;
  });

  afterEach(() => {
    delete process.env.BLOB_OBJECT_PREFIX;
  });

  it("builds a personal key with the generation and no prefix", () => {
    const key = buildObjectKey({ attachmentId: "att-1", entryId: "entry-1", generation: GEN });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.PERSONAL}/entry-1/att-1/${GEN}.bin`);
  });

  it("builds a team key when teamId is provided", () => {
    const key = buildObjectKey({
      attachmentId: "att-2",
      entryId: "entry-2",
      teamId: "team-abc",
      generation: GEN,
    });
    expect(key).toBe(`${BLOB_OBJECT_SCOPE.TEAM}/team-abc/entry-2/att-2/${GEN}.bin`);
  });

  it("gives two generations of one attachment different keys", () => {
    const context = { attachmentId: "a", entryId: "e", teamId: "t" };
    expect(buildObjectKey({ ...context, generation: newBlobGeneration() })).not.toBe(
      buildObjectKey({ ...context, generation: newBlobGeneration() }),
    );
  });

  it("prepends BLOB_OBJECT_PREFIX when set", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "my-prefix");
    const key = buildObjectKey({ attachmentId: "att-3", entryId: "entry-3", generation: GEN });
    expect(key).toBe(`my-prefix/${BLOB_OBJECT_SCOPE.PERSONAL}/entry-3/att-3/${GEN}.bin`);
  });

  it("strips trailing slashes from BLOB_OBJECT_PREFIX", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "my-prefix///");
    const key = buildObjectKey({ attachmentId: "att-4", entryId: "entry-4", generation: GEN });
    expect(key).toBe(`my-prefix/${BLOB_OBJECT_SCOPE.PERSONAL}/entry-4/att-4/${GEN}.bin`);
  });

  it("handles empty and whitespace-only BLOB_OBJECT_PREFIX as no prefix", () => {
    for (const prefix of ["", "   "]) {
      vi.stubEnv("BLOB_OBJECT_PREFIX", prefix);
      const key = buildObjectKey({ attachmentId: "att-5", entryId: "entry-5", generation: GEN });
      expect(key).toBe(`${BLOB_OBJECT_SCOPE.PERSONAL}/entry-5/att-5/${GEN}.bin`);
    }
  });

  it.each(["", "ABCDEF0123456789ABCDEF0123456789", "0123", `${GEN}0`, "../../../../x"])(
    "refuses a malformed generation %j",
    (generation) => {
      expect(() => buildObjectKey({ attachmentId: "a", entryId: "e", generation })).toThrow();
    },
  );

  it("a built key validates against its own context", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "pfx/sub");
    const context = { attachmentId: "a1", entryId: "e1", teamId: "t1" };
    expect(validateObjectRefKey(buildObjectKey({ ...context, generation: GEN }), context)).toBe(true);
  });
});

describe("validateObjectRefKey", () => {
  const T = "2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
  const E = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";
  const A = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
  const OTHER = "11111111-2222-4333-8444-555555555555";
  const team = { teamId: T, entryId: E, attachmentId: A };
  const personal = { entryId: E, attachmentId: A };

  it.each([
    ["team legacy", `team/${T}/${E}/${A}.bin`, team],
    ["team generation", `team/${T}/${E}/${A}/${GEN}.bin`, team],
    ["personal legacy", `personal/${E}/${A}.bin`, personal],
    ["personal generation", `personal/${E}/${A}/${GEN}.bin`, personal],
    ["team generation under a prefix", `deploy/a/team/${T}/${E}/${A}/${GEN}.bin`, team],
    ["personal legacy under a prefix", `deploy/personal/${E}/${A}.bin`, personal],
    ["ids in a different case", `team/${T.toUpperCase()}/${E.toUpperCase()}/${A.toUpperCase()}/${GEN}.bin`, team],
  ])("accepts %s", (_label, key, context) => {
    expect(validateObjectRefKey(key, context)).toBe(true);
  });

  // BLOB_REF_INVALID unit table: one row per rejected form.
  it.each([
    ["another team's id", `team/${OTHER}/${E}/${A}/${GEN}.bin`, team],
    ["another entry's id", `team/${T}/${OTHER}/${A}/${GEN}.bin`, team],
    ["another attachment's id", `team/${T}/${E}/${OTHER}/${GEN}.bin`, team],
    ["another attachment's id (legacy)", `team/${T}/${E}/${OTHER}.bin`, team],
    ["a personal key for a team row", `personal/${E}/${A}/${GEN}.bin`, team],
    ["a team key for a personal row", `team/${T}/${E}/${A}/${GEN}.bin`, personal],
    ["a wrong scope literal", `teams/${T}/${E}/${A}/${GEN}.bin`, team],
    ["an upper-case scope literal", `TEAM/${T}/${E}/${A}/${GEN}.bin`, team],
    ["a missing .bin suffix (legacy)", `team/${T}/${E}/${A}`, team],
    ["a missing .bin suffix (generation)", `team/${T}/${E}/${A}/${GEN}`, team],
    ["a short generation", `team/${T}/${E}/${A}/0123abcd.bin`, team],
    ["an upper-case generation", `team/${T}/${E}/${A}/${GEN.toUpperCase()}.bin`, team],
    ["a non-hex generation", `team/${T}/${E}/${A}/${"g".repeat(32)}.bin`, team],
    ["an extra segment after the generation", `team/${T}/${E}/${A}/${GEN}/x.bin`, team],
    ["an extra segment inside the tail", `team/${T}/x/${E}/${A}/${GEN}.bin`, team],
    ["a missing entry segment", `team/${T}/${A}/${GEN}.bin`, team],
    ["`..` in the prefix", `../team/${T}/${E}/${A}/${GEN}.bin`, team],
    ["`..` inside a prefix segment", `a..b/team/${T}/${E}/${A}/${GEN}.bin`, team],
    ["`..` as a tail segment", `team/${T}/${E}/../${E}/${A}.bin`, team],
    ["percent-encoding in the tail", `team/${T}/${E}/${A.slice(0, -2)}%35f/${GEN}.bin`, team],
    ["percent-encoded slash in the tail", `team/${T}%2F${E}/${A}/${GEN}.bin`, team],
    ["an empty tail segment", `team/${T}//${E}/${A}.bin`, team],
    ["a trailing slash", `team/${T}/${E}/${A}/${GEN}.bin/`, team],
    ["a bare key", "x", team],
    ["the empty key", "", team],
  ])("rejects %s", (_label, key, context) => {
    expect(validateObjectRefKey(key, context)).toBe(false);
  });

  // The segment rules hold on their own, not only through the id comparison:
  // a tail segment equal to the row's id is still refused when it carries
  // percent-encoding or `..` (ids are UUIDs in practice; these contexts are
  // contrived to isolate the rule).
  it.each([
    ["a percent-encoded id", `personal/${E}/a%2e%2e.bin`, { entryId: E, attachmentId: "a%2e%2e" }],
    ["a `..` inside an id", `personal/${E}/a..b/${GEN}.bin`, { entryId: E, attachmentId: "a..b" }],
  ])("rejects %s even when it equals the row's id", (_label, key, context) => {
    expect(validateObjectRefKey(key, context)).toBe(false);
  });
});

describe("resolveObjectRefKey", () => {
  const context = { teamId: "t1", entryId: "e1", attachmentId: "a1" };

  it("returns the stored key when it names the row's object", () => {
    const key = `team/t1/e1/a1/${GEN}.bin`;
    expect(resolveObjectRefKey(encodeObjectRef({ key }), context)).toBe(key);
  });

  it("throws BlobRefInvalidError for an undecodable ref (no fallback key)", () => {
    expect(() => resolveObjectRefKey(new Uint8Array(Buffer.from("raw-bytes")), context)).toThrow(
      BlobRefInvalidError,
    );
  });

  it("throws BlobRefInvalidError for another row's ref, without echoing it", () => {
    const key = `team/t1/e1/a2/${GEN}.bin`;
    let caught: unknown;
    try {
      resolveObjectRefKey(encodeObjectRef({ key }), context);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BlobRefInvalidError);
    expect((caught as Error).message).not.toContain(key);
  });
});

describe("parseObjectKey", () => {
  const TEAM = "11111111-1111-4111-8111-111111111111";
  const ENTRY = "22222222-2222-4222-8222-222222222222";
  const ATT = "33333333-3333-4333-8333-333333333333";
  const GEN = "0123456789abcdef0123456789abcdef";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<[string, AttachmentBlobPutContext]>([
    ["team, generation", { attachmentId: ATT, entryId: ENTRY, teamId: TEAM, generation: GEN }],
    ["personal, generation", { attachmentId: ATT, entryId: ENTRY, generation: GEN }],
  ])("inverts buildObjectKey (%s) and agrees with validateObjectRefKey", (_label, context) => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "tenant-a/attachments/");
    const key = buildObjectKey(context);
    const parsed = parseObjectKey(key);
    expect(parsed).toEqual({
      scope: context.teamId ? BLOB_OBJECT_SCOPE.TEAM : BLOB_OBJECT_SCOPE.PERSONAL,
      ...(context.teamId ? { teamId: TEAM } : {}),
      entryId: ENTRY,
      attachmentId: ATT,
      generation: GEN,
    });
    expect(parsed && validateObjectRefKey(key, parsed)).toBe(true);
  });

  it.each([
    ["team", `team/${TEAM}/${ENTRY}/${ATT}.bin`, { scope: "team", teamId: TEAM, entryId: ENTRY, attachmentId: ATT }],
    ["personal", `personal/${ENTRY}/${ATT}.bin`, { scope: "personal", entryId: ENTRY, attachmentId: ATT }],
  ])("parses the legacy %s form, which validateObjectRefKey also accepts", (_label, key, expected) => {
    const parsed = parseObjectKey(key);
    expect(parsed).toEqual(expected);
    expect(parsed && validateObjectRefKey(key, parsed)).toBe(true);
  });

  it("returns the attachment id lowercased", () => {
    expect(parseObjectKey(`personal/${ENTRY}/${ATT.toUpperCase()}/${GEN}.bin`)?.attachmentId).toBe(ATT);
  });

  it.each([
    ["a non-UUID attachment id", `personal/${ENTRY}/att-1/${GEN}.bin`],
    ["a non-UUID entry id", `personal/entry-1/${ATT}/${GEN}.bin`],
    ["a non-UUID team id", `team/team-1/${ENTRY}/${ATT}/${GEN}.bin`],
    ["an uppercase generation", `personal/${ENTRY}/${ATT}/${GEN.toUpperCase()}.bin`],
    ["a missing .bin suffix", `personal/${ENTRY}/${ATT}/${GEN}`],
    ["an extra segment", `personal/x/${ENTRY}/${ATT}/${GEN}.bin`],
    ["an unknown scope", `shared/${ENTRY}/${ATT}/${GEN}.bin`],
    ["the marker", ".passwd-sso-deployment"],
  ])("returns null for %s", (_label, key) => {
    expect(parseObjectKey(key)).toBeNull();
  });

  it("returns null for a key under another prefix (control: the same tail under the current prefix parses)", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "current");
    const tail = `personal/${ENTRY}/${ATT}/${GEN}.bin`;
    expect(parseObjectKey(`previous/${tail}`)).toBeNull();
    expect(parseObjectKey(tail)).toBeNull();
    expect(parseObjectKey(`current/${tail}`)).not.toBeNull();
  });

  it("returns null for the marker key under a prefix", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "current");
    expect(parseObjectKey(blobMarkerKey())).toBeNull();
  });
});

describe("blobMarkerKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has no leading slash when the prefix is empty", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "");
    expect(blobMarkerKey()).toBe(".passwd-sso-deployment");
  });

  it("sits under the prefix, normalised like buildObjectKey's", () => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", "tenant-a//");
    expect(blobMarkerKey()).toBe("tenant-a/.passwd-sso-deployment");
  });
});
