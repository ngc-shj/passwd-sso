import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { normalizeForwardedHeaders } from "./forwarded-headers";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  delete process.env.APP_URL;
  delete process.env.AUTH_URL;
}

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: BodyInit | null } = {},
): NextRequest {
  return new NextRequest(url, { ...init, headers: new Headers(headers) });
}

const TAILSCALE_HEADERS = {
  "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
  "tailscale-user-login": "user@example.com",
};

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("normalizeForwardedHeaders — Tailscale-detection gating", () => {
  it("returns the original request when no Tailscale headers are present", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("triggers when only `Tailscale-Headers-Info` is present", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    });
    expect(normalizeForwardedHeaders(req)).not.toBe(req);
  });

  it("triggers when only `Tailscale-User-Login` is present", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
      "tailscale-user-login": "user@example.com",
    });
    expect(normalizeForwardedHeaders(req)).not.toBe(req);
  });
});

describe("normalizeForwardedHeaders — env / canonical guards", () => {
  it("returns original when neither APP_URL nor AUTH_URL is set", () => {
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when canonical URL is malformed", () => {
    process.env.AUTH_URL = "not a url";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when neither Host nor X-Forwarded-Host is present", () => {
    process.env.AUTH_URL = "https://app.example.com";
    // NextRequest does not auto-set Host for in-process construction.
    const req = makeRequest("https://localhost:3001/foo", TAILSCALE_HEADERS);
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when forwarded hostname does not match canonical", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "evil.example.org",
      "x-forwarded-host": "evil.example.org",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when forwarded headers already match canonical", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    });
    // No X-Forwarded-Port → canonical (default 443) → already coherent.
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });
});

describe("normalizeForwardedHeaders — Tailscale port-leak override", () => {
  it("overrides X-Forwarded-Port when Tailscale leaks the backend port", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/passwd-sso/dashboard?ext_connect=1", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
    });
    const out = normalizeForwardedHeaders(req);
    expect(out).not.toBe(req);
    // Default port → header is dropped (empty is a valid signal).
    expect(out.headers.has("x-forwarded-port")).toBe(false);
    expect(out.headers.get("x-forwarded-host")).toBe("app.example.com");
    expect(out.headers.get("x-forwarded-proto")).toBe("https");
    expect(out.headers.get("host")).toBe("app.example.com");
    // request.url is intentionally untouched (basePath inference depends on it).
    expect(out.url).toBe(req.url);
  });

  it("preserves X-Forwarded-Port when canonical AUTH_URL has an explicit port", () => {
    process.env.AUTH_URL = "https://app.example.com:8443";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
    });
    const out = normalizeForwardedHeaders(req);
    expect(out.headers.get("x-forwarded-port")).toBe("8443");
    expect(out.headers.get("x-forwarded-host")).toBe("app.example.com:8443");
    expect(out.headers.get("host")).toBe("app.example.com:8443");
  });

  it("preserves unrelated headers (cookie, custom) while overriding forwarded set", () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
      cookie: "session=abc",
      "x-custom": "kept",
    });
    const out = normalizeForwardedHeaders(req);
    expect(out.headers.get("cookie")).toBe("session=abc");
    expect(out.headers.get("x-custom")).toBe("kept");
  });

  it("preserves body for non-bodyless methods", async () => {
    process.env.AUTH_URL = "https://app.example.com";
    const req = makeRequest(
      "https://localhost:3001/api/foo",
      {
        ...TAILSCALE_HEADERS,
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-port": "3001",
        "content-type": "application/json",
      },
      { method: "POST", body: JSON.stringify({ ok: true }) },
    );
    const out = normalizeForwardedHeaders(req);
    expect(out.method).toBe("POST");
    expect(await out.json()).toEqual({ ok: true });
  });

  it("prefers APP_URL over AUTH_URL when both are set", () => {
    process.env.APP_URL = "https://canonical.example.com";
    process.env.AUTH_URL = "https://other.example.com";
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "canonical.example.com",
      "x-forwarded-host": "canonical.example.com",
      "x-forwarded-port": "3001",
    });
    const out = normalizeForwardedHeaders(req);
    expect(out.headers.get("x-forwarded-host")).toBe("canonical.example.com");
    expect(out.headers.has("x-forwarded-port")).toBe(false);
  });
});
