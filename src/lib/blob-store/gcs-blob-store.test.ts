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
    });

    expect(requireOptionalModule).toHaveBeenCalledWith("@google-cloud/storage");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
