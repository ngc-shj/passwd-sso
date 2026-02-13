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

