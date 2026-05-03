import { describe, it, expect, vi, beforeEach } from "vitest";
import { canonicalHtu, htuMatches } from "./htu-canonical";

beforeEach(() => {
  // Default: APP_URL set. Specific tests override via vi.stubEnv.
  vi.stubEnv("APP_URL", "https://example.com");
  vi.stubEnv("AUTH_URL", "");
});

describe("canonicalHtu", () => {
  it("returns scheme + host + path with no trailing slash injection", () => {
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("lowercases the scheme", () => {
    vi.stubEnv("APP_URL", "HTTPS://EXAMPLE.COM");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("lowercases the host", () => {
    vi.stubEnv("APP_URL", "https://Example.COM");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("strips default https port 443", () => {
    vi.stubEnv("APP_URL", "https://example.com:443");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("strips default http port 80", () => {
    vi.stubEnv("APP_URL", "http://example.com:80");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("http://example.com/api/foo");
  });

  it("preserves non-default port", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("http://localhost:3000/api/foo");
  });

  it("preserves explicit non-default https port", () => {
    vi.stubEnv("APP_URL", "https://example.com:8443");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com:8443/api/foo");
  });

  it("normalizes a route missing leading slash", () => {
    expect(canonicalHtu({ route: "api/foo" })).toBe("https://example.com/api/foo");
  });

  it("falls back to AUTH_URL when APP_URL unset", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    expect(canonicalHtu({ route: "/x" })).toBe("https://auth.example.com/x");
  });

  it("throws when neither APP_URL nor AUTH_URL is set", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    expect(() => canonicalHtu({ route: "/api/foo" })).toThrow(/APP_URL/);
  });
});

describe("htuMatches", () => {
  it("returns true when both inputs are identical canonical URLs", () => {
    expect(htuMatches("https://a.test/x", "https://a.test/x")).toBe(true);
  });

  it("scheme comparison is case-insensitive", () => {
    expect(htuMatches("HTTPS://a.test/x", "https://a.test/x")).toBe(true);
  });

  it("host comparison is case-insensitive", () => {
    expect(htuMatches("https://A.test/x", "https://a.test/x")).toBe(true);
  });

  it("path comparison is case-sensitive", () => {
    expect(htuMatches("https://a.test/X", "https://a.test/x")).toBe(false);
  });

  it("treats default port and elided port as equal (https:443)", () => {
    expect(htuMatches("https://a.test:443/x", "https://a.test/x")).toBe(true);
  });

  it("treats default http port 80 and elided port as equal", () => {
    expect(htuMatches("http://a.test:80/x", "http://a.test/x")).toBe(true);
  });

  it("rejects mismatched non-default ports", () => {
    expect(htuMatches("https://a.test:8443/x", "https://a.test/x")).toBe(false);
  });

  it("rejects mismatched scheme even when host+path match", () => {
    expect(htuMatches("http://a.test/x", "https://a.test/x")).toBe(false);
  });

  it("rejects mismatched host", () => {
    expect(htuMatches("https://b.test/x", "https://a.test/x")).toBe(false);
  });

  it("rejects when provided contains a query string", () => {
    expect(htuMatches("https://a.test/x?y=1", "https://a.test/x")).toBe(false);
  });

  it("rejects when provided contains a fragment", () => {
    expect(htuMatches("https://a.test/x#frag", "https://a.test/x")).toBe(false);
  });

  it("returns false on malformed input rather than throwing", () => {
    expect(htuMatches("not a url", "https://a.test/x")).toBe(false);
    expect(htuMatches("https://a.test/x", "not a url")).toBe(false);
  });
});
