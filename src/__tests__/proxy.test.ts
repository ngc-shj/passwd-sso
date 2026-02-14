import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null, { status: 200 }),
}));

import { proxy } from "../proxy";

const dummyOptions = { cspHeader: "default-src 'self'", nonce: "test-nonce" };

function createApiRequest(
  path: string,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
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

  it("does NOT bypass for Bearer + /api/orgs (not in allowlist)", async () => {
    const res = await proxy(
      createApiRequest("/api/orgs", {
        Authorization: "Bearer tok123",
        Cookie: "authjs.session-token=sess-orgs",
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

  it("allows non-protected API routes without auth", async () => {
    const res = await proxy(
      createApiRequest("/api/auth/session"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
