import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { canonicalHtu, htuMatches } from "./htu-canonical";

describe("canonicalHtu", () => {
  const originalAppUrl = process.env.APP_URL;
  const originalAuthUrl = process.env.AUTH_URL;

  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
  });

  afterEach(() => {
    process.env.APP_URL = originalAppUrl;
    process.env.AUTH_URL = originalAuthUrl;
  });

  it("origin-only APP_URL → no basePath", () => {
    process.env.APP_URL = "https://example.com";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://example.com/api/mobile/token"
    );
  });

  it("origin-only APP_URL with trailing slash → no basePath", () => {
    process.env.APP_URL = "https://example.com/";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://example.com/api/mobile/token"
    );
  });

  it("APP_URL with basePath → basePath preserved", () => {
    process.env.APP_URL = "https://www.jpng.jp/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://www.jpng.jp/passwd-sso/api/mobile/token"
    );
  });

  it("APP_URL with basePath and trailing slash → trailing slash stripped", () => {
    process.env.APP_URL = "https://www.jpng.jp/passwd-sso/";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://www.jpng.jp/passwd-sso/api/mobile/token"
    );
  });

  it("APP_URL with multi-segment basePath", () => {
    process.env.APP_URL = "https://example.com/apps/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token/refresh" })).toBe(
      "https://example.com/apps/passwd-sso/api/mobile/token/refresh"
    );
  });

  it("uppercase host is lowercased", () => {
    process.env.APP_URL = "https://EXAMPLE.com/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://example.com/passwd-sso/api/mobile/token"
    );
  });

  it("default ports stripped", () => {
    process.env.APP_URL = "https://example.com:443/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://example.com/passwd-sso/api/mobile/token"
    );
    process.env.APP_URL = "http://example.com:80";
    expect(canonicalHtu({ route: "/api/foo" })).toBe(
      "http://example.com/api/foo"
    );
  });

  it("non-default port preserved", () => {
    process.env.APP_URL = "https://example.com:8443/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://example.com:8443/passwd-sso/api/mobile/token"
    );
  });

  it("missing leading slash on route is normalized", () => {
    process.env.APP_URL = "https://example.com/passwd-sso";
    expect(canonicalHtu({ route: "api/mobile/token" })).toBe(
      "https://example.com/passwd-sso/api/mobile/token"
    );
  });

  it("falls back to AUTH_URL when APP_URL is unset", () => {
    process.env.AUTH_URL = "https://auth.example.com/passwd-sso";
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://auth.example.com/passwd-sso/api/mobile/token"
    );
  });

  it("throws when neither APP_URL nor AUTH_URL is set", () => {
    expect(() => canonicalHtu({ route: "/api/mobile/token" })).toThrow(
      /APP_URL/
    );
  });
});

describe("htuMatches", () => {
  it("matches when basePath is identical on both sides", () => {
    expect(
      htuMatches(
        "https://www.jpng.jp/passwd-sso/api/mobile/token",
        "https://www.jpng.jp/passwd-sso/api/mobile/token"
      )
    ).toBe(true);
  });

  it("differs when basePath differs", () => {
    expect(
      htuMatches(
        "https://www.jpng.jp/api/mobile/token",
        "https://www.jpng.jp/passwd-sso/api/mobile/token"
      )
    ).toBe(false);
  });

  it("rejects query strings on either side", () => {
    expect(
      htuMatches(
        "https://example.com/api/mobile/token?x=1",
        "https://example.com/api/mobile/token"
      )
    ).toBe(false);
  });
});
