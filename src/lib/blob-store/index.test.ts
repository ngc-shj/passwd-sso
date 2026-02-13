import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBlobBackend", () => {
  it("defaults to db when env is missing", async () => {
    vi.unstubAllEnvs();
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe(mod.BLOB_STORAGE.DB);
  });

  it("accepts explicit db backend", async () => {
    vi.stubEnv("BLOB_BACKEND", "db");
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe(mod.BLOB_STORAGE.DB);
  });

  it("falls back to db for unknown backend", async () => {
    vi.stubEnv("BLOB_BACKEND", "something-else");
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe(mod.BLOB_STORAGE.DB);
  });
});

describe("getAttachmentBlobStore", () => {
  it("returns s3 blob store when backend is s3", async () => {
    vi.stubEnv("BLOB_BACKEND", "s3");
    const mod = await import("./index");
    const store = mod.getAttachmentBlobStore();
    expect(store.backend).toBe(mod.BLOB_STORAGE.S3);
  });

  it("returns azure blob store when backend is azure", async () => {
    vi.stubEnv("BLOB_BACKEND", "azure");
    const mod = await import("./index");
    const store = mod.getAttachmentBlobStore();
    expect(store.backend).toBe(mod.BLOB_STORAGE.AZURE);
  });

  it("returns gcs blob store when backend is gcs", async () => {
    vi.stubEnv("BLOB_BACKEND", "gcs");
    const mod = await import("./index");
    const store = mod.getAttachmentBlobStore();
    expect(store.backend).toBe(mod.BLOB_STORAGE.GCS);
  });
});
