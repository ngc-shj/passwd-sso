import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS_POLICY } from "../lib/security/security-headers";

const { mockCheckAccessWithAudit, mockResolveUserTenantId, mockLogAuditAsync } = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockResolveUserTenantId: vi.fn().mockResolvedValue(null),
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  logAuditAsync: mockLogAuditAsync,
}));
// No Redis: the session gate's audit limiter falls back to its in-memory
// counter, which `_resetSessionPasskeyAuditForTests` clears. A real Redis
// (REDIS_URL is set in app-ci) would keep the key across runs.
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));
vi.mock("@/lib/auth/session/session-cache", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/session/session-cache")
  >("@/lib/auth/session/session-cache");
  return {
    ...actual,
    getCachedSession: vi.fn().mockResolvedValue(null),
    setCachedSession: vi.fn().mockResolvedValue(undefined),
    invalidateCachedSession: vi.fn().mockResolvedValue(undefined),
  };
});

import { proxy } from "../proxy";
import { applySecurityHeaders as _applySecurityHeaders } from "../lib/proxy/security-headers";
import { __resetAllowlistForTests } from "../lib/http/cors";
import {
  cachedSessionInfo,
  dispatchFetch,
  fetchCallsTo,
  sessionResponseBody,
  sessionRoute,
  PASSKEY_BLOCKED,
} from "./helpers/proxy-session-fixtures";
import { _resetSessionPasskeyAuditForTests } from "../lib/proxy/session-passkey-gate";

const dummyOptions = { cspHeader: "default-src 'self'", nonce: "test-nonce" };

const APP_ORIGIN = "http://localhost:3000";

/**
 * Every cookie fixture below uses the plain `authjs.session-token` name, which
 * is the configured name only over http. Pin that shape so an AUTH_URL or
 * basePath exported in the shell cannot turn every fixture into a
 * non-configured cookie. AUTH_URL is stubbed empty (not to an http URL) so it
 * does not also become the CSRF gate's configured origin.
 */
beforeEach(() => {
  vi.stubEnv("AUTH_URL", "");
  vi.stubEnv("NEXTAUTH_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function createApiRequest(
  path: string,
  headers?: Record<string, string>,
  method: string = "GET",
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, { headers, method });
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

  it("bypasses session check for Bearer POST /api/vault/unlock/verify (C2)", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/unlock/verify", { Authorization: "Bearer tok123" }, "POST"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT bypass without Bearer header on /api/vault/unlock/verify (C2)", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/unlock/verify", undefined, "POST"),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("bypasses session check for Bearer DELETE /api/extension/token (revoke)", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token", { Authorization: "Bearer tok123" }, "DELETE"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for Bearer POST /api/extension/token/refresh", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token/refresh", { Authorization: "Bearer tok123" }, "POST"),
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

  it("passes /api/extension/bridge-code through (route handler does its own auth + Origin + DPoP)", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/bridge-code", {
        Cookie: "authjs.session-token=5e55-0000",
      }),
      dummyOptions,
    );
    // Post-C2: bridge-code uses the new API_EXTENSION_BRIDGE_CODE classification
    // with orchestrator early-return BEFORE the CSRF gate. Proxy does NOT call
    // auth() — that's the route handler's job (along with Origin allowlist +
    // DPoP + tenant IP check). Proxy returns 200 (next()) so the route can run.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does NOT bypass session check for Bearer + /api/api-keys (C2: session-only)", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    // api-keys is not a Bearer-bypass route (cors-gate.ts BEARER_RULES). A
    // Bearer-only request (no session cookie) short-circuits to 401 without a
    // session lookup.
    expect(res.status).toBe(401);
  });

  it("does NOT bypass session check for Bearer + /api/api-keys/[id] (C2: session-only)", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys/key-1", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("bypasses for Bearer DELETE /api/passwords/[id] (soft-delete, extension passkey-replace)", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords/pw-1", { Authorization: "Bearer tok123" }, "DELETE"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT bypass for Bearer POST /api/passwords/bulk-import (mutating child, session-only)", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords/bulk-import", { Authorization: "Bearer tok123" }, "POST"),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("does NOT bypass for Bearer DELETE /api/teams/[id]/passwords/[id] (team mutating child, session-only)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/passwords/e1", { Authorization: "Bearer tok123" }, "DELETE"),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("does NOT bypass for Bearer POST /api/teams (wrong method on Bearer-GET path)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams", { Authorization: "Bearer tok123" }, "POST"),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("bypasses for Bearer GET /api/teams/[id]/passwords (team list read)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/passwords", { Authorization: "Bearer tok123" }, "GET"),
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

  it("applies baseline security headers to API responses (orchestrator wiring)", async () => {
    const res = await proxy(
      createApiRequest("/api/v1/passwords"),
      dummyOptions,
    );
    // proxy() must wrap handleApiAuth's response with applyBaselineSecurityHeaders.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    // CSP / X-Frame-Options stay page-only — not applied to API responses.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
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
        Cookie: "authjs.session-token=5e55-0001",
      }),
      dummyOptions,
    );
    // fetch was called to check session
    expect(fetchCallsTo(fetchSpy, "/api/auth/session")).toHaveLength(1);
    // returns 401 because mock returns no user
    expect(res.status).toBe(401);
  });

  it("does NOT bypass when a session cookie accompanies Bearer (cookie+Bearer guard) — /api/teams", async () => {
    const res = await proxy(
      createApiRequest("/api/teams", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=5e55-0002",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("bypasses session check for cookieless Bearer + /api/teams (team list)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for cookieless Bearer + /api/teams/t1/passwords (team password list)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/passwords", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for cookieless Bearer + /api/teams/t1/passwords/e1 (team entry)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/passwords/e1", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses session check for cookieless Bearer + /api/teams/t1/member-key", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/member-key", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT bypass for cookieless Bearer + /api/teams/t1/webhooks (web-only, now denied)", async () => {
    const res = await proxy(
      createApiRequest("/api/teams/t1/webhooks", { Authorization: "Bearer tok123" }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("does NOT bypass without Bearer header on /api/passwords", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords", {
        Cookie: "authjs.session-token=5e55-0003",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for protected API route without session", async () => {
    const res = await proxy(
      createApiRequest("/api/extension/token", {
        Cookie: "authjs.session-token=5e55-0004",
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
        Cookie: "authjs.session-token=5e55-0005",
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
        Cookie: "authjs.session-token=5e55-0006",
      }),
      dummyOptions,
    );
    // Falls through to the session-authenticated path; session fetch mock
    // returns { user: null } so the middleware rejects with 401.
    expect(res.status).toBe(401);
    // The session lookup MUST have run (proves we did not bypass).
    expect(fetchCallsTo(fetchSpy, "/api/auth/session")).toHaveLength(1);
  });

  it("does NOT bypass when session cookie is present alongside Bearer + /api/api-keys", async () => {
    const res = await proxy(
      createApiRequest("/api/api-keys", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=5e55-0007",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
    expect(fetchCallsTo(fetchSpy, "/api/auth/session")).toHaveLength(1);
  });

  it("does NOT bypass when session cookie is present alongside Bearer + /api/vault/delegation", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/delegation/check", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=5e55-0008",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
    expect(fetchCallsTo(fetchSpy, "/api/auth/session")).toHaveLength(1);
  });

  it("returns 401 for /api/sends without session", async () => {
    const res = await proxy(
      createApiRequest("/api/sends", {
        Cookie: "authjs.session-token=5e55-0009",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/sends/file without session", async () => {
    const res = await proxy(
      createApiRequest("/api/sends/file", {
        Cookie: "authjs.session-token=5e55-000a",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/vault/setup without session", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/setup", {
        Cookie: "authjs.session-token=5e55-000b",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/vault/unlock without session", async () => {
    const res = await proxy(
      createApiRequest("/api/vault/unlock", {
        Cookie: "authjs.session-token=5e55-000c",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/folders without session", async () => {
    const res = await proxy(
      createApiRequest("/api/folders", {
        Cookie: "authjs.session-token=5e55-000d",
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

// ─── C8 — Proxy passes /api/extension/bridge-code through to route handler ───
//
// Plan C2/C8: the bridge-code route is classified as API_EXTENSION_BRIDGE_CODE
// and the orchestrator early-returns BEFORE the baseline CSRF gate. The route
// handler is solely responsible for Origin allowlist check, auth(), DPoP
// verification, and tenant IP restriction. These tests prove the proxy does
// NOT short-circuit with 403 — every 403 in this flow comes from the route
// handler (which is a separate test surface), never from the proxy CSRF gate.
const CHROME_EXT_ALLOWED = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CHROME_EXT_ATTACKER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

describe("proxy — C8 bridge-code passthrough", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", CHROME_EXT_ALLOWED);
    __resetAllowlistForTests();
    // Session fetch never reached on the bridge-code path; assert it stays
    // un-called to prove the early-return ran before the auth gate.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    __resetAllowlistForTests();
  });

  it("cookie + allowlisted chrome-extension Origin + POST → passes through (200, no CSRF 403)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/extension/bridge-code`, {
      method: "POST",
      headers: {
        origin: CHROME_EXT_ALLOWED,
        Cookie: "authjs.session-token=5e55-0000",
        "Content-Type": "application/json",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    // Proxy CSRF gate did NOT fire (any 403 here would be from the proxy,
    // since the route handler hasn't run in this test surface).
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Allowlisted extension origin gets credentialed CORS headers.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_EXT_ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("cookie + non-allowlisted chrome-extension Origin + POST → passes through (route handler will 403)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/extension/bridge-code`, {
      method: "POST",
      headers: {
        origin: CHROME_EXT_ATTACKER,
        Cookie: "authjs.session-token=5e55-0000",
        "Content-Type": "application/json",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    // Proxy still returns 200 — the Origin allowlist check is the route
    // handler's job, NOT the proxy CSRF gate's. Distinguishing the 403
    // source matters: if the proxy 403'd here, the route handler's audit
    // trail and step-up checks would be bypassed.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Non-allowlisted extension origin → no CORS Allow-Origin (browser will
    // block the response, but the proxy itself does not 403 the request).
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("cookie + cross-origin https://attacker.example + POST → passes through (route handler will 403)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/extension/bridge-code`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        Cookie: "authjs.session-token=5e55-0000",
        "Content-Type": "application/json",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    // Critically, the baseline CSRF gate would have returned 403 for this
    // (cookie + mutating method + cross-origin) on any other route. The
    // early-return for API_EXTENSION_BRIDGE_CODE intentionally bypasses it
    // — the route handler must enforce Origin against the allowlist instead.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("no cookie + allowlisted chrome-extension Origin + POST → passes through (route handler will 401)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/extension/bridge-code`, {
      method: "POST",
      headers: {
        origin: CHROME_EXT_ALLOWED,
        "Content-Type": "application/json",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    // No session cookie → CSRF gate would not fire anyway, but more
    // importantly the proxy must not 401 here either. auth() runs in the
    // route handler.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_EXT_ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});

describe("proxy — CORS preflight and headers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u1"))),
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

  it("OPTIONS /api/passwords/[id] (chrome-extension) allows extension origin (preflight is path-only)", async () => {
    // The child path's only Bearer methods are GET/PUT/DELETE; the OPTIONS
    // request's method is OPTIONS, so preflight must gate on path-eligibility
    // (isBearerBypassPath), not the method-aware matcher — otherwise the
    // extension cannot preflight the DELETE soft-delete flow.
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords/pw-1`, {
      method: "OPTIONS",
      headers: { origin: CHROME_EXT_ALLOWED },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_EXT_ALLOWED);
  });

  it("OPTIONS /api/passwords/bulk-import (chrome-extension) does NOT allow extension origin (not Bearer-eligible)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords/bulk-import`, {
      method: "OPTIONS",
      headers: { origin: CHROME_EXT_ALLOWED },
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
        Cookie: "authjs.session-token=5e55-000e",
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
        Cookie: "authjs.session-token=5e55-000e",
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
        Cookie: "authjs.session-token=5e55-000f",
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

describe("proxy — access restriction", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // CSRF gate now fails closed without configured origin — must stub APP_URL
    // so cookie-bearing mutating requests reach the access-restriction stage
    // instead of short-circuiting at INVALID_ORIGIN.
    vi.stubEnv("APP_URL", APP_ORIGIN);
    // Session returns valid user with ID
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u1"))),
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
      headers: { Cookie: "authjs.session-token=5e55-0010" },
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
      headers: { Cookie: "authjs.session-token=5e55-0011" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("fails closed (401) when the user has no active tenant membership (deactivated)", async () => {
    // resolveUserTenantId returns null (deactivatedAt != null). Since
    // User.tenantId is a non-null FK, this is a revoked membership, not a
    // legitimate no-tenant user. getSessionInfo fails closed, so the request is
    // rejected BEFORE the access-restriction check — a stale/deactivated session
    // can no longer both pass validation AND skip the tenant IP gate.
    mockResolveUserTenantId.mockResolvedValue(null);

    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=5e55-0012" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(401);
    expect(mockCheckAccessWithAudit).not.toHaveBeenCalled();
  });

  it("returns 403 for /api/vault/unlock when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/api/vault/unlock`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=5e55-0013",
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
      headers: { Cookie: "authjs.session-token=5e55-0014" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ACCESS_DENIED");
  });

  // `name =B; name=A`: Auth.js trims the key and authenticates B (first
  // occurrence); an exact-key reader skips the first pair and decides on A.
  // The IP restriction must never be checked against A's tenant for a
  // request whose route handler will run as B.
  describe("whitespace-spelled duplicate session cookie", () => {
    const SESSION_OPEN = "a0a0a0a0-0000-4000-8000-00000000000a";
    const SESSION_RESTRICTED = "b0b0b0b0-0000-4000-8000-00000000000b";

    beforeEach(() => {
      fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        const userId = cookie.includes(SESSION_RESTRICTED) ? "u-restricted" : "u-open";
        return new Response(JSON.stringify(sessionResponseBody(userId)), { status: 200 });
      });
      mockResolveUserTenantId.mockImplementation(async (userId: string) =>
        userId === "u-restricted" ? "tenant-restricted" : "tenant-open",
      );
      mockCheckAccessWithAudit.mockImplementation(async (tenantId: string) => ({
        allowed: tenantId !== "tenant-restricted",
      }));
    });

    function requestWith(cookie: string) {
      return new NextRequest(`${APP_ORIGIN}/api/passwords`, {
        method: "GET",
        headers: { Cookie: cookie },
      } as ConstructorParameters<typeof NextRequest>[1]);
    }

    it("control: the restricted session alone is denied, the open one alone allowed", async () => {
      expect((await proxy(requestWith(`authjs.session-token=${SESSION_RESTRICTED}`), dummyOptions)).status).toBe(403);
      expect((await proxy(requestWith(`authjs.session-token=${SESSION_OPEN}`), dummyOptions)).status).toBe(200);
    });

    it("decides on the first (trimmed) cookie, the session auth() authenticates", async () => {
      // Auth.js trims the key and keeps the first: the route runs as the
      // restricted session, so the restricted tenant's IP rule must apply.
      const res = await proxy(
        requestWith(`authjs.session-token =${SESSION_RESTRICTED}; authjs.session-token=${SESSION_OPEN}`),
        dummyOptions,
      );

      expect(res.status).toBe(403);
      expect(mockCheckAccessWithAudit).not.toHaveBeenCalledWith(
        "tenant-open",
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("returns 403 for dashboard route when access denied", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false, reason: "IP not in allowed CIDRs" });

    const req = new NextRequest(`${APP_ORIGIN}/ja/dashboard`, {
      method: "GET",
      headers: { Cookie: "authjs.session-token=5e55-0015" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(403);
  });
});

// =============================================================================
// CSRF gate integration tests (C4 step 6).
//
// These exercise the proxy CSRF gate end-to-end through the orchestrator.
// They are the regression net for pre1 (an api-default mutating route with
// no assertOrigin of its own) and
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
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u1"))),
    );
    // A normal user WITH an active membership (a null return now fails session
    // validation, which these CSRF-gate tests don't intend to exercise).
    mockResolveUserTenantId.mockResolvedValue("tenant1");
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
        Cookie: "authjs.session-token=5e55-0016",
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
        Cookie: "authjs.session-token=5e55-0017",
        Origin: "https://evil.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    // GET reaches session validation (which passes), then default fall-through
    expect(res.status).toBe(200);
  });

  it("[3] api-default POST + session + mismatched Origin → 403 (pre1 closure)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/maintenance/purge-history`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=5e55-0018",
        Origin: "https://evil.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });

  it("[4] api-default POST + session + matching Origin → pass-through (default branch, route handler authenticates)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/maintenance/purge-history`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=5e55-0019",
        Origin: APP_ORIGIN,
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    // /api/maintenance/* falls through to api-default — no proxy 401, route handles it
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
        Cookie: "authjs.session-token=5e55-001a",
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
        Cookie: "authjs.session-token=5e55-001b",
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
        Cookie: "authjs.session-token=5e55-001c",
        Origin: "https://devtool.example.com",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(200);
  });

  it("[10] api-default POST + session WITHOUT Origin → 403 (a missing Origin is refused, not waved through)", async () => {
    const req = new NextRequest(`${APP_ORIGIN}/api/maintenance/purge-history`, {
      method: "POST",
      headers: {
        Cookie: "authjs.session-token=5e55-001e",
        // Origin intentionally omitted
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Session passkey gate through the orchestrator. The full C1 matrix lives in
// src/lib/proxy/api-route-passkey-gate.test.ts; these pin the wiring.
// =============================================================================

describe("proxy — session passkey gate", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSessionPasskeyAuditForTests();
    vi.stubEnv("APP_URL", APP_ORIGIN);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u-blocked", PASSKEY_BLOCKED))),
    );
    mockResolveUserTenantId.mockResolvedValue("tenant1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("refuses a blocked session's API call with PASSKEY_REQUIRED, CORS-wrapped, and audits it", async () => {
    const res = await proxy(
      createApiRequest("/api/passwords", {
        Cookie: "authjs.session-token=5e55-0020",
        origin: APP_ORIGIN,
      }),
      dummyOptions,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("PASSKEY_REQUIRED");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        userId: "u-blocked",
        tenantId: "tenant1",
        metadata: { blockedPath: "GET /api/passwords" },
      }),
    );
  });

  it("answers OPTIONS with a blocked cookie with 204 and no session read", async () => {
    const res = await proxy(
      createApiRequest(
        "/api/passwords",
        { Cookie: "authjs.session-token=5e55-0021", origin: APP_ORIGIN },
        "OPTIONS",
      ),
      dummyOptions,
    );

    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // SEC-2: a page navigation's blocked row names the area, never the
  // caller-chosen path, and is written once.
  it("redirects a blocked page navigation and audits it once, in-process, with a closed blockedPath", async () => {
    fetchSpy.mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u-blocked-page", PASSKEY_BLOCKED))),
    );

    const res = await proxy(
      new NextRequest(`${APP_ORIGIN}/ja/dashboard/passwords/attacker-chosen-0123`, {
        headers: { Cookie: "authjs.session-token=5e55-0023" },
      }),
      dummyOptions,
    );
    await new Promise((r) => setImmediate(r));

    expect(res.status).toBe(307);
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        userId: "u-blocked-page",
        tenantId: "tenant1",
        metadata: { blockedPath: "PAGE /dashboard" },
      }),
    );
    expect(fetchSpy.mock.calls.map((c: unknown[]) => new URL(String(c[0])).pathname)).toEqual([
      "/api/auth/session",
    ]);
  });

  it("passes the proxy's own session read (Tier A) without reading the session", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/session", { Cookie: "authjs.session-token=5e55-0022" }),
      dummyOptions,
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// auth-gate cache miss path test — Redis TTL expiry surfaces as a cache miss.
// =============================================================================

describe("auth-gate session cache miss path", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      dispatchFetch(sessionRoute(sessionResponseBody("u-miss"))),
    );
    mockResolveUserTenantId.mockResolvedValue("tenant1");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("re-fetches session from /api/auth/session on Redis cache miss", async () => {
    // Arrange: getCachedSession returns hit on first call, miss on second.
    const { getCachedSession } = await import("../lib/auth/session/session-cache");
    const cacheSpy = vi.mocked(getCachedSession)
      .mockResolvedValueOnce(cachedSessionInfo("u-miss", "tenant1"))
      .mockResolvedValue(null);

    const buildReq = () =>
      new NextRequest(`${APP_ORIGIN}/api/passwords`, {
        method: "GET",
        headers: { Cookie: "authjs.session-token=5e55-001f" },
      } as ConstructorParameters<typeof NextRequest>[1]);

    // Hit path: cache returns SessionInfo, no upstream fetch.
    expect((await proxy(buildReq(), dummyOptions)).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // Miss path: cache returns null, upstream fetch fires once.
    expect((await proxy(buildReq(), dummyOptions)).status).toBe(200);
    expect(fetchCallsTo(fetchSpy, "/api/auth/session")).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    expect(cacheSpy).toHaveBeenCalledTimes(2);
  });
});

describe("proxy — Tailscale forwarded-header normalization wire-in", () => {
  // Asserts the orchestrator passes the normalized request (not the
  // original) to both dispatch branches. Without this, a future refactor
  // of src/proxy.ts that drops the normalize call would silently
  // reintroduce the :3001 leak — unit tests on normalizeForwardedHeaders
  // would still pass.
  const TS_HEADERS = {
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    "tailscale-user-login": "user@example.com",
  } as const;

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("API route: Bearer + Tailscale headers reach handleApiAuth (Bearer bypass branch)", async () => {
    // proxy.ts must dispatch on normalized.nextUrl.pathname; if it accidentally
    // dispatched on the original (which still has request.url = listen URL),
    // pathname would still match — but the handler would receive headers
    // without the override applied. Assert the bypass response shape so we
    // know the API branch ran end-to-end with the normalized request.
    const req = new NextRequest("https://localhost:3001/api/passwords", {
      headers: {
        ...TS_HEADERS,
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-port": "3001",
        "x-forwarded-proto": "https",
        Authorization: "Bearer tok123",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("page route: Tailscale headers flow through handlePageRoute (security headers applied)", async () => {
    // Page-route branch always runs applySecurityHeaders, so the CSP header
    // is the cheapest end-to-end signal that the dispatch reached the
    // page-route handler with the normalized request.
    const req = new NextRequest(
      "https://localhost:3001/passwd-sso/dashboard?ext_connect=1",
      {
        headers: {
          ...TS_HEADERS,
          host: "app.example.com",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-port": "3001",
          "x-forwarded-proto": "https",
        },
      } as ConstructorParameters<typeof NextRequest>[1],
    );
    const res = await proxy(req, dummyOptions);

    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("non-Tailscale request: dispatch unchanged, no normalization side effects", async () => {
    // Smoke test: requests without Tailscale headers must still dispatch
    // identically. Guards against the normalize gate accidentally returning
    // a different request shape on the no-op path.
    const req = new NextRequest(`${APP_ORIGIN}/api/passwords`, {
      headers: { Authorization: "Bearer tok123" },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await proxy(req, dummyOptions);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
