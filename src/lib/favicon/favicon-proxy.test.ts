import { describe, it, expect } from "vitest";
import {
  isAllowedFaviconMime,
  normalizeFaviconHost,
  buildFaviconProviderUrl,
} from "./favicon-proxy";

describe("isAllowedFaviconMime", () => {
  it("accepts inert raster/icon image types", () => {
    for (const ct of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/bmp",
      "image/avif",
    ]) {
      expect(isAllowedFaviconMime(ct)).toBe(true);
    }
  });

  it("rejects image/svg+xml — SVG is active content", () => {
    expect(isAllowedFaviconMime("image/svg+xml")).toBe(false);
    expect(isAllowedFaviconMime("image/svg+xml; charset=utf-8")).toBe(false);
  });

  it("rejects non-image and other active types", () => {
    for (const ct of ["text/html", "application/xml", "text/xml", "image/", "", null]) {
      expect(isAllowedFaviconMime(ct)).toBe(false);
    }
  });

  it("matches the bare type case-insensitively, ignoring parameters", () => {
    expect(isAllowedFaviconMime("IMAGE/PNG")).toBe(true);
    expect(isAllowedFaviconMime("image/png; charset=binary")).toBe(true);
    expect(isAllowedFaviconMime("  image/x-icon  ")).toBe(true);
  });
});

describe("normalizeFaviconHost", () => {
  it("lowercases and strips a leading www.", () => {
    expect(normalizeFaviconHost("WWW.GitHub.com")).toBe("github.com");
  });

  it("returns null for special chars that could smuggle into the upstream url= param", () => {
    for (const h of [
      "github.com&size=16",
      "github.com/path",
      "github.com:8080",
      "github.com#x",
      "github.com?q=1",
      "a%2eb",
      "has space",
      "evil@host",
    ]) {
      expect(normalizeFaviconHost(h)).toBeNull();
    }
  });

  it("returns null for IP literals (v4 and v6)", () => {
    expect(normalizeFaviconHost("169.254.169.254")).toBeNull();
    expect(normalizeFaviconHost("127.0.0.1")).toBeNull();
    expect(normalizeFaviconHost("::1")).toBeNull();
  });

  it("returns null for empty and over-length hosts", () => {
    expect(normalizeFaviconHost("")).toBeNull();
    expect(normalizeFaviconHost("a".repeat(254))).toBeNull();
  });
});

describe("buildFaviconProviderUrl", () => {
  it("targets t1.gstatic.com with the host only as a url= query value", () => {
    const url = buildFaviconProviderUrl("github.com", 64);
    expect(new URL(url).hostname).toBe("t1.gstatic.com");
    expect(url).toContain("size=64");
    expect(url).toContain("url=https://github.com");
  });
});
