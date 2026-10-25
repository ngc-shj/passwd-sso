import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { getSessionToken, getSessionTokenFromCookieHeader } from "./helpers";

describe("getSessionToken", () => {
  beforeEach(() => {
    // Each test stubs the env vars it depends on; explicitly clear
    // NEXT_PUBLIC_BASE_PATH so leakage from the surrounding process env
    // does not flip the __Host- ↔ __Secure- branch unexpectedly.
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads plain authjs.session-token when AUTH_URL is http", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const req = createRequest("GET", "http://localhost:3000/api/sessions", {
      headers: { Cookie: "authjs.session-token=abc123" },
    });
    expect(getSessionToken(req)).toBe("abc123");
  });

  it("reads __Host- cookie when AUTH_URL is https AND basePath is empty", () => {
    vi.stubEnv("AUTH_URL", "https://localhost:3000");
    const req = createRequest("GET", "https://localhost:3000/api/sessions", {
      headers: { Cookie: "__Host-authjs.session-token=4056" },
    });
    expect(getSessionToken(req)).toBe("4056");
  });

  it("reads __Secure- cookie when AUTH_URL is https AND basePath is set", () => {
    vi.stubEnv("AUTH_URL", "https://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/vault");
    const req = createRequest("GET", "https://localhost:3000/vault/api/sessions", {
      headers: { Cookie: "__Secure-authjs.session-token=5ec456" },
    });
    expect(getSessionToken(req)).toBe("5ec456");
  });

  it("returns null when the matching cookie is absent", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const req = createRequest("GET", "http://localhost:3000/api/sessions");
    expect(getSessionToken(req)).toBeNull();
  });

  it("falls back to production check when AUTH_URL is invalid (→ __Host- at root)", () => {
    vi.stubEnv("AUTH_URL", "not-a-url");
    vi.stubEnv("NODE_ENV", "production");
    const req = createRequest("GET", "https://example.com/api/sessions", {
      headers: { Cookie: "__Host-authjs.session-token=bad789" },
    });
    expect(getSessionToken(req)).toBe("bad789");
  });

  it("uses NEXTAUTH_URL when AUTH_URL is not set (→ __Host- at root)", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "https://myapp.com");
    const req = createRequest("GET", "https://myapp.com/api/sessions", {
      headers: { Cookie: "__Host-authjs.session-token=e123" },
    });
    expect(getSessionToken(req)).toBe("e123");
  });

  // RequestCookies keeps the LAST duplicate, Auth.js the FIRST: reading
  // req.cookies here let step-up evaluate a fresh session B while auth()
  // authenticated a stale session A. The first is the one.
  it("returns the first of a duplicated session cookie, as auth() does", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const req = createRequest("GET", "http://localhost:3000/api/sessions", {
      headers: { Cookie: "authjs.session-token=aaaa; authjs.session-token=bbbb" },
    });
    expect(getSessionToken(req)).toBe("aaaa");
  });
});

describe("getSessionTokenFromCookieHeader (server-component headers() variant)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the __Secure- name on https + basePath (production shape)", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    expect(getSessionTokenFromCookieHeader("__Secure-authjs.session-token=5ec-1")).toBe("5ec-1");
  });

  it("resolves the plain name on http (dev shape)", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(getSessionTokenFromCookieHeader("authjs.session-token=de0-1")).toBe("de0-1");
  });

  it("resolves the __Host- name on https + empty basePath", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    expect(getSessionTokenFromCookieHeader("__Host-authjs.session-token=4057-1")).toBe("4057-1");
  });

  it("returns null when the deployment-shaped cookie is absent", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    // A dev-shaped cookie must NOT satisfy a production-shaped deployment.
    expect(getSessionTokenFromCookieHeader("authjs.session-token=abcd")).toBeNull();
  });

  it("returns null when there is no Cookie header", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(getSessionTokenFromCookieHeader(null)).toBeNull();
  });

  it("returns null for an ambiguous header (chunk-named cookie)", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(
      getSessionTokenFromCookieHeader("authjs.session-token=aaaa; authjs.session-token.0=bbbb"),
    ).toBeNull();
  });
});
