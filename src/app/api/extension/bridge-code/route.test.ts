import { describe, it, expect, vi, beforeEach } from "vitest";
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
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockExtractClientIp,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockBridgeCodeCreate: vi.fn(),
  mockBridgeCodeFindMany: vi.fn(),
  mockBridgeCodeUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
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

import { POST } from "./route";

function makeRequest(): import("next/server").NextRequest {
  return createRequest("POST", "http://localhost/api/extension/bridge-code", {
    headers: { Origin: "http://localhost" },
  });
}

describe("POST /api/extension/bridge-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockWithBypassRls.mockImplementation(async (_p, fn) => fn());
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockBridgeCodeFindMany.mockResolvedValue([]);
    mockBridgeCodeCreate.mockResolvedValue({});
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

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValueOnce({ allowed: false });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
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
    // Bearer token MUST NOT appear in the response
    expect(json).not.toHaveProperty("token");

    expect(mockBridgeCodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          codeHash: "h".repeat(64),
          tenantId: "tenant-1",
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
