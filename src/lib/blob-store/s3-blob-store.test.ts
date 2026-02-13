import { afterEach, describe, expect, it, vi } from "vitest";
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

