import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ALL_KNOWN_SESSION_COOKIE_NAMES,
  getSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "./cookie-name";

describe("getSessionCookieName", () => {
  it("returns the plain name when useSecureCookies is false", () => {
    expect(
      getSessionCookieName({ useSecureCookies: false, basePath: undefined }),
    ).toBe("authjs.session-token");
    expect(
      getSessionCookieName({ useSecureCookies: false, basePath: "/vault" }),
    ).toBe("authjs.session-token");
  });

  it("returns __Host- when useSecureCookies is true AND basePath is undefined or empty", () => {
    expect(
      getSessionCookieName({ useSecureCookies: true, basePath: undefined }),
    ).toBe("__Host-authjs.session-token");
    expect(
      getSessionCookieName({ useSecureCookies: true, basePath: "" }),
    ).toBe("__Host-authjs.session-token");
  });

  it("returns __Secure- when useSecureCookies is true AND basePath is set", () => {
    expect(
      getSessionCookieName({ useSecureCookies: true, basePath: "/vault" }),
    ).toBe("__Secure-authjs.session-token");
    expect(
      getSessionCookieName({ useSecureCookies: true, basePath: "/p" }),
    ).toBe("__Secure-authjs.session-token");
  });

  it("covers the full (useSecureCookies × basePath) truth table", () => {
    // 2 × 2 matrix — checks that one quadrant flip does not bleed
    const cases = [
      { useSecureCookies: false, basePath: undefined, expected: "authjs.session-token" },
      { useSecureCookies: false, basePath: "/vault", expected: "authjs.session-token" },
      { useSecureCookies: true, basePath: undefined, expected: "__Host-authjs.session-token" },
      { useSecureCookies: true, basePath: "/vault", expected: "__Secure-authjs.session-token" },
    ];
    for (const c of cases) {
      expect(
        getSessionCookieName({
          useSecureCookies: c.useSecureCookies,
          basePath: c.basePath,
        }),
      ).toBe(c.expected);
    }
  });
});

describe("ALL_KNOWN_SESSION_COOKIE_NAMES", () => {
  it("includes the three current-issue shapes", () => {
    expect(ALL_KNOWN_SESSION_COOKIE_NAMES).toContain("__Host-authjs.session-token");
    expect(ALL_KNOWN_SESSION_COOKIE_NAMES).toContain("__Secure-authjs.session-token");
    expect(ALL_KNOWN_SESSION_COOKIE_NAMES).toContain("authjs.session-token");
  });

  it("includes legacy next-auth.* names for logout cleanup", () => {
    expect(ALL_KNOWN_SESSION_COOKIE_NAMES).toContain("__Secure-next-auth.session-token");
    expect(ALL_KNOWN_SESSION_COOKIE_NAMES).toContain("next-auth.session-token");
  });

  it("lists the more-specific prefixes first so an extractor that returns on first match yields the most-secure name", () => {
    // Defense-in-depth: if a request somehow carries both __Host- and a
    // legacy plain cookie, prefer the __Host- value.
    const hostIdx = ALL_KNOWN_SESSION_COOKIE_NAMES.indexOf("__Host-authjs.session-token");
    const secureIdx = ALL_KNOWN_SESSION_COOKIE_NAMES.indexOf("__Secure-authjs.session-token");
    const plainIdx = ALL_KNOWN_SESSION_COOKIE_NAMES.indexOf("authjs.session-token");
    expect(hostIdx).toBeLessThan(secureIdx);
    expect(secureIdx).toBeLessThan(plainIdx);
  });
});

describe("isSecureCookieFromAuthUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when AUTH_URL is https", () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    expect(isSecureCookieFromAuthUrl()).toBe(true);
  });

  it("returns false when AUTH_URL is http", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(isSecureCookieFromAuthUrl()).toBe(false);
  });

  it("falls back to NODE_ENV=production when AUTH_URL is missing", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isSecureCookieFromAuthUrl()).toBe(true);
  });

  it("falls back to false when AUTH_URL is missing and NODE_ENV is not production", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isSecureCookieFromAuthUrl()).toBe(false);
  });

  it("falls back to NODE_ENV when AUTH_URL is unparseable", () => {
    vi.stubEnv("AUTH_URL", "not a url");
    vi.stubEnv("NODE_ENV", "production");
    expect(isSecureCookieFromAuthUrl()).toBe(true);
  });

  it("prefers AUTH_URL over NEXTAUTH_URL when both are set", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXTAUTH_URL", "https://example.com");
    expect(isSecureCookieFromAuthUrl()).toBe(false);
  });
});
