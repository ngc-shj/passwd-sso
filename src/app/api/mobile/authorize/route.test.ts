import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockMobileBridgeCodeCreate,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockGetAppOrigin,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMobileBridgeCodeCreate: vi.fn(),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockWithUserTenantRls: vi.fn(
    async (_u: string, fn: (tenantId: string) => unknown) =>
      fn("22222222-2222-2222-2222-222222222222"),
  ),
  mockGetAppOrigin: vi.fn(() => "https://example.test"),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mobileBridgeCode: { create: mockMobileBridgeCodeCreate },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/url-helpers", () => ({
  getAppOrigin: mockGetAppOrigin,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "f".repeat(64),
  hashToken: () => "h".repeat(64),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/auth/session/step-up", () => ({
  requireRecentSession: mockRequireRecentSession,
}));

import { GET } from "./route";

// C6: device_jkt is the RFC 7638 JWK thumbprint (43 base64url chars). The
// legacy device_pubkey field (base64url SPKI-DER) was removed because the
// server's SHA-256(SPKI) was never equal to the verifier's JWK thumbprint.
const VALID = {
  client_kind: "ios",
  state: "Vp8XR_zg2v9MhUv8tRgHqf-RJfuJ_kqJUYHOG-WEyT0",
  code_challenge: "Z9wHNpVlwKmGM57J7TmKEXJlhhPYiqVdNNgF1MIv7DM",
  device_jkt: "Z9wHNpVlwKmGM57J7TmKEXJlhhPYiqVdNNgF1MIv7DM",
};

function buildUrl(params: Partial<typeof VALID>): string {
  const u = new URL("https://example.test/api/mobile/authorize");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

describe("GET /api/mobile/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppOrigin.mockReturnValue("https://example.test");
    mockAuth.mockResolvedValue({ user: { id: "11111111-1111-1111-1111-111111111111" } });
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockWithUserTenantRls.mockImplementation(
      async (_u: string, fn: (tenantId: string) => unknown) =>
        fn("22222222-2222-2222-2222-222222222222"),
    );
    mockRequireRecentSession.mockResolvedValue(null);
    mockMobileBridgeCodeCreate.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000003" });
  });

  it("redirects to the canonical Universal-Link with code+state on a valid request", async () => {
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(u.origin).toBe("https://example.test");
    expect(u.pathname).toBe("/api/mobile/authorize/redirect");
    expect(u.searchParams.get("code")).toBe("f".repeat(64));
    expect(u.searchParams.get("state")).toBe(VALID.state);
    expect(mockMobileBridgeCodeCreate).toHaveBeenCalledTimes(1);
    expect(mockMobileBridgeCodeCreate.mock.calls[0][0].data).toMatchObject({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      state: VALID.state,
      codeChallenge: VALID.code_challenge,
      deviceJkt: VALID.device_jkt,
    });
  });

  it("returns 401 when no Auth.js session is present", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(401);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when session step-up is required", async () => {
    mockRequireRecentSession.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));

    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(403);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when client_kind is missing", async () => {
    const params = { ...VALID, client_kind: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when client_kind is not 'ios'", async () => {
    const res = await GET(
      createRequest("GET", buildUrl({ ...VALID, client_kind: "android" })),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when state is missing", async () => {
    const params = { ...VALID, state: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when code_challenge is missing", async () => {
    const params = { ...VALID, code_challenge: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when device_jkt is missing", async () => {
    const params = { ...VALID, device_jkt: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when device_jkt is not exactly 43 base64url chars (C6 shape gate)", async () => {
    const res = await GET(createRequest("GET", buildUrl({ ...VALID, device_jkt: "tooshort" })));
    expect(res.status).toBe(400);
  });

  it("returns 400 when state is not base64url", async () => {
    const res = await GET(
      createRequest("GET", buildUrl({ ...VALID, state: "has spaces!@#" })),
    );
    expect(res.status).toBe(400);
  });

  it("ignores attacker-supplied redirect_uri query parameter", async () => {
    // Append a redirect_uri to the request URL.
    const u = new URL(buildUrl(VALID));
    u.searchParams.set("redirect_uri", "https://attacker.example/steal");
    const res = await GET(createRequest("GET", u.toString()));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("https://example.test/api/mobile/authorize/redirect")).toBe(true);
    expect(loc).not.toContain("attacker.example");
  });

  it("propagates a tenant-resolution failure as a 500 (no row written)", async () => {
    mockWithUserTenantRls.mockRejectedValueOnce(new Error("TENANT_NOT_RESOLVED"));
    await expect(GET(createRequest("GET", buildUrl(VALID)))).rejects.toThrow(
      "TENANT_NOT_RESOLVED",
    );
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });
});
