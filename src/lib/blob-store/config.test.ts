import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { BLOB_STORAGE } from "@/lib/blob-store/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadCloudBlobConfig", () => {
  it("loads s3 config", () => {
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "bucket");
    expect(loadCloudBlobConfig(BLOB_STORAGE.S3)).toEqual({
      backend: BLOB_STORAGE.S3,
      region: "ap-northeast-1",
      bucket: "bucket",
    });
  });

  it("loads azure config", () => {
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "acct");
    vi.stubEnv("AZURE_BLOB_CONTAINER", "attachments");
    expect(loadCloudBlobConfig(BLOB_STORAGE.AZURE)).toEqual({
      backend: BLOB_STORAGE.AZURE,
      account: "acct",
      container: "attachments",
    });
  });

  it("loads gcs config", () => {
    vi.stubEnv("GCS_ATTACHMENTS_BUCKET", "bucket");
    expect(loadCloudBlobConfig(BLOB_STORAGE.GCS)).toEqual({
      backend: BLOB_STORAGE.GCS,
      bucket: "bucket",
    });
  });

  it("throws on missing cloud config", () => {
    expect(() => loadCloudBlobConfig(BLOB_STORAGE.S3)).toThrow(
      "S3 backend requires AWS_REGION and S3_ATTACHMENTS_BUCKET",
    );
  });

  it("throws for db backend", () => {
    expect(() => loadCloudBlobConfig(BLOB_STORAGE.DB)).toThrow(
      "Cloud blob config requested for non-cloud backend",
    );
  });
});

