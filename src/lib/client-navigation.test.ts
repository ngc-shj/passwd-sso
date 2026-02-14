import { describe, expect, it } from "vitest";
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
      "/ja/dashboard/orgs",
      "https://example.com",
      "ja"
    );
    expect(result.isInternal).toBe(true);
    expect(result.internalPath).toBe("/dashboard/orgs");
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

