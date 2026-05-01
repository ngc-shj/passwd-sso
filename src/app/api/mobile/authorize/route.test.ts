import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockMobileBridgeCodeCreate,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockGetAppOrigin,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMobileBridgeCodeCreate: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockWithUserTenantRls: vi.fn(
    async (_u: string, fn: (tenantId: string) => unknown) =>
      fn("22222222-2222-2222-2222-222222222222"),
  ),
  mockGetAppOrigin: vi.fn(() => "https://example.test"),
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

import { GET } from "./route";

const VALID = {
  client_kind: "ios",
  state: "Vp8XR_zg2v9MhUv8tRgHqf-RJfuJ_kqJUYHOG-WEyT0",
  code_challenge: "Z9wHNpVlwKmGM57J7TmKEXJlhhPYiqVdNNgF1MIv7DM",
  device_pubkey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhVc7n3kP4cFE_UxRIm2Ki5FNpYlF1JKoYJYgTEbZBuDKaW6BBwQuP-y_3R5_uA0iJZ-vQGRT-rqr_MQ7H4cQ-A",
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
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: () => unknown) => fn());
    mockWithUserTenantRls.mockImplementation(
      async (_u: string, fn: (tenantId: string) => unknown) =>
        fn("22222222-2222-2222-2222-222222222222"),
    );
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
      devicePubkey: VALID.device_pubkey,
    });
  });

  it("returns 401 when no Auth.js session is present", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(401);
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

  it("returns 400 when device_pubkey is missing", async () => {
    const params = { ...VALID, device_pubkey: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
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
