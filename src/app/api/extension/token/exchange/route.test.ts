import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockBridgeCodeUpdateMany,
  mockBridgeCodeFindUnique,
  mockExtensionTokenCreate,
  mockExtensionTokenFindMany,
  mockExtensionTokenUpdateMany,
  mockTransaction,
  mockCheck,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockLogAudit,
  mockWarn,
  mockError,
  mockExtractClientIp,
  mockVerifyDpop,
} = vi.hoisted(() => ({
  mockBridgeCodeUpdateMany: vi.fn(),
  mockBridgeCodeFindUnique: vi.fn(),
  mockExtensionTokenCreate: vi.fn(),
  mockExtensionTokenFindMany: vi.fn(),
  mockExtensionTokenUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
  mockVerifyDpop: vi.fn(),
}));

vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ has: vi.fn(() => false), add: vi.fn() })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "https://localhost:3000/api/extension/token/exchange"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      updateMany: mockBridgeCodeUpdateMany,
      findUnique: mockBridgeCodeFindUnique,
    },
    extensionToken: {
      create: mockExtensionTokenCreate,
      findMany: mockExtensionTokenFindMany,
      updateMany: mockExtensionTokenUpdateMany,
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ extensionTokenIdleTimeoutMinutes: 15 }),
    },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: (ip: string) => ip,
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: mockWarn, error: mockError, info: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn() }),
}));

import { POST } from "./route";

const VALID_CODE = "f".repeat(64);

function makeRequest(body: unknown = { code: VALID_CODE }): import("next/server").NextRequest {
  return createRequest("POST", "http://localhost/api/extension/token/exchange", { body });
}

describe("POST /api/extension/token/exchange", () => {
  const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults that vi.clearAllMocks resets
    mockCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockWithBypassRls.mockImplementation(async (p, fn) => fn(p));
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
    // DPoP proof passes by default
    mockVerifyDpop.mockResolvedValue({ ok: true, claims: {}, jkt: VALID_CNF_JKT });
    // The shared issueExtensionToken helper internally calls $transaction.
    // Provide a default that runs the callback against the mocked Prisma surface.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        extensionToken: {
          findMany: mockExtensionTokenFindMany,
          create: mockExtensionTokenCreate,
          updateMany: mockExtensionTokenUpdateMany,
        },
      }),
    );
    mockExtensionTokenFindMany.mockResolvedValue([]);
    mockExtensionTokenCreate.mockResolvedValue({
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: VALID_CNF_JKT,
    });
  });

  // ── 1. Success path ──
  it("issues a token when the code is valid and unused", async () => {
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: VALID_CNF_JKT,
    });
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json).toMatchObject({
      token: "a".repeat(64),
      expiresAt: expect.any(String),
      scope: ["passwords:read", "vault:unlock-data"],
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXTENSION_TOKEN_EXCHANGE_SUCCESS",
        scope: "PERSONAL",
        userId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
      }),
    );
  });

  // ── 2. Code unknown — fast-fail at SELECT step ──
  it("returns 401 when the code hash does not match any record", async () => {
    mockBridgeCodeFindUnique.mockResolvedValueOnce(null);

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unknown_or_consumed" }),
      expect.any(String),
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
    // No mutation when row missing — CAS not even attempted.
    expect(mockBridgeCodeUpdateMany).not.toHaveBeenCalled();
    // DPoP verifier not invoked when there's no row to bind against.
    expect(mockVerifyDpop).not.toHaveBeenCalled();
  });

  // ── 3. Code already consumed or expired — race-lost at CAS step ──
  it("returns 401 when CAS count=0 (race-lost / already-consumed / expired)", async () => {
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(makeRequest());
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unknown_or_consumed" }),
      expect.any(String),
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ── 5. Malformed request body ──
  it("returns 400 when the request body is malformed (wrong length)", async () => {
    const res = await POST(makeRequest({ code: "tooshort" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "invalid_request" }),
      expect.any(String),
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 400 when the request body has non-hex characters", async () => {
    const res = await POST(makeRequest({ code: "Z".repeat(64) }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ── 6. Rate limit exceeded ──
  it("returns 429 when rate limited (with valid body)", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  // ── 7. Replay protection (2-call sequence) ──
  it("rejects a replayed code: first call succeeds, second call returns 401", async () => {
    mockBridgeCodeFindUnique
      .mockResolvedValueOnce({
        userId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
        scope: "passwords:read",
        cnfJkt: VALID_CNF_JKT,
      })
      // Second call: the row is now consumed — findUnique still returns it,
      // but the CAS predicate `usedAt: null` will exclude it (count=0).
      .mockResolvedValueOnce({
        userId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
        scope: "passwords:read",
        cnfJkt: VALID_CNF_JKT,
      });
    mockBridgeCodeUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());

    expect(first.status).toBe(201);
    expect(second.status).toBe(401);
  });

  // ── MAX_ACTIVE rotation ──
  it("revokes oldest token when MAX_ACTIVE (3) is exceeded via exchange flow", async () => {
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: VALID_CNF_JKT,
    });
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockExtensionTokenFindMany.mockResolvedValueOnce([
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ]);

    await POST(makeRequest());

    expect(mockExtensionTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["t1"] } },
      }),
    );
  });

  // ── Issuance failure (post-consume) ──
  it("emits EXTENSION_TOKEN_EXCHANGE_FAILURE audit when issueExtensionToken throws", async () => {
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
    // Make $transaction throw to simulate issueExtensionToken failure
    mockTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated DB failure during token issuance");
    });

    const res = await POST(makeRequest());
    const { status } = await parseResponse(res);

    expect(status).toBe(500);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXTENSION_TOKEN_EXCHANGE_FAILURE",
        scope: "PERSONAL",
        userId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
        metadata: expect.objectContaining({ reason: "issue_failed" }),
      }),
    );
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "issue_failed" }),
      expect.any(String),
    );
  });

  // ── C5: invalid DPoP MUST NOT consume the bridge code ──
  it("returns 401 on invalid DPoP and does NOT consume the bridge code (no updateMany)", async () => {
    const dpopModule = await import("@/lib/auth/dpop/verify");
    vi.mocked(dpopModule.verifyDpopProof).mockResolvedValueOnce({
      ok: false,
      error: "DPOP_SIG_INVALID",
    });

    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    // SELECT happened, but CAS did NOT — bridge code remains usable.
    expect(mockBridgeCodeFindUnique).toHaveBeenCalledTimes(1);
    expect(mockBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });

  // ── C5: strict schema rejects unknown body fields ──
  it("returns 400 when an unknown field appears in the request body (.strict())", async () => {
    const res = await POST(
      makeRequest({ code: VALID_CODE, unknown: "x" } as Record<string, unknown>),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    const detailsStr = JSON.stringify(json.details);
    expect(detailsStr.toLowerCase()).toContain("unrecognized");
    // No DB lookup happened — strict schema blocks at the boundary.
    expect(mockBridgeCodeFindUnique).not.toHaveBeenCalled();
    expect(mockBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });
});
