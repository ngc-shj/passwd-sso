// Default vitest environment is "node" — window is undefined
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("fetchApi server-side guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when called outside browser (no basePath)", async () => {
    const { fetchApi } = await import("@/lib/url-helpers");
    expect(() => fetchApi("/api/test")).toThrow("fetchApi is client-only");
  });

  it("throws when called outside browser (with basePath)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { fetchApi } = await import("@/lib/url-helpers");
    expect(() => fetchApi("/api/test")).toThrow("fetchApi is client-only");
  });
});
