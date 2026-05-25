import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

const {
  mockAuth,
  mockRequireRecentCurrentAuthMethod,
  mockRateLimitCheck,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockBridgeCodeFindMany,
  mockBridgeCodeUpdateMany,
  mockBridgeCodeCreate,
  mockUserFindUnique,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireRecentCurrentAuthMethod: vi.fn(),
  mockRateLimitCheck: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockBridgeCodeFindMany: vi.fn(),
  mockBridgeCodeUpdateMany: vi.fn(),
  mockBridgeCodeCreate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })),
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE" },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      findMany: mockBridgeCodeFindMany,
      updateMany: mockBridgeCodeUpdateMany,
      create: mockBridgeCodeCreate,
    },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn(() => ({ scope: "personal", userId: "user-1" })),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: vi.fn(async () => null),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: vi.fn(() => "a".repeat(64)),
  hashToken: vi.fn(() => "hash-abc"),
}));

import { POST } from "@/app/api/extension/bridge-code/route";

describe("POST /api/extension/bridge-code — cnfJkt (C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          extensionBridgeCode: {
            findMany: mockBridgeCodeFindMany,
            updateMany: mockBridgeCodeUpdateMany,
            create: mockBridgeCodeCreate,
          },
        }),
    );
    mockBridgeCodeFindMany.mockResolvedValue([]);
    mockBridgeCodeCreate.mockResolvedValue({});
    mockLogAuditAsync.mockResolvedValue(undefined);
  });

  it("returns 201 with code when valid cnfJkt is provided", async () => {
    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: { cnfJkt: VALID_CNF_JKT } },
    );

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json).toHaveProperty("code");
    expect(json).toHaveProperty("expiresAt");
    // cnfJkt is persisted (create was called with it)
    expect(mockBridgeCodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cnfJkt: VALID_CNF_JKT }),
      }),
    );
  });

  it("returns 400 when cnfJkt is missing", async () => {
    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: {} },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when cnfJkt is too short", async () => {
    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: { cnfJkt: "short" } },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when cnfJkt has invalid characters", async () => {
    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: { cnfJkt: "!".repeat(43) } },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 with unrecognized_keys issue when extra fields are present", async () => {
    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: { cnfJkt: VALID_CNF_JKT, unknown: "x" } },
    );

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    // The response details must reference the unrecognized field, proving
    // .strict() is active (not a generic 400 from some other cause).
    const detailsStr = JSON.stringify(json.details);
    expect(detailsStr.toLowerCase()).toContain("unrecognized");
  });

  it("step-up gate still fires before body parsing", async () => {
    const stepUpResponse = new Response(
      JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
      { status: 403 },
    );
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(stepUpResponse);

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/bridge-code",
      { body: { cnfJkt: VALID_CNF_JKT } },
    );

    const res = await POST(req);

    expect(res.status).toBe(403);
    // Bridge code should NOT have been created
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });
});
