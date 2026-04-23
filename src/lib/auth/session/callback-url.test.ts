import { describe, it, expect } from "vitest";
import { resolveCallbackUrl, callbackUrlToHref } from "./callback-url";

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
