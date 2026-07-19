import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";
const OTHER_CNF_JKT  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc";

const {
  mockValidateExtensionToken,
  mockWithBypassRls,
  mockRateLimitCheck,
  mockCreateRateLimiter,
  mockLogAuditAsync,
  mockTokenUpdateMany,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => {
  const mockRateLimitCheck = vi.fn();
  return {
    mockValidateExtensionToken: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockRateLimitCheck,
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimitCheck, clear: vi.fn() })),
    mockLogAuditAsync: vi.fn(),
    mockTokenUpdateMany: vi.fn(),
    // Tenant IP-restriction gate — allow by default (null = pass).
    mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE" },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: vi.fn(() => ({ scope: "personal", userId: "user-1" })),
  // Required so emitRateLimitFailClosed (rate-limit-audit.ts, real module
  // in-path per S) doesn't throw inside the mock module on the redisErrored
  // 503 branch.
  tenantAuditBase: vi.fn((_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "1.2.3.4",
    userAgent: "test",
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: { updateMany: mockTokenUpdateMany },
  },
}));

import { POST } from "@/app/api/extension/key/reset/route";

const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimitCheck;
};

const VALIDATED_TOKEN = {
  tokenId: "token-id-1",
  userId: "user-1",
  tenantId: "tenant-1",
  scopes: ["extension:read"],
  familyId: "family-1",
  familyCreatedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  cnfJkt: VALID_CNF_JKT,
};

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return createRequest(
    "POST",
    "http://localhost:3000/api/extension/key/reset",
    {
      body,
      headers: {
        "authorization": "Bearer test-token",
        "dpop": "test-dpop-proof",
        ...headers,
      },
    },
  );
}

describe("POST /api/extension/key/reset (C12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExtensionToken.mockResolvedValue({ ok: true, data: VALIDATED_TOKEN });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockLogAuditAsync.mockResolvedValue(undefined);
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: (tx: unknown) => unknown) =>
        fn({ extensionToken: { updateMany: mockTokenUpdateMany } }),
    );
    mockTokenUpdateMany.mockResolvedValue({ count: 2 });
  });

  it("returns 200 with revoked count when valid Bearer+DPoP+matching cnfJkt", async () => {
    const req = makeReq({ cnfJkt: VALID_CNF_JKT });

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.revoked).toBe(2);

    // updateMany must target userId + cnfJkt
    expect(mockTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          cnfJkt: VALID_CNF_JKT,
          revokedAt: null,
        }),
      }),
    );

    // Audit must carry reason + fingerprint
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: "user_key_reset",
          cnfJktFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          rowsRevoked: 2,
        }),
      }),
    );
  });

  it("S3: returns the tenant access-restriction denial and does not revoke when IP is blocked", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValueOnce(
      NextResponse.json({ error: { code: "ACCESS_DENIED" } }, { status: 403 }),
    );

    const req = makeReq({ cnfJkt: VALID_CNF_JKT });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "tenant-1",
    );
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 401 when Bearer is missing", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });

    const req = makeReq({ cnfJkt: VALID_CNF_JKT }, { authorization: "" });

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 401 when DPoP is missing (validateExtensionToken rejects)", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
    });

    const req = makeReq({ cnfJkt: VALID_CNF_JKT }, { dpop: "" });

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when body cnfJkt does not match validated token cnfJkt", async () => {
    const req = makeReq({ cnfJkt: OTHER_CNF_JKT });

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_REQUEST");
    // No tokens should be revoked
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("is idempotent — second call returns revoked: 0", async () => {
    // First call — 2 rows revoked
    mockTokenUpdateMany.mockResolvedValueOnce({ count: 2 });
    const req1 = makeReq({ cnfJkt: VALID_CNF_JKT });
    const res1 = await POST(req1);
    const { json: json1 } = await parseResponse(res1);
    expect(json1.revoked).toBe(2);

    // Second call — 0 rows (already revoked)
    mockTokenUpdateMany.mockResolvedValueOnce({ count: 0 });
    const req2 = makeReq({ cnfJkt: VALID_CNF_JKT });
    const res2 = await POST(req2);
    const { status: status2, json: json2 } = await parseResponse(res2);
    expect(status2).toBe(200);
    expect(json2.revoked).toBe(0);
  });

  it("fires rate limit after max calls", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false });

    const req = makeReq({ cnfJkt: VALID_CNF_JKT });
    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(makeReq({ cnfJkt: VALID_CNF_JKT })),
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockTokenUpdateMany],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("negative control — cnfJkt=Y tokens are NOT revoked when call targets cnfJkt=X", async () => {
    // Token validated with cnfJkt=X; body also has cnfJkt=X
    // updateMany is only called with cnfJkt: VALID_CNF_JKT
    const req = makeReq({ cnfJkt: VALID_CNF_JKT });
    await POST(req);

    const call = mockTokenUpdateMany.mock.calls[0][0];
    expect(call.where.cnfJkt).toBe(VALID_CNF_JKT);
    expect(call.where.cnfJkt).not.toBe(OTHER_CNF_JKT);
  });

  it("cross-user safety — userId from validated token, not from request body", async () => {
    // Even if somehow body contained a different userId, updateMany uses
    // userId from the validated token only
    const req = makeReq({ cnfJkt: VALID_CNF_JKT });
    await POST(req);

    const call = mockTokenUpdateMany.mock.calls[0][0];
    // Must use userId from validated.data, not from any client-supplied field
    expect(call.where.userId).toBe("user-1");
    // Cannot be a different user's tokens
    expect(call.where.userId).not.toBe("user-2");
  });

  it("returns 400 when body contains unknown fields (strict mode)", async () => {
    const req = makeReq({ cnfJkt: VALID_CNF_JKT, extra: "field" });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });
});
