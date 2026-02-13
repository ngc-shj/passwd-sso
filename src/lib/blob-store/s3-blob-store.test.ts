import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOB_STORAGE } from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { s3BlobStore } from "@/lib/blob-store/s3-blob-store";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("s3BlobStore.validateConfig", () => {
  it("throws when required env is missing", () => {
    vi.unstubAllEnvs();
    expect(() => s3BlobStore.validateConfig()).toThrow(
      "S3 backend requires AWS_REGION and S3_ATTACHMENTS_BUCKET",
    );
  });

  it("passes when required env is present", () => {
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");
    expect(() => s3BlobStore.validateConfig()).not.toThrow();
  });
});

describe("s3BlobStore lazy SDK loading", () => {
  it("loads sdk only when object operation runs", async () => {
    vi.resetModules();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");

    const send = vi.fn().mockResolvedValue({});
    const requireOptionalModule = vi.fn().mockReturnValue({
      S3Client: class {
        send = send;
      },
      PutObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
      GetObjectCommand: class {},
      DeleteObjectCommand: class {},
    });

    vi.doMock("./runtime-module", () => ({
      requireOptionalModule,
    }));

    const { s3BlobStore: store } = await import("./s3-blob-store");

    store.validateConfig();
    expect(requireOptionalModule).not.toHaveBeenCalled();

    await store.putObject(new Uint8Array([1, 2, 3]), {
      attachmentId: "att-1",
      entryId: "entry-1",
    });

    expect(loadCloudBlobConfig(BLOB_STORAGE.S3).bucket).toBe("attachments-bucket");
    expect(requireOptionalModule).toHaveBeenCalledWith("@aws-sdk/client-s3");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
