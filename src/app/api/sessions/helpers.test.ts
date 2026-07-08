import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { getSessionToken, getSessionTokenFromCookieStore } from "./helpers";

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
      headers: { Cookie: "__Host-authjs.session-token=host456" },
    });
    expect(getSessionToken(req)).toBe("host456");
  });

  it("reads __Secure- cookie when AUTH_URL is https AND basePath is set", () => {
    vi.stubEnv("AUTH_URL", "https://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/vault");
    const req = createRequest("GET", "https://localhost:3000/vault/api/sessions", {
      headers: { Cookie: "__Secure-authjs.session-token=sec456" },
    });
    expect(getSessionToken(req)).toBe("sec456");
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
      headers: { Cookie: "__Host-authjs.session-token=prod789" },
    });
    expect(getSessionToken(req)).toBe("prod789");
  });

  it("uses NEXTAUTH_URL when AUTH_URL is not set (→ __Host- at root)", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "https://myapp.com");
    const req = createRequest("GET", "https://myapp.com/api/sessions", {
      headers: { Cookie: "__Host-authjs.session-token=next123" },
    });
    expect(getSessionToken(req)).toBe("next123");
  });
});

describe("getSessionTokenFromCookieStore (server-component cookies() variant)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function storeWith(entries: Record<string, string>) {
    return {
      get: (name: string) =>
        name in entries ? { value: entries[name] } : undefined,
    };
  }

  it("resolves the __Secure- name on https + basePath (production shape)", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");

    const token = getSessionTokenFromCookieStore(
      storeWith({ "__Secure-authjs.session-token": "sec-1" }),
    );

    expect(token).toBe("sec-1");
  });

  it("resolves the plain name on http (dev shape)", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");

    const token = getSessionTokenFromCookieStore(
      storeWith({ "authjs.session-token": "dev-1" }),
    );

    expect(token).toBe("dev-1");
  });

  it("returns null when the deployment-shaped cookie is absent", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");

    // A dev-shaped cookie must NOT satisfy a production-shaped deployment.
    const token = getSessionTokenFromCookieStore(
      storeWith({ "authjs.session-token": "wrong-shape" }),
    );

    expect(token).toBeNull();
  });
});
