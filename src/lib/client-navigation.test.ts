import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNavigationTarget } from "@/lib/client-navigation";

describe("resolveNavigationTarget", () => {
  it("resolves internal path for same-origin urls", () => {
    const result = resolveNavigationTarget(
      "https://example.com/ja/dashboard/watchtower?x=1#top",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/watchtower?x=1#top");
  });

  it("treats relative href as internal", () => {
    const result = resolveNavigationTarget(
      "/ja/dashboard/teams",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/teams");
  });

  it("keeps external href for cross-origin urls", () => {
    const result = resolveNavigationTarget(
      "https://other.example.com/docs",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(false);
    expect(result.externalHref).toBe("https://other.example.com/docs");
  });
});

describe("resolveNavigationTarget with basePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips basePath + locale from internal URL", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const result = resolveNavigationTarget(
      "https://example.com/passwd-sso/ja/dashboard/watchtower",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/watchtower");
  });

  it("strips basePath from relative path with locale", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const result = resolveNavigationTarget(
      "/passwd-sso/ja/dashboard/teams",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/teams");
  });

  it("strips basePath + locale and preserves query+hash", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const result = resolveNavigationTarget(
      "https://example.com/passwd-sso/ja/dashboard/watchtower?x=1#top",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/watchtower?x=1#top");
  });

  it("still works without basePath (regression check)", () => {
    // No vi.stubEnv — NEXT_PUBLIC_BASE_PATH is unset
    const result = resolveNavigationTarget(
      "/ja/dashboard/teams",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/teams");
  });
});

