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
