import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { getSessionToken } from "./helpers";

describe("getSessionToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads non-secure cookie when AUTH_URL is http", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const req = createRequest("GET", "http://localhost:3000/api/sessions", {
      headers: { Cookie: "authjs.session-token=abc123" },
    });
    expect(getSessionToken(req)).toBe("abc123");
  });

  it("reads __Secure- cookie when AUTH_URL is https", () => {
    vi.stubEnv("AUTH_URL", "https://localhost:3000");
    const req = createRequest("GET", "https://localhost:3000/api/sessions", {
      headers: { Cookie: "__Secure-authjs.session-token=sec456" },
    });
    expect(getSessionToken(req)).toBe("sec456");
  });

  it("returns null when cookie is absent", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const req = createRequest("GET", "http://localhost:3000/api/sessions");
    expect(getSessionToken(req)).toBeNull();
  });

  it("falls back to production check when AUTH_URL is invalid", () => {
    vi.stubEnv("AUTH_URL", "not-a-url");
    vi.stubEnv("NODE_ENV", "production");
    const req = createRequest("GET", "https://example.com/api/sessions", {
      headers: { Cookie: "__Secure-authjs.session-token=prod789" },
    });
    expect(getSessionToken(req)).toBe("prod789");
  });

  it("uses NEXTAUTH_URL when AUTH_URL is not set", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "https://myapp.com");
    const req = createRequest("GET", "https://myapp.com/api/sessions", {
      headers: { Cookie: "__Secure-authjs.session-token=next123" },
    });
    expect(getSessionToken(req)).toBe("next123");
  });
});
