import { describe, it, expect } from "vitest";
import { resolveCallbackUrl, callbackUrlToHref, isApiCallbackUrl } from "./callback-url";

const ORIGIN = "https://example.com";
const DEFAULT = "/dashboard";

describe("resolveCallbackUrl", () => {
  it("returns default for null", () => {
    expect(resolveCallbackUrl(null, ORIGIN)).toBe(DEFAULT);
  });

  it("returns default for empty string", () => {
    expect(resolveCallbackUrl("", ORIGIN)).toBe(DEFAULT);
  });

  it("passes through relative path with query", () => {
    expect(resolveCallbackUrl("/dashboard?ext_connect=1", ORIGIN)).toBe(
      "/dashboard?ext_connect=1",
    );
  });

  it("passes through locale-prefixed relative path", () => {
    expect(resolveCallbackUrl("/ja/dashboard?ext_connect=1", ORIGIN)).toBe(
      "/ja/dashboard?ext_connect=1",
    );
  });

  it("strips fragment from relative path", () => {
    expect(resolveCallbackUrl("/dashboard#section", ORIGIN)).toBe(
      "/dashboard",
    );
  });

  it("extracts pathname+search from same-origin absolute URL", () => {
    expect(
      resolveCallbackUrl(
        "https://example.com/dashboard?ext_connect=1",
        ORIGIN,
      ),
    ).toBe("/dashboard?ext_connect=1");
  });

  it("rejects cross-origin absolute URL", () => {
    expect(resolveCallbackUrl("https://evil.com/phish", ORIGIN)).toBe(DEFAULT);
  });

  it("rejects protocol-relative URL (//)", () => {
    expect(resolveCallbackUrl("//evil.com/phish", ORIGIN)).toBe(DEFAULT);
  });

  it("rejects backslash variant (/\\)", () => {
    expect(resolveCallbackUrl("/\\evil.com", ORIGIN)).toBe(DEFAULT);
  });

  it("rejects javascript: URI", () => {
    expect(resolveCallbackUrl("javascript:alert(1)", ORIGIN)).toBe(DEFAULT);
  });

  it("rejects data: URI", () => {
    expect(resolveCallbackUrl("data:text/html,<h1>hi</h1>", ORIGIN)).toBe(
      DEFAULT,
    );
  });

  it("rejects bare word without leading slash", () => {
    expect(resolveCallbackUrl("not-a-url", ORIGIN)).toBe(DEFAULT);
  });

  it("rejects absolute URL when origin is empty (server fallback)", () => {
    expect(
      resolveCallbackUrl("https://example.com/dashboard", ""),
    ).toBe(DEFAULT);
  });

  it("passes through relative path when origin is empty", () => {
    expect(resolveCallbackUrl("/dashboard?ext_connect=1", "")).toBe(
      "/dashboard?ext_connect=1",
    );
  });

  it("normalizes path traversal in relative URL", () => {
    expect(resolveCallbackUrl("/./dashboard", ORIGIN)).toBe("/dashboard");
  });
});

describe("callbackUrlToHref", () => {
  it("strips basePath and locale prefix", () => {
    // BASE_PATH is "" in test env (mocked by url-helpers)
    // so only locale stripping applies
    expect(callbackUrlToHref("/ja/dashboard?ext_connect=1")).toBe(
      "/dashboard?ext_connect=1",
    );
  });

  it("returns path unchanged when no locale prefix", () => {
    expect(callbackUrlToHref("/dashboard")).toBe("/dashboard");
  });

  it("returns / for root path", () => {
    expect(callbackUrlToHref("/")).toBe("/");
  });
});

describe("isApiCallbackUrl", () => {
  it("returns true for the iOS mobile authorize API callback", () => {
    expect(isApiCallbackUrl("/api/mobile/authorize?client_kind=ios&state=x")).toBe(true);
  });

  it("returns true for a locale-prefixed API callback (locale stripped first)", () => {
    // The proxy may produce a locale-prefixed callbackUrl; callbackUrlToHref
    // strips the locale before the /api/ check.
    expect(isApiCallbackUrl("/ja/api/mobile/authorize")).toBe(true);
  });

  it("returns false for a normal dashboard callback", () => {
    expect(isApiCallbackUrl("/dashboard?ext_connect=1")).toBe(false);
  });

  it("returns false for a locale-prefixed dashboard callback", () => {
    expect(isApiCallbackUrl("/ja/dashboard")).toBe(false);
  });
});
