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
} = vi.hoisted(() => ({
  mockBridgeCodeUpdateMany: vi.fn(),
  mockBridgeCodeFindUnique: vi.fn(),
  mockExtensionTokenCreate: vi.fn(),
  mockExtensionTokenFindMany: vi.fn(),
  mockExtensionTokenUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
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
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/rate-limit", () => ({
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
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/auth/ip-access", () => ({
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults that vi.clearAllMocks resets
    mockCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockWithBypassRls.mockImplementation(async (_p, fn) => fn());
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
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
    });
  });

  // ── 1. Success path ──
  it("issues a token when the code is valid and unused", async () => {
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read,vault:unlock-data",
    });

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

  // ── 2. Code already used (concurrent exchange race) ──
  it("returns 401 when the code is already consumed (count=0)", async () => {
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unknown_or_consumed" }),
      expect.any(String),
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ── 3. Code expired ──
  it("returns 401 when the code is expired (filtered out by expiresAt > now)", async () => {
    // Same path as count=0 — the SQL filter excludes expired codes
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

  // ── 4. Code unknown / hash mismatch ──
  it("returns 401 when the code hash does not match any record", async () => {
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(makeRequest());
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    expect(mockWarn).toHaveBeenCalled();
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
    mockBridgeCodeUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read",
    });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());

    expect(first.status).toBe(201);
    expect(second.status).toBe(401);
  });

  // ── Invariant violation ──
  it("returns 500 if findUnique returns null after a successful UPDATE", async () => {
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockBridgeCodeFindUnique.mockResolvedValueOnce(null);

    const res = await POST(makeRequest());
    const { status } = await parseResponse(res);

    expect(status).toBe(500);
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "extension_token_exchange_invariant_violation",
      }),
      expect.any(String),
    );
    // No userId/tenantId in this branch — pino-only, no logAudit
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ── Issuance failure (post-consume) ──
  it("emits EXTENSION_TOKEN_EXCHANGE_FAILURE audit when issueExtensionToken throws", async () => {
    mockBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      scope: "passwords:read",
    });
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
});
