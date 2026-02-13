import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBlobBackend", () => {
  it("defaults to db when env is missing", async () => {
    vi.unstubAllEnvs();
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe("db");
  });

  it("accepts explicit db backend", async () => {
    vi.stubEnv("BLOB_BACKEND", "db");
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe("db");
  });

  it("falls back to db for unknown backend", async () => {
    vi.stubEnv("BLOB_BACKEND", "something-else");
    const mod = await import("./index");
    expect(mod.resolveBlobBackend()).toBe("db");
  });
});

describe("getAttachmentBlobStore", () => {
  it("returns db blob store for all currently supported runtime backends", async () => {
    vi.stubEnv("BLOB_BACKEND", "s3");
    const mod = await import("./index");
    const store = mod.getAttachmentBlobStore();
    expect(store.backend).toBe("db");
  });
});

