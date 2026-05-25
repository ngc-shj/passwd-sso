import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockBridgeCodeCreate,
  mockBridgeCodeFindMany,
  mockBridgeCodeUpdateMany,
  mockUserFindUnique,
  mockCheck,
  mockCheckIpRateLimit,
  mockCheckRateLimitOrFail,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockExtractClientIp,
  mockCheckAccessRestrictionWithAudit,
  mockRequireRecentCurrentAuthMethod,
  mockVerifyDpop,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockBridgeCodeCreate: vi.fn(),
  mockBridgeCodeFindMany: vi.fn(),
  mockBridgeCodeUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockCheckIpRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
  mockCheckAccessRestrictionWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockRequireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
  mockVerifyDpop: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      findMany: mockBridgeCodeFindMany,
      updateMany: mockBridgeCodeUpdateMany,
      create: mockBridgeCodeCreate,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/security/ip-rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "1.2.3.4", userAgent: "test" }),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessRestrictionWithAudit,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));
vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ has: vi.fn(() => false), add: vi.fn() })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "http://localhost:3000/api/extension/bridge-code"),
}));

import { POST } from "./route";
import { __resetAllowlistForTests } from "@/lib/http/cors";

const ALLOWED_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const VERIFIER_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

function makeRequest(): import("next/server").NextRequest {
  return createRequest("POST", "http://localhost:3000/api/extension/bridge-code", {
    headers: { Origin: ALLOWED_ORIGIN, DPoP: "valid-dpop-proof" },
    body: {},
  });
}

describe("POST /api/extension/bridge-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", ALLOWED_ORIGIN);
    __resetAllowlistForTests();
    mockCheck.mockResolvedValue({ allowed: true });
    mockCheckIpRateLimit.mockResolvedValue({ allowed: true });
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockCheckAccessRestrictionWithAudit.mockResolvedValue({ allowed: true });
    mockWithBypassRls.mockImplementation(async (p, fn) => fn(p));
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockBridgeCodeFindMany.mockResolvedValue([]);
    mockBridgeCodeCreate.mockResolvedValue({});
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockVerifyDpop.mockResolvedValue({ ok: true, jkt: VERIFIER_JKT, claims: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAllowlistForTests();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the user record cannot be resolved (deleted user)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when per-user rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // Per-user limit fires after Origin/auth/IP/step-up gates. The IP gate
    // is mocked open via mockCheckRateLimitOrFail; flip the per-user call.
    mockCheckRateLimitOrFail.mockImplementation(async (args: { scope: string }) => {
      if (args.scope === "extension.bridge_code") {
        return new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), {
          status: 429,
        });
      }
      return null;
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 403 when session step-up is required", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireRecentCurrentAuthMethod.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when tenant IP access restriction denies", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheckAccessRestrictionWithAudit.mockResolvedValueOnce({
      allowed: false,
      reason: "ip not in tenant CIDR",
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    expect(mockVerifyDpop).not.toHaveBeenCalled();
  });

  it("issues a bridge code on success and emits an audit log", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json).toMatchObject({
      code: "a".repeat(64),
      expiresAt: expect.any(String),
    });
    expect(json).not.toHaveProperty("token");

    expect(mockBridgeCodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          codeHash: "h".repeat(64),
          tenantId: "tenant-1",
          // cnfJkt is the verifier-returned thumbprint, NOT a body field.
          cnfJkt: VERIFIER_JKT,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXTENSION_BRIDGE_CODE_ISSUE",
        scope: "PERSONAL",
        tenantId: "tenant-1",
      }),
    );
  });

  it("revokes oldest unused codes when BRIDGE_CODE_MAX_ACTIVE is exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockBridgeCodeFindMany.mockResolvedValue([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
    ]);
    await POST(makeRequest());
    expect(mockBridgeCodeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["c1"] } },
      }),
    );
  });
});
