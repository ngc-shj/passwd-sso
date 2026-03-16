import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockCheckAccessWithAudit, mockResolveUserTenantId } = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockResolveUserTenantId: vi.fn().mockResolvedValue(null),
}));

vi.mock("next-intl/middleware", async () => {
  const { NextResponse: NR } = await import("next/server");
  return { default: () => () => new NR(null, { status: 200 }) };
});
vi.mock("@/lib/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessWithAudit,
}));
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));

import {
  proxy,
  _applySecurityHeaders,
  _extractSessionToken,
  _setSessionCache,
  _sessionCache,
} from "../proxy";

const dummyOptions = { cspHeader: "default-src 'self'", nonce: "test-nonce" };

const APP_ORIGIN = "http://localhost:3000";

function createApiRequest(
  path: string,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, { headers });
}

describe("proxy — handleApiAuth Bearer bypass", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("bypasses session check for Bearer + /api/passwords", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/passwords/[id]", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords/pw-1", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/vault/unlock/data", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/unlock/data", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/extension/token (revoke)", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/extension/token/refresh", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token/refresh", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/api-keys", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer + /api/api-keys/[id]", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys/key-1", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/v1/passwords without session (public API)", async () => {
    const res = await proxy(
      createApiRequest("/api/v1/passwords"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/v1/vault/status without session (public API)", async () => {
    const res = await proxy(
      createApiRequest("/api/v1/vault/status"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT bypass for Bearer + /api/tags (not in allowlist)", async () => {
    const res = await proxy(
      createApiRequest("/api/tags", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-tags",
      }),
      dummyOptions,
    );
    // fetch was called to check session
    expect(fetchSpy).toHaveBeenCalled();
    // returns 401 because mock returns no user
    expect(res.status).toBe(401);
  });

  it("does NOT bypass for Bearer + /api/teams (not in allowlist)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-teams",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("does NOT bypass without Bearer header on /api/passwords", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords", {
        Cookie: "authjs.session-token=sess-passwords",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for protected API route without session", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token", {
        Cookie: "authjs.session-token=sess-token",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does NOT bypass for Bearer + unknown child of /api/extension/token", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token/extra", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-token-child",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/sends without session", async () => {
    const res = await proxy(
      createApiRequest("/api/sends", {
        Cookie: "authjs.session-token=sess-sends",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/sends/file without session", async () => {
    const res = await proxy(
      createApiRequest("/api/sends/file", {
        Cookie: "authjs.session-token=sess-sends-file",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("allows non-protected API routes without auth", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/session"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/share-links/verify-access without session (public endpoint)", async () => {
    const res = await proxy(
      createApiRequest("/api/share-links/verify-access"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/share-links/[id]/content without session (public endpoint)", async () => {
    const res = await proxy(
      createApiRequest("/api/share-links/abc123/content"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/auth/passkey/options without session (unauthenticated endpoint)", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/passkey/options"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/auth/passkey/verify without session (unauthenticated endpoint)", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/passkey/verify"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows /api/auth/passkey/options/email without session (unauthenticated endpoint)", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/passkey/options/email"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});

describe("proxy — CORS preflight and headers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u1" } }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("OPTIONS /api/passwords (same-origin) returns 204 with CORS headers", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("OPTIONS /api/passwords (cross-origin) returns 204 without CORS headers", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.com" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("same-origin POST /api/passwords includes CORS headers", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        Cookie: "authjs.session-token=sess-1",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("cross-origin POST /api/passwords does not include CORS headers", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "POST",
      headers: {
        origin: "http://evil.com",
        Cookie: "authjs.session-token=sess-1",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("401 response includes CORS headers for same-origin", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: {
        origin: APP_ORIGIN,
        Cookie: "authjs.session-token=sess-fail",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });
});

describe("proxy — applySecurityHeaders basePath", () => {
  it("includes basePath in Report-To and csp-nonce cookie path", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions, "/passwd-sso");

    const reportTo = JSON.parse(response.headers.get("Report-To")!);
    expect(reportTo.endpoints[0].url).toBe("/passwd-sso/api/csp-report");
    expect(response.headers.get("Reporting-Endpoints")).toBe(
      'csp-endpoint="/passwd-sso/api/csp-report"',
    );
    expect(response.cookies.get("csp-nonce")?.path).toBe("/passwd-sso/");
  });

  it("defaults to root path when basePath is empty", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    const reportTo = JSON.parse(response.headers.get("Report-To")!);
    expect(reportTo.endpoints[0].url).toBe("/api/csp-report");
    expect(response.cookies.get("csp-nonce")?.path).toBe("/");
  });

  it("sets Referrer-Policy header", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("sets X-Content-Type-Options header", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets X-Frame-Options header", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("omits Strict-Transport-Security when AUTH_URL is HTTP", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    // AUTH_URL is not set (defaults to http://localhost:3000) → no HSTS
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("sets Permissions-Policy header", () => {
    const response = new NextResponse();
    _applySecurityHeaders(response, dummyOptions);

    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
  });
});

describe("extractSessionToken", () => {
  it("extracts authjs.session-token value from cookie string", () => {
    const cookie = "authjs.session-token=abc123def456";
    expect(_extractSessionToken(cookie)).toBe("abc123def456");
  });

  it("extracts __Secure-authjs.session-token value preferentially", () => {
    const cookie = "__Secure-authjs.session-token=secure-token-xyz; authjs.session-token=plain-token";
    // __Secure- prefix takes priority (listed first in the names array)
    expect(_extractSessionToken(cookie)).toBe("secure-token-xyz");
  });

  it("extracts authjs.session-token when __Secure- variant is absent", () => {
    const cookie = "other-cookie=value; authjs.session-token=my-session; another=thing";
    expect(_extractSessionToken(cookie)).toBe("my-session");
  });

  it("returns empty string when no session cookie exists", () => {
    const cookie = "some-cookie=value; another-cookie=other";
    expect(_extractSessionToken(cookie)).toBe("");
  });

  it("returns empty string for an empty cookie string", () => {
    expect(_extractSessionToken("")).toBe("");
  });

  it("handles token value at end of cookie string without trailing semicolon", () => {
    const cookie = "foo=bar; authjs.session-token=last-token-value";
    expect(_extractSessionToken(cookie)).toBe("last-token-value");
  });

  it("handles cookies with special characters in token value", () => {
    const cookie = "authjs.session-token=tok%2Fwith%3Dspecial%2Bchars; other=x";
    expect(_extractSessionToken(cookie)).toBe("tok%2Fwith%3Dspecial%2Bchars");
  });
});

describe("session cache eviction (setSessionCache)", () => {
  const SESSION_CACHE_MAX = 500; // must match proxy.ts SESSION_CACHE_MAX

  beforeEach(() => {
    _sessionCache.clear();
  });

  afterEach(() => {
    _sessionCache.clear();
  });

  it("evicts expired entries first when cache is full", () => {
    const now = Date.now();

    // Fill cache to SESSION_CACHE_MAX - 1 with already-expired entries
    for (let i = 0; i < SESSION_CACHE_MAX - 1; i++) {
      _sessionCache.set(`expired-${i}`, {
        expiresAt: now - 1000, // already expired
        valid: true,
        userId: `user-${i}`,
      });
    }
    // Add one live entry that will be at index SESSION_CACHE_MAX - 1
    _sessionCache.set("live-entry", {
      expiresAt: now + 60_000,
      valid: true,
      userId: "live-user",
    });

    expect(_sessionCache.size).toBe(SESSION_CACHE_MAX);

    // Trigger eviction by adding a new entry that pushes size to SESSION_CACHE_MAX + 1
    _setSessionCache("new-key", { valid: true, userId: "new-user" });

    // Expired entries must be purged; live entry and new entry must survive
    expect(_sessionCache.has("live-entry")).toBe(true);
    expect(_sessionCache.has("new-key")).toBe(true);
    // Expired entries should have been evicted
    expect(_sessionCache.has("expired-0")).toBe(false);
  });

  it("evicts the oldest entry when no expired entries exist", () => {
    const now = Date.now();
    const futureExpiry = now + 60_000;

    // Fill to exactly SESSION_CACHE_MAX with live entries; insertion order matters
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      _sessionCache.set(`live-${i}`, { expiresAt: futureExpiry, valid: true });
    }

    expect(_sessionCache.size).toBe(SESSION_CACHE_MAX);

    // Adding one more: no expired entries exist, so the oldest (live-0) must be evicted
    _setSessionCache("newest-key", { valid: true, userId: "newest" });

    // The first-inserted key is the oldest and should have been evicted
    expect(_sessionCache.has("live-0")).toBe(false);
    // All other entries and the new one should remain
    expect(_sessionCache.has("live-1")).toBe(true);
    expect(_sessionCache.has("newest-key")).toBe(true);
  });

  it("does NOT clear all entries on size limit — only evicts minimally", () => {
    const now = Date.now();

    // Fill cache with all live entries (no expired ones)
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      _sessionCache.set(`key-${i}`, { expiresAt: now + 60_000, valid: true });
    }

    _setSessionCache("trigger-eviction", { valid: false });

    // Cache must NOT have been fully cleared; only 1 entry evicted
    // so size should be SESSION_CACHE_MAX (500 - 1 evicted + 1 new = 500)
    expect(_sessionCache.size).toBe(SESSION_CACHE_MAX);
    // The new entry must exist
    expect(_sessionCache.has("trigger-eviction")).toBe(true);
  });
});

describe("proxy — access restriction", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Session returns valid user with ID
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u1" } }), { status: 200 }),
    );
    // Default: no tenant → access restriction skipped
    mockResolveUserTenantId.mockResolvedValue(null);
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns 403 for session-authenticated API route when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=sess-acl-deny" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("ACCESS_DENIED");
  });

  it("allows session-authenticated API route when access is allowed", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });

    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=sess-acl-allow" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("skips access restriction when tenant is null", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);

    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=sess-acl-notenant" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(200);
    expect(mockCheckAccessWithAudit).not.toHaveBeenCalled();
  });

  it("returns 403 for dashboard route when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/ja/dashboard`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=sess-acl-dash" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
  });
});
