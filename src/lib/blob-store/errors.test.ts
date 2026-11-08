import { describe, expect, it } from "vitest";
import { blobErrorStatus, createdUnlessExists, nullIfNotFound } from "@/lib/blob-store/errors";
import { BLOB_MARKER_CREATE } from "@/lib/blob-store/types";

describe("blobErrorStatus", () => {
  it.each([
    ["S3 $metadata.httpStatusCode", { $metadata: { httpStatusCode: 404 } }, 404],
    ["Azure statusCode", { statusCode: 409 }, 409],
    ["GCS numeric code", { code: 412 }, 412],
    ["a string code (a Node errno)", { code: "ECONNRESET" }, undefined],
    ["a non-object", "boom", undefined],
  ])("reads %s", (_label, err, want) => {
    expect(blobErrorStatus(err)).toBe(want);
  });
});

describe("nullIfNotFound", () => {
  it("returns the read's value", async () => {
    await expect(nullIfNotFound(async () => "body")).resolves.toBe("body");
  });

  it("answers null when the store reports 404", async () => {
    await expect(nullIfNotFound(() => Promise.reject({ statusCode: 404 }))).resolves.toBeNull();
  });

  it("rethrows any other error", async () => {
    const err = { statusCode: 403 };
    await expect(nullIfNotFound(() => Promise.reject(err))).rejects.toBe(err);
  });
});

describe("createdUnlessExists", () => {
  it("answers CREATED when the create resolves", async () => {
    await expect(createdUnlessExists(async () => undefined, [412])).resolves.toBe(BLOB_MARKER_CREATE.CREATED);
  });

  it.each([409, 412])("answers EXISTS for a listed status %i", async (status) => {
    await expect(createdUnlessExists(() => Promise.reject({ statusCode: status }), [409, 412])).resolves.toBe(
      BLOB_MARKER_CREATE.EXISTS,
    );
  });

  it("rethrows a status the backend does not list", async () => {
    const err = { statusCode: 409 };
    await expect(createdUnlessExists(() => Promise.reject(err), [412])).rejects.toBe(err);
  });

  it("rethrows an error with no status", async () => {
    const err = new Error("network");
    await expect(createdUnlessExists(() => Promise.reject(err), [412])).rejects.toBe(err);
  });
});
