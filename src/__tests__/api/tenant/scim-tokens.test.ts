import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse, createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockScimTokenCount,
  mockScimTokenCreate,
  mockScimTokenFindMany,
  mockScimTokenFindUnique,
  mockScimTokenUpdate,
  mockDispatchTenantWebhook,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockScimTokenCount: vi.fn(),
  mockScimTokenCreate: vi.fn(),
  mockScimTokenFindMany: vi.fn(),
  mockScimTokenFindUnique: vi.fn(),
  mockScimTokenUpdate: vi.fn(),
  mockDispatchTenantWebhook: vi.fn(),
  mockRateLimitCheck: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })) }));
vi.mock("@/lib/auth/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimToken: {
      count: mockScimTokenCount,
      create: mockScimTokenCreate,
      findMany: mockScimTokenFindMany,
      findUnique: mockScimTokenFindUnique,
      update: mockScimTokenUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: { SCIM_MANAGE: "SCIM_MANAGE" },
}));
vi.mock("@/lib/scim/token-utils", () => ({
  generateScimToken: () => "plain-scim-token-value",
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hash:${t}`,
}));
vi.mock("@/lib/api-response", () => ({
  unauthorized: () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }),
  errorResponse: (msg: string, status: number, extra?: unknown) =>
    new Response(JSON.stringify({ error: msg, ...extra }), { status }),
  notFound: () => new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 }),
}));

import { GET, POST } from "@/app/api/tenant/scim-tokens/route";
import { DELETE } from "@/app/api/tenant/scim-tokens/[tokenId]/route";
import { MS_PER_DAY } from "@/lib/constants/time";

const ACTOR = { tenantId: "tenant-abc", role: "ADMIN" };
const TOKEN_ID = "scim-token-id-001";

const makeToken = (overrides: Record<string, unknown> = {}) => ({
  id: TOKEN_ID,
  tenantId: "tenant-abc",
  description: "CI token",
  createdAt: new Date("2025-01-01"),
  lastUsedAt: null,
  expiresAt: new Date(Date.now() + 365 * MS_PER_DAY),
  revokedAt: null,
  tokenHash: "hash:plain-scim-token-value",
  createdById: DEFAULT_SESSION.user.id,
  ...overrides,
});

describe("GET /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/scim-tokens");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 200 with token list", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const token = makeToken();
    mockScimTokenFindMany.mockResolvedValue([
      {
        id: token.id,
        description: token.description,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        createdBy: { id: DEFAULT_SESSION.user.id, name: "Test User", email: "user@example.com" },
      },
    ]);
    const req = createRequest("GET", "http://localhost/api/tenant/scim-tokens");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json[0].id).toBe(TOKEN_ID);
  });
});

describe("POST /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
      body: {},
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 409 when token limit is exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenCount.mockResolvedValue(10);
    const req = createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
      body: {},
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(409);
  });

  it("returns 201 with token on success", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenCount.mockResolvedValue(0);
    const token = makeToken();
    mockScimTokenCreate.mockResolvedValue(token);

    const req = createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
      body: { description: "CI token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe(TOKEN_ID);
    expect(json.token).toBe("plain-scim-token-value");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_TOKEN_CREATE",
        tenantId: "tenant-abc",
      }),
    );
  });

  it("does not dispatch tenant webhook when token limit is exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenCount.mockResolvedValue(10);

    const req = createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
      body: {},
    });
    await POST(req);

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tenant/scim-tokens/[tokenId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("DELETE", `http://localhost/api/tenant/scim-tokens/${TOKEN_ID}`);
    const res = await DELETE(req, createParams({ tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 for non-existent token", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenFindUnique.mockResolvedValue(null);

    const req = createRequest("DELETE", `http://localhost/api/tenant/scim-tokens/${TOKEN_ID}`);
    const res = await DELETE(req, createParams({ tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 409 when token is already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenFindUnique.mockResolvedValue(
      makeToken({ revokedAt: new Date() }),
    );

    const req = createRequest("DELETE", `http://localhost/api/tenant/scim-tokens/${TOKEN_ID}`);
    const res = await DELETE(req, createParams({ tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(409);
  });

  it("returns 200 on successful revoke", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenFindUnique.mockResolvedValue(makeToken());
    mockScimTokenUpdate.mockResolvedValue(makeToken({ revokedAt: new Date() }));

    const req = createRequest("DELETE", `http://localhost/api/tenant/scim-tokens/${TOKEN_ID}`);
    const res = await DELETE(req, createParams({ tokenId: TOKEN_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
  });

  it("does not dispatch tenant webhook when token is already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockScimTokenFindUnique.mockResolvedValue(
      makeToken({ revokedAt: new Date() }),
    );

    const req = createRequest("DELETE", `http://localhost/api/tenant/scim-tokens/${TOKEN_ID}`);
    await DELETE(req, createParams({ tokenId: TOKEN_ID }));

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });
});
