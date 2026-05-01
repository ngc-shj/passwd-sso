import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockCheck,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

import { POST, ROLLBACK_REJECTION_KIND } from "./route";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

const VALID_BODY = {
  deviceId: "device-uuid-1",
  expectedCounter: 42,
  observedCounter: 41,
  headerIssuedAt: 1_743_800_000,
  lastSuccessfulRefreshAt: 1_743_799_000,
  rejectionKind: ROLLBACK_REJECTION_KIND.COUNTER_MISMATCH,
};

function makeReq(body: unknown = VALID_BODY) {
  return createRequest("POST", "https://example.test/api/mobile/cache-rollback-report", {
    body,
    headers: {
      authorization: "DPoP access-token-here",
      dpop: "fake.proof",
    },
  });
}

function authOk() {
  return {
    ok: true as const,
    data: {
      tokenId: TOKEN_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      scopes: ["passwords:read"],
      expiresAt: new Date("2099-01-01"),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
    },
  };
}

describe("POST /api/mobile/cache-rollback-report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockValidateExtensionToken.mockResolvedValue(authOk());
  });

  it("emits MOBILE_CACHE_ROLLBACK_REJECTED for counter_mismatch and returns 200", async () => {
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true });
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_CACHE_ROLLBACK_REJECTED",
        userId: USER_ID,
        tenantId: TENANT_ID,
        targetId: TOKEN_ID,
        metadata: expect.objectContaining({
          deviceId: "device-uuid-1",
          rejectionKind: ROLLBACK_REJECTION_KIND.COUNTER_MISMATCH,
        }),
      }),
    );
  });

  it("emits MOBILE_CACHE_FLAG_FORGED when rejectionKind=flag_forged", async () => {
    const res = await POST(
      makeReq({ ...VALID_BODY, rejectionKind: ROLLBACK_REJECTION_KIND.FLAG_FORGED }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_CACHE_FLAG_FORGED",
        metadata: expect.objectContaining({
          rejectionKind: ROLLBACK_REJECTION_KIND.FLAG_FORGED,
        }),
      }),
    );
  });

  it.each(Object.values(ROLLBACK_REJECTION_KIND))(
    "accepts rejectionKind=%s as a valid enum value",
    async (kind) => {
      const res = await POST(makeReq({ ...VALID_BODY, rejectionKind: kind }));
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    },
  );

  it("returns 400 on an unknown rejectionKind", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, rejectionKind: "totally_made_up" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("returns 400 on an unknown body field (Zod strict)", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, extra: "shouldntbehere" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 401 when validateExtensionToken rejects the token", async () => {
    mockValidateExtensionToken.mockResolvedValueOnce({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-(tenantId, deviceId) rate limit is exceeded", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("uses (tenantId, deviceId) as the rate-limit key", async () => {
    await POST(makeReq());
    expect(mockCheck).toHaveBeenCalledWith(
      `rl:mobile_cache_rollback:${TENANT_ID}:${VALID_BODY.deviceId}`,
    );
  });
});
