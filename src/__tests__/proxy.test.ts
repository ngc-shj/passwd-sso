import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS_POLICY } from "../lib/security/security-headers";
import { SESSION_CACHE_MAX } from "../lib/validations/common.server";
import { SESSION_CACHE_TTL_MS } from "../lib/proxy/auth-gate";

const { mockCheckAccessWithAudit, mockResolveUserTenantId } = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockResolveUserTenantId: vi.fn().mockResolvedValue(null),
}));

vi.mock("next-intl/middleware", async () => {
  const { NextResponse: NR } = await import("next/server");
  return { default: () => () => new NR(null, { status: 200 }) };
});
vi.mock("@/lib/auth/policy/access-restriction", () => ({
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
  _passkeyAuditEmitted,
  _PASSKEY_AUDIT_MAP_MAX,
  _PASSKEY_AUDIT_DEDUP_MS,
  _recordPasskeyAuditEmit,
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

  it("bypasses session check for /api/extension/token/exchange (no session, no Bearer)", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token/exchange"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires session for /api/extension/bridge-code (extension prefix is session-required)", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/bridge-code", {
        Cookie: "authjs.session-token=sess-bridge",
      }),
      dummyOptions,
    );
    // The session lookup must run (proves the route is NOT in the bypass list);
    // mock returns no user → 401.
    expect(fetchSpy).toHaveBeenCalled();
    expect(res.status).toBe(401);
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

  // N2: session cookie + arbitrary Bearer must not skip the middleware
  // session+IP check. If it did, an attacker off-network could combine a
  // valid session cookie with any Bearer string to defeat the tenant IP
  // restriction — authOrToken prefers session, so the handler would grant
  // access without any IP gate.
  it("does NOT bypass when session cookie is present alongside Bearer + /api/passwords", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-cookie-plus-bearer",
      }),
      dummyOptions,
    );
    // Falls through to the session-authenticated path; session fetch mock
    // returns { user: null } so the middleware rejects with 401.
    expect(res.status).toBe(401);
    // The session lookup MUST have run (proves we did not bypass).
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does NOT bypass when session cookie is present alongside Bearer + /api/api-keys", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-cookie-plus-bearer-apikey",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does NOT bypass when session cookie is present alongside Bearer + /api/vault/delegation", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/delegation/check", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-cookie-plus-bearer-deleg",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
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

  it("returns 401 for /api/vault/setup without session", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/setup", {
        Cookie: "authjs.session-token=sess-vault-setup",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/vault/unlock without session", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/unlock", {
        Cookie: "authjs.session-token=sess-vault-unlock",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/folders without session", async () => {
    const res = await proxy(
      createApiRequest("/api/folders", {
        Cookie: "authjs.session-token=sess-folders",
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

    expect(response.headers.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY);
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

  it("returns 403 for /api/vault/unlock when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/api/vault/unlock`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-acl-vault",
        Origin: APP_ORIGIN,
        Host: "localhost:3000",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ACCESS_DENIED");
  });

  it("returns 403 for /api/folders when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/api/folders`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=sess-acl-folders" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ACCESS_DENIED");
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

// =============================================================================
// CSRF gate integration tests (C4 step 6 — 11 cases).
//
// These exercise the proxy CSRF gate end-to-end through the orchestrator.
// They are the regression net for pre1 (audit-emit assertOrigin missing) and
// the R3 baseline (9 session-mutating routes lacked assertOrigin) — both
// closed structurally by the gate. Without these tests, a refactor that
// drops shouldEnforceCsrf or reorders the early-returns would pass the suite.
// =============================================================================

describe("proxy — CSRF gate", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", APP_ORIGIN);
    // getSessionInfo's internal fetch returns a valid session by default,
    // so requests that pass the CSRF gate proceed to the route handler
    // (where we stop and just inspect status / pass-through).
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u1" } }), { status: 200 }),
    );
    mockResolveUserTenantId.mockResolvedValue(null);
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("[1] session POST + mismatched Origin → 403", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-csrf-1",
        Origin: "https://evil.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });

  it("[2] session GET + mismatched Origin → pass-through (gate is mutating-only)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: {
        Cookie: "authjs.session-token=sess-csrf-2",
        Origin: "https://evil.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    // GET reaches session validation (which passes), then default fall-through
    expect(res.status).toBe(200);
  });

  it("[3] /api/internal/audit-emit POST + session + mismatched Origin → 403 (pre1 closure)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/internal/audit-emit`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-csrf-3",
        Origin: "https://evil.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });

  it("[4] /api/internal/audit-emit POST + session + matching Origin → pass-through (default branch, route handler authenticates)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/internal/audit-emit`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-csrf-4",
        Origin: APP_ORIGIN,
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    // /api/internal/* falls through to api-default — no proxy 401, route handles it
    expect(res.status).toBe(200);
  });

  it("[5] extension Bearer POST + chrome-extension:// Origin (no cookie) → pass-through (gate skips: no cookie)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ext-tok",
        Origin: "chrome-extension://abc1234567890abcdef1234567890abcdef",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled(); // bypass branch returns before getSessionInfo
  });

  it("[6] Bearer + session cookie + mismatched Origin → 403 (gate fires before bypass branch — Round 2 / S3)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ext-tok",
        Cookie: "authjs.session-token=sess-csrf-6",
        Origin: "chrome-extension://abc1234567890abcdef1234567890abcdef",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });

  it("[7] /api/maintenance/* POST without cookie + ADMIN_API_TOKEN → pass-through (api-default + no cookie → gate skips)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/maintenance/purge-history`, {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-api-token",
        // No Origin, no Cookie
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
  });

  it("[8] /api/csp-report POST + session cookie + null Origin → pass-through (public-receiver short-circuits — Round 2 / F2)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/csp-report`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-csrf-8",
        // Origin omitted (sandboxed iframe / null Origin)
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
  });

  it("[9] /api/v1/* POST + API key Bearer + stale cookie + cross-origin → pass-through (api-v1 short-circuits — Round 3 / S4)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/v1/passwords`, {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key-tok",
        Cookie: "authjs.session-token=sess-stale-csrf-9",
        Origin: "https://devtool.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
  });

  it("[10] internal-fetch shape (POST to audit-emit with explicit Origin matching APP_URL + session cookie) → pass-through", async () => {
    // Simulates the proxy's own self-fetch at proxy.ts:153 with the Origin
    // header set to selfOrigin. Validates that the C4 step 3 fix works:
    // the proxy can call its own /api/internal/audit-emit without 403'ing.
    const req = new NextRequest(`${APP_ORIGIN}/api/internal/audit-emit`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-internal-fetch",
        Origin: APP_ORIGIN, // explicit, matches APP_URL
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
  });

  it("[11] internal-fetch counter-test: WITHOUT explicit Origin → 403 (locks T3 fix — proxy MUST set Origin on self-fetch)", async () => {
    // If a future refactor removes "Origin: selfOrigin" from the internal
    // fetch (proxy.ts:153), this counter-test catches it: a same-shape
    // request with no Origin gets 403 from the CSRF gate.
    const req = new NextRequest(`${APP_ORIGIN}/api/internal/audit-emit`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=sess-internal-fetch-noorigin",
        // Origin intentionally omitted
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// auth-gate TTL expiry test (T2 — covers the cache miss path on stale entry).
// =============================================================================

describe("auth-gate session cache TTL expiry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("APP_URL", APP_ORIGIN);
    _sessionCache.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u-ttl" } }), { status: 200 }),
    );
    mockResolveUserTenantId.mockResolvedValue(null);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("re-fetches session from /api/auth/session after SESSION_CACHE_TTL_MS (30s) expires", async () => {
    const buildReq = () =>
      new NextRequest(`${APP_ORIGIN}/api/passwords`, {
        method: "GET",
        headers: { Cookie: "authjs.session-token=sess-ttl" },
      } as ConstructorParameters<typeof NextRequest>[1]);

    // First request: populates the cache via fetch
    await proxy(buildReq(), dummyOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second request well within TTL: serves from cache (no new fetch)
    vi.advanceTimersByTime(SESSION_CACHE_TTL_MS / 6);
    await proxy(buildReq(), dummyOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Third request past TTL: cache is stale, fresh fetch fires
    vi.advanceTimersByTime(SESSION_CACHE_TTL_MS);
    await proxy(buildReq(), dummyOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("proxy — passkeyAuditEmitted staleness eviction", () => {
  beforeEach(() => {
    _passkeyAuditEmitted.clear();
  });

  it("returns true on first emit, false within dedup window, true after window", () => {
    const t0 = 1_000_000;
    expect(_recordPasskeyAuditEmit("u1", t0)).toBe(true);
    expect(_recordPasskeyAuditEmit("u1", t0 + _PASSKEY_AUDIT_DEDUP_MS)).toBe(false);
    expect(_recordPasskeyAuditEmit("u1", t0 + _PASSKEY_AUDIT_DEDUP_MS + 1)).toBe(true);
  });

  it("evicts the user with the oldest lastEmitted timestamp, not the first-inserted", () => {
    const base = 1_000_000;
    const dedup = _PASSKEY_AUDIT_DEDUP_MS;

    // Fill the map. u0 is inserted first.
    for (let i = 0; i < _PASSKEY_AUDIT_MAP_MAX; i++) {
      const accepted = _recordPasskeyAuditEmit(`u${i}`, base + i);
      expect(accepted).toBe(true);
    }
    expect(_passkeyAuditEmitted.size).toBe(_PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditEmitted.has("u0")).toBe(true);
    expect(_passkeyAuditEmitted.has("u1")).toBe(true);

    // Re-emit u0 well beyond the dedup window. With FIFO eviction this would
    // not save u0 (its insertion-order position would still be 0). With LRU
    // eviction (delete-then-set) u0 moves to the tail, so u1 is now the
    // staleness candidate at the head.
    const refresh = base + _PASSKEY_AUDIT_MAP_MAX + dedup + 1;
    expect(_recordPasskeyAuditEmit("u0", refresh)).toBe(true);

    // Add a new user. Map is at capacity, so something must be evicted.
    expect(_recordPasskeyAuditEmit("u-new", refresh + 1)).toBe(true);

    expect(_passkeyAuditEmitted.size).toBe(_PASSKEY_AUDIT_MAP_MAX);
    // Staleness eviction picks u1 (oldest lastEmitted), NOT u0.
    expect(_passkeyAuditEmitted.has("u0")).toBe(true);
    expect(_passkeyAuditEmitted.has("u1")).toBe(false);
    expect(_passkeyAuditEmitted.has("u-new")).toBe(true);
  });

  it("non-monotonic lastEmitted: most recently refreshed user survives eviction", () => {
    // Insert u0, u1, u2 in order. Then refresh in non-monotonic order: u1, u0.
    // The eviction order should be u2 (oldest by last-set), then u1, then u0.
    const t0 = 1_000_000;
    const dedup = _PASSKEY_AUDIT_DEDUP_MS;
    _recordPasskeyAuditEmit("u0", t0);
    _recordPasskeyAuditEmit("u1", t0 + 1);
    _recordPasskeyAuditEmit("u2", t0 + 2);
    // Refresh u1 and u0 past the dedup window so the calls are accepted.
    _recordPasskeyAuditEmit("u1", t0 + dedup + 10);
    _recordPasskeyAuditEmit("u0", t0 + dedup + 20);

    // First key in iteration order is the staleness candidate.
    expect(_passkeyAuditEmitted.keys().next().value).toBe("u2");
  });
});
