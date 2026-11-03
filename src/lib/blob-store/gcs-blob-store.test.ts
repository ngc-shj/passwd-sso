import { afterEach, describe, expect, it, vi } from "vitest";
import { gcsBlobStore } from "@/lib/blob-store/gcs-blob-store";

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
