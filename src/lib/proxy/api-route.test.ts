import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockCheckAccessWithAudit, mockResolveUserTenantId } = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockResolveUserTenantId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessWithAudit,
}));
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));
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

import { handleApiAuth } from "./api-route";

const APP_ORIGIN = "http://localhost:3000";

function makeRequest(
  path: string,
  method: string = "GET",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, { method, headers });
}

describe("handleApiAuth — preflight (OPTIONS)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 204 for same-origin preflight on Bearer-bypass route", async () => {
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: APP_ORIGIN });
    const res = await handleApiAuth(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });

  it("returns 204 for same-origin preflight on exchange route", async () => {
    const req = makeRequest("/api/extension/token/exchange", "OPTIONS", {
      origin: APP_ORIGIN,
    });
    const res = await handleApiAuth(req);
    expect(res.status).toBe(204);
  });
});

describe("handleApiAuth — public/early-return short-circuits", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("PUBLIC_SHARE → 200 with Cache-Control: no-store, no fetch", async () => {
    const res = await handleApiAuth(makeRequest("/api/share-links/abc/content"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PUBLIC_RECEIVER (csp-report) → 200 without auth", async () => {
    const res = await handleApiAuth(makeRequest("/api/csp-report", "POST"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("API_V1 → 200 with private no-store, no session check", async () => {
    const res = await handleApiAuth(makeRequest("/api/v1/passwords"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("handleApiAuth — Bearer-bypass dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("Bearer + bypass route + NO cookie → bypass session check (no fetch)", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/passwords", "GET", { Authorization: "Bearer tok" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Bearer + bypass route + cookie present → MUST take session-authenticated branch (fetch IS called)", async () => {
    // Round 2 S4 obligation: cookie + Bearer must NOT bypass; fall through
    // to session-validation path so tenant IP restriction can fire.
    const res = await handleApiAuth(
      makeRequest("/api/passwords", "GET", {
        Authorization: "Bearer tok",
        Cookie: "authjs.session-token=sess-1",
      }),
    );
    // Mock returns no user → 401.
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("Bearer + non-bypass route + cookie → session check fires (no bypass)", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/teams", "GET", {
        Authorization: "Bearer tok",
        Cookie: "authjs.session-token=sess-2",
      }),
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("Cookie only + non-Bearer route → session check fires", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/teams", "GET", { Cookie: "authjs.session-token=sess-3" }),
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("handleApiAuth — exchange route", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("exchange route → 200 with private no-store, no session check", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/extension/token/exchange", "POST"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("handleApiAuth — session-required + access restriction", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u-1" } }), { status: 200 }),
    );
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
    mockResolveUserTenantId.mockResolvedValue(null);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns 200 when session is valid and no tenant restriction applies", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/passwords", "GET", { Cookie: "authjs.session-token=sess" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns 403 when access restriction denies", async () => {
    mockResolveUserTenantId.mockResolvedValueOnce("t-1");
    mockCheckAccessWithAudit.mockResolvedValueOnce({
      allowed: false,
      reason: "IP not in allowed CIDRs",
    });
    const res = await handleApiAuth(
      makeRequest("/api/passwords", "GET", {
        Cookie: "authjs.session-token=sess",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ACCESS_DENIED");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("handleApiAuth — does NOT apply security headers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u-1" } }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("API responses do not carry CSP / X-Frame-Options / Permissions-Policy", async () => {
    const res = await handleApiAuth(
      makeRequest("/api/passwords", "GET", { Authorization: "Bearer tok" }),
    );
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Permissions-Policy")).toBeNull();
  });
});
