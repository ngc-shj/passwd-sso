import { afterEach, describe, expect, it, vi } from "vitest";
import { gcsBlobStore } from "@/lib/blob-store/gcs-blob-store";
import { MAX_OBJECT_KEY_BYTES } from "@/lib/blob-store/object-ref";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gcsBlobStore.validateConfig", () => {
  it("throws when required env is missing", () => {
    vi.unstubAllEnvs();
    expect(() => gcsBlobStore.validateConfig()).toThrow(
      "GCS backend requires GCS_ATTACHMENTS_BUCKET",
    );
  });

  it("passes when required env is present", () => {
    vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "attachments");
    expect(() => gcsBlobStore.validateConfig()).not.toThrow();
  });
});

describe("gcsBlobStore lazy SDK loading", () => {
  it("loads sdk only when object operation runs", async () => {
    vi.resetModules();
    vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "attachments");

    const save = vi.fn().mockResolvedValue({});
    const file = vi.fn().mockReturnValue({
      save,
      download: vi.fn(),
      delete: vi.fn(),
    });
    const bucket = vi.fn().mockReturnValue({
      file,
    });
    const requireOptionalModule = vi.fn().mockReturnValue({
      Storage: class {
        bucket = bucket;
      },
    });

    vi.doMock("./runtime-module", () => ({
      requireOptionalModule,
    }));

    const { gcsBlobStore: store } = await import("./gcs-blob-store");

    store.validateConfig();
    expect(requireOptionalModule).not.toHaveBeenCalled();

    await store.putObject(new Uint8Array([1, 2, 3]), {
      attachmentId: "att-1",
      entryId: "entry-1",
      generation: "0123456789abcdef0123456789abcdef",
    });

    expect(requireOptionalModule).toHaveBeenCalledWith("@google-cloud/storage");
    expect(save).toHaveBeenCalledTimes(1);
    expect(file).toHaveBeenCalledWith("personal/entry-1/att-1/0123456789abcdef0123456789abcdef.bin");
  });

  it.each(["getObject", "deleteObject"] as const)(
    "%s fails closed on an undecodable or foreign ref without touching storage",
    async (op) => {
      vi.resetModules();
      vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "attachments");
      const requireOptionalModule = vi.fn();
      vi.doMock("./runtime-module", () => ({ requireOptionalModule }));
      const { gcsBlobStore: store } = await import("./gcs-blob-store");
      const { BlobRefInvalidError, encodeObjectRef } = await import("./object-ref");
      const context = { attachmentId: "att-1", entryId: "entry-1" };

      await expect(store[op](new Uint8Array(Buffer.from("raw")), context)).rejects.toBeInstanceOf(
        BlobRefInvalidError,
      );
      await expect(
        store[op](encodeObjectRef({ key: "personal/entry-1/att-2.bin" }), context),
      ).rejects.toBeInstanceOf(BlobRefInvalidError);
      expect(requireOptionalModule).not.toHaveBeenCalled();
    },
  );
});

describe("gcsBlobStore listing and marker", () => {
  // No @google-cloud/storage in this repo's dependencies, so the result is the
  // store's own narrow shape (getFiles({ autoPaginate: false }) -> [files,
  // nextQuery, apiResponse]); see the plan's VE1.
  type File = { name: string; metadata: { updated?: string } };

  async function loadStore(opts: {
    getFiles?: (query: unknown) => Promise<[File[], { pageToken?: string } | null, unknown]>;
    download?: () => Promise<[Buffer]>;
    save?: (data: Buffer, options?: unknown) => Promise<unknown>;
  }) {
    vi.resetModules();
    vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "attachments");
    vi.stubEnv("BLOB_OBJECT_PREFIX", "");
    const getFiles = vi.fn(opts.getFiles ?? (async () => [[], null, {}] as [File[], null, unknown]));
    const save = vi.fn(opts.save ?? (async () => ({})));
    const file = vi.fn((_key: string) => ({ save, download: opts.download ?? vi.fn(), delete: vi.fn() }));
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        Storage: class {
          bucket = vi.fn().mockReturnValue({ file, getFiles });
        },
      }),
    }));
    const { gcsBlobStore: store } = await import("./gcs-blob-store");
    return { store, getFiles, save, file };
  }

  it("returns an empty page and no cursor for an empty listing", async () => {
    const { store, getFiles } = await loadStore({});
    await expect(store.listObjects("p/", { pageSize: 10 })).resolves.toEqual({ objects: [] });
    expect(getFiles).toHaveBeenCalledWith({ prefix: "p/", autoPaginate: false, maxResults: 10 });
  });

  it("parses metadata.updated into a Date and returns the next page token", async () => {
    const { store, getFiles } = await loadStore({
      getFiles: async () => [
        [
          { name: "a", metadata: { updated: "2026-01-01T00:00:00.000Z" } },
          { name: "no-updated", metadata: {} },
        ],
        { pageToken: "tok-1" },
        {},
      ],
    });
    const page = await store.listObjects("", { pageSize: 2, cursor: "tok-0" });
    expect(page).toEqual({ objects: [{ key: "a", lastModified: new Date("2026-01-01T00:00:00.000Z") }], cursor: "tok-1" });
    expect(page.objects[0].lastModified).toBeInstanceOf(Date);
    expect(getFiles.mock.calls[0][0]).toMatchObject({ pageToken: "tok-0" });
  });

  it.each([
    ["an empty final token", { pageToken: "" }],
    ["no next query", null],
  ])("treats %s as the end of the listing", async (_label, nextQuery) => {
    const { store } = await loadStore({ getFiles: async () => [[], nextQuery, {}] });
    expect((await store.listObjects("", { pageSize: 5 })).cursor).toBeUndefined();
  });

  it("readMarker returns null on 404 and the body otherwise", async () => {
    const absent = await loadStore({
      download: async () => {
        throw Object.assign(new Error("No such object"), { name: "ApiError", code: 404 });
      },
    });
    await expect(absent.store.readMarker()).resolves.toBeNull();
    const present = await loadStore({ download: async () => [Buffer.from("dep-1")] });
    await expect(present.store.readMarker()).resolves.toBe("dep-1");
    expect(present.file).toHaveBeenCalledWith(".passwd-sso-deployment");
  });

  it("createMarker preconditions on generation 0 and reports created, then exists on 412", async () => {
    const created = await loadStore({});
    await expect(created.store.createMarker("dep-1")).resolves.toBe("created");
    expect(created.save.mock.calls[0][1]).toMatchObject({ preconditionOpts: { ifGenerationMatch: 0 } });

    const exists = await loadStore({
      save: async () => {
        throw Object.assign(new Error("precondition"), { name: "ApiError", code: 412 });
      },
    });
    await expect(exists.store.createMarker("dep-2")).resolves.toBe("exists");
  });
});

// The suffix buildObjectKey appends to BLOB_OBJECT_PREFIX + "/" for this context.
// MAX_OBJECT_KEY_BYTES is a plain constant, so the static import survives resetModules.
const KEY_TAIL = "personal/entry-1/att-1/0123456789abcdef0123456789abcdef.bin";

describe("gcsBlobStore.putObject and the ref size bound", () => {
  async function storeWithPrefixOfKeyLength(keyLength: number) {
    vi.resetModules();
    vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "attachments");
    vi.stubEnv("BLOB_OBJECT_PREFIX", "p".repeat(keyLength - KEY_TAIL.length - 1));
    const save = vi.fn().mockResolvedValue({});
    const file = vi.fn().mockReturnValue({ save });
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        Storage: class {
          bucket = vi.fn().mockReturnValue({ file });
        },
      }),
    }));
    const { gcsBlobStore: store } = await import("./gcs-blob-store");
    const put = () => store.putObject(new Uint8Array([1]), { attachmentId: "att-1", entryId: "entry-1", generation: "0123456789abcdef0123456789abcdef" });
    return { put, save };
  }

  it("uploads a maximal valid key (MAX_OBJECT_KEY_BYTES)", async () => {
    const { put, save } = await storeWithPrefixOfKeyLength(MAX_OBJECT_KEY_BYTES);
    const stored = await put();
    expect(JSON.parse(Buffer.from(stored).toString("utf8")).key).toHaveLength(MAX_OBJECT_KEY_BYTES);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("refuses a key whose ref is over the bound before uploading anything", async () => {
    const { put, save } = await storeWithPrefixOfKeyLength(MAX_OBJECT_KEY_BYTES + 1);
    await expect(put()).rejects.toThrow(/Blob object ref exceeds/);
    expect(save).not.toHaveBeenCalled();
  });
});
