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

