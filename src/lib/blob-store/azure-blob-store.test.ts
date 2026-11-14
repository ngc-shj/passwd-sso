import { afterEach, describe, expect, it, vi } from "vitest";
import { azureBlobStore } from "@/lib/blob-store/azure-blob-store";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("azureBlobStore.validateConfig", () => {
  it("throws when required env is missing", () => {
    vi.unstubAllEnvs();
    expect(() => azureBlobStore.validateConfig()).toThrow(
      "Azure backend requires AZURE_STORAGE_ACCOUNT and AZURE_BLOB_CONTAINER",
    );
  });

  it("passes when required env is present", () => {
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
    vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
    expect(() => azureBlobStore.validateConfig()).not.toThrow();
  });
});

describe("azureBlobStore lazy SDK loading", () => {
  it("loads sdk only when object operation runs", async () => {
    vi.resetModules();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
    vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true;");

    const uploadData = vi.fn().mockResolvedValue({});
    const getBlockBlobClient = vi.fn().mockReturnValue({
      uploadData,
      download: vi.fn(),
      deleteIfExists: vi.fn(),
    });
    const getContainerClient = vi.fn().mockReturnValue({
      getBlockBlobClient,
    });

    const requireOptionalModule = vi.fn().mockReturnValue({
      BlobServiceClient: {
        fromConnectionString: vi.fn().mockReturnValue({
          getContainerClient,
        }),
      },
    });

    vi.doMock("./runtime-module", () => ({
      requireOptionalModule,
    }));

    const { azureBlobStore: store } = await import("./azure-blob-store");

    store.validateConfig();
    expect(requireOptionalModule).not.toHaveBeenCalled();

    await store.putObject(new Uint8Array([1, 2, 3]), {
      attachmentId: "att-1",
      entryId: "entry-1",
      generation: "0123456789abcdef0123456789abcdef",
    });

    expect(requireOptionalModule).toHaveBeenCalledWith("@azure/storage-blob");
    expect(uploadData).toHaveBeenCalledTimes(1);
    expect(getBlockBlobClient).toHaveBeenCalledWith("personal/entry-1/att-1/0123456789abcdef0123456789abcdef.bin");
  });

  it.each(["getObject", "deleteObject"] as const)(
    "%s fails closed on an undecodable or foreign ref without touching storage",
    async (op) => {
      vi.resetModules();
      vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
      vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
      vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true;");
      const requireOptionalModule = vi.fn();
      vi.doMock("./runtime-module", () => ({ requireOptionalModule }));
      const { azureBlobStore: store } = await import("./azure-blob-store");
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

describe("azureBlobStore listing and marker", () => {
  // No @azure/storage-blob in this repo's dependencies, so the page shape is
  // the store's own narrow one (listBlobsFlat().byPage() -> { segment.blobItems,
  // continuationToken }); see the plan's VE1.
  type Page = {
    segment: { blobItems: { name: string; properties: { lastModified: Date } }[] };
    continuationToken?: string;
  };
  const T0 = new Date("2026-01-01T00:00:00Z");

  async function loadStore(opts: {
    pages?: Page[];
    download?: () => Promise<unknown>;
    uploadData?: (data: Buffer, options?: unknown) => Promise<unknown>;
    prefix?: string;
  }) {
    vi.resetModules();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
    vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true;");
    vi.stubEnv("BLOB_OBJECT_PREFIX", opts.prefix ?? "");
    const byPage = vi.fn((_settings: { continuationToken?: string; maxPageSize: number }) => {
      const pages = [...(opts.pages ?? [])];
      return { next: async () => (pages.length > 0 ? { done: false, value: pages.shift() } : { done: true, value: undefined }) };
    });
    const listBlobsFlat = vi.fn((_options: { prefix: string }) => ({ byPage }));
    const uploadData = vi.fn(opts.uploadData ?? (async () => ({})));
    const getBlockBlobClient = vi.fn((_key: string) => ({
      uploadData,
      download: opts.download ?? vi.fn(),
      deleteIfExists: vi.fn(),
    }));
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        BlobServiceClient: {
          fromConnectionString: vi.fn().mockReturnValue({
            getContainerClient: vi.fn().mockReturnValue({ getBlockBlobClient, listBlobsFlat }),
          }),
        },
      }),
    }));
    vi.doMock("./stream", () => ({ streamBodyToBuffer: async (b: Buffer) => b }));
    const { azureBlobStore: store } = await import("./azure-blob-store");
    return { store, byPage, listBlobsFlat, uploadData, getBlockBlobClient };
  }

  it("returns an empty page when the listing has no page", async () => {
    const { store } = await loadStore({ pages: [] });
    await expect(store.listObjects("p/", { pageSize: 10 })).resolves.toEqual({ objects: [] });
  });

  it("maps a page and passes the continuation token back", async () => {
    const { store, byPage, listBlobsFlat } = await loadStore({
      pages: [{ segment: { blobItems: [{ name: "a", properties: { lastModified: T0 } }] }, continuationToken: "tok-1" }],
    });
    const page = await store.listObjects("p/", { pageSize: 1, cursor: "tok-0" });
    expect(page).toEqual({ objects: [{ key: "a", lastModified: T0 }], cursor: "tok-1" });
    expect(listBlobsFlat).toHaveBeenCalledWith({ prefix: "p/" });
    expect(byPage).toHaveBeenCalledWith({ continuationToken: "tok-0", maxPageSize: 1 });
  });

  it.each([
    ["an empty final token", ""],
    ["an absent final token", undefined],
  ])("treats %s as the end of the listing", async (_label, token) => {
    const { store } = await loadStore({ pages: [{ segment: { blobItems: [] }, continuationToken: token }] });
    expect((await store.listObjects("", { pageSize: 5 })).cursor).toBeUndefined();
  });

  it("readMarker returns null on 404 and the body otherwise", async () => {
    const absent = await loadStore({
      download: async () => {
        throw Object.assign(new Error("BlobNotFound"), { name: "RestError", statusCode: 404 });
      },
    });
    await expect(absent.store.readMarker()).resolves.toBeNull();

    const present = await loadStore({ download: async () => ({ readableStreamBody: Buffer.from("dep-1") }), prefix: "t" });
    await expect(present.store.readMarker()).resolves.toBe("dep-1");
    expect(present.getBlockBlobClient).toHaveBeenCalledWith("t/.passwd-sso-deployment");
  });

  it("createMarker sends ifNoneMatch '*' and reports created", async () => {
    const { store, uploadData, getBlockBlobClient } = await loadStore({});
    await expect(store.createMarker("dep-1")).resolves.toBe("created");
    expect(getBlockBlobClient).toHaveBeenCalledWith(".passwd-sso-deployment");
    expect(uploadData.mock.calls[0][1]).toMatchObject({ conditions: { ifNoneMatch: "*" } });
  });

  it.each([409, 412])("createMarker on an existing marker (%s) reports exists", async (statusCode) => {
    const { store } = await loadStore({
      uploadData: async () => {
        throw Object.assign(new Error("BlobAlreadyExists"), { name: "RestError", statusCode });
      },
    });
    await expect(store.createMarker("dep-2")).resolves.toBe("exists");
  });
});

// The suffix buildObjectKey appends to BLOB_OBJECT_PREFIX + "/" for this context.
const KEY_TAIL = "personal/entry-1/att-1/0123456789abcdef0123456789abcdef.bin";

describe("azureBlobStore.putObject and the ref size bound", () => {
  async function storeWithPrefixOfKeyLength(keyLength: number) {
    vi.resetModules();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
    vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true;");
    vi.stubEnv("BLOB_OBJECT_PREFIX", "p".repeat(keyLength - KEY_TAIL.length - 1));
    const uploadData = vi.fn().mockResolvedValue({});
    const getBlockBlobClient = vi.fn().mockReturnValue({ uploadData });
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        BlobServiceClient: {
          fromConnectionString: vi.fn().mockReturnValue({ getContainerClient: vi.fn().mockReturnValue({ getBlockBlobClient }) }),
        },
      }),
    }));
    const { azureBlobStore: store } = await import("./azure-blob-store");
    const put = () => store.putObject(new Uint8Array([1]), { attachmentId: "att-1", entryId: "entry-1", generation: "0123456789abcdef0123456789abcdef" });
    return { put, uploadData };
  }

  it("uploads a maximal valid key (1024 bytes)", async () => {
    const { put, uploadData } = await storeWithPrefixOfKeyLength(1024);
    const stored = await put();
    expect(JSON.parse(Buffer.from(stored).toString("utf8")).key).toHaveLength(1024);
    expect(uploadData).toHaveBeenCalledTimes(1);
  });

  it("refuses a key whose ref is over the bound before uploading anything", async () => {
    const { put, uploadData } = await storeWithPrefixOfKeyLength(1025);
    await expect(put()).rejects.toThrow(/Blob object ref exceeds/);
    expect(uploadData).not.toHaveBeenCalled();
  });
});
