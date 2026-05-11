import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  normalizeForwardedHeaders,
  TAILSCALE_DETECTION_HEADERS,
} from "./forwarded-headers";

const [TS_INFO_HEADER, TS_LOGIN_HEADER] = TAILSCALE_DETECTION_HEADERS;
const TAILSCALE_HEADERS = {
  [TS_INFO_HEADER]: "https://tailscale.com/s/serve-headers",
  [TS_LOGIN_HEADER]: "user@example.com",
};

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: BodyInit | null } = {},
): NextRequest {
  return new NextRequest(url, { ...init, headers: new Headers(headers) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeForwardedHeaders — Tailscale-detection gating", () => {
  it("returns the original request when no Tailscale headers are present", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("triggers when only `Tailscale-Headers-Info` is present", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
      [TS_INFO_HEADER]: "https://tailscale.com/s/serve-headers",
    });
    expect(normalizeForwardedHeaders(req)).not.toBe(req);
  });

  it("triggers when only `Tailscale-User-Login` is present", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = makeRequest("https://localhost:3001/foo", {
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
      [TS_LOGIN_HEADER]: "user@example.com",
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
    vi.stubEnv("AUTH_URL", "not a url");
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when neither Host nor X-Forwarded-Host is present", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    // NextRequest does not auto-set Host for in-process construction.
    const req = makeRequest("https://localhost:3001/foo", TAILSCALE_HEADERS);
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when forwarded hostname does not match canonical", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = makeRequest("https://localhost:3001/foo", {
      ...TAILSCALE_HEADERS,
      host: "evil.example.org",
      "x-forwarded-host": "evil.example.org",
    });
    expect(normalizeForwardedHeaders(req)).toBe(req);
  });

  it("returns original when forwarded headers already match canonical", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
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
    vi.stubEnv("AUTH_URL", "https://app.example.com");
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
    vi.stubEnv("AUTH_URL", "https://app.example.com:8443");
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
    vi.stubEnv("AUTH_URL", "https://app.example.com");
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
    vi.stubEnv("AUTH_URL", "https://app.example.com");
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
    vi.stubEnv("APP_URL", "https://canonical.example.com");
    vi.stubEnv("AUTH_URL", "https://other.example.com");
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

describe("normalizeForwardedHeaders — basePath propagation", () => {
  // Guards the load-bearing `nextConfig.basePath` field in the new
  // NextRequest constructor — without it, next-intl emits redirects with
  // the locale prefix BEFORE basePath (`/ja/passwd-sso/...` instead of
  // `/passwd-sso/ja/...`), reintroducing the original bug.
  it("preserves nextConfig.basePath through reconstruction", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = new NextRequest(
      "https://localhost:3001/passwd-sso/dashboard",
      {
        headers: new Headers({
          ...TAILSCALE_HEADERS,
          host: "app.example.com",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-port": "3001",
          "x-forwarded-proto": "https",
        }),
        nextConfig: { basePath: "/passwd-sso" },
      } as ConstructorParameters<typeof NextRequest>[1],
    );
    expect(req.nextUrl.basePath).toBe("/passwd-sso");

    const out = normalizeForwardedHeaders(req);
    expect(out).not.toBe(req);
    expect(out.nextUrl.basePath).toBe("/passwd-sso");
  });

  it("does not invent a basePath when input has none", () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const req = makeRequest("https://localhost:3001/dashboard", {
      ...TAILSCALE_HEADERS,
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-port": "3001",
      "x-forwarded-proto": "https",
    });
    expect(req.nextUrl.basePath).toBe("");

    const out = normalizeForwardedHeaders(req);
    expect(out.nextUrl.basePath).toBe("");
  });
});
