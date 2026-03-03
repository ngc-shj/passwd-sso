import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null, { status: 200 }),
}));

import { proxy, _applySecurityHeaders } from "../proxy";

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
});
