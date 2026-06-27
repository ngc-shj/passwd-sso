import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockPrismaOperatorToken,
  mockWithTenantRls,
  mockLogAudit,
  mockHashToken,
  mockRateLimitCheck,
  mockRequireRecentCurrentAuthMethod,
  TenantAuthError,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockPrismaOperatorToken: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    mockWithTenantRls: vi.fn(async (p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p)),
    mockLogAudit: vi.fn(),
    mockHashToken: vi.fn((t: string) => `hashed:${t}`),
    mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockRequireRecentCurrentAuthMethod: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    operatorToken: mockPrismaOperatorToken,
  },
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  tenantAuditBase: vi.fn((_req, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));
// Keep the real checkRateLimitOrFail (so it maps redisErrored → 503) but
// stub the audit emit to a no-op to avoid pulling its transitive deps.
vi.mock("@/lib/security/rate-limit-audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  emitRateLimitFailClosed: vi.fn(),
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));

import { GET, POST } from "./route";

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const ACTOR = {
  id: "membership-1",
  tenantId: TENANT_ID,
  userId: USER_ID,
  role: "OWNER",
};

describe("GET /api/tenant/operator-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockPrismaOperatorToken.findMany.mockResolvedValue([]);
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/operator-tokens"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking OPERATOR_TOKEN_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/operator-tokens"));
    expect(res.status).toBe(403);
  });

  it("returns token list for authorized user", async () => {
    const tokens = [
      {
        id: "tok-1",
        prefix: "op_xxxxx",
        name: "My token",
        scope: "maintenance",
        expiresAt: new Date("2026-12-01"),
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date("2026-04-27"),
        subjectUserId: USER_ID,
        createdByUserId: USER_ID,
        subjectUser: { id: USER_ID, name: "Test User", email: "test@example.com" },
        createdBy: { id: USER_ID, name: "Test User", email: "test@example.com" },
      },
    ];
    mockPrismaOperatorToken.findMany.mockResolvedValue(tokens);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/operator-tokens"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].id).toBe("tok-1");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/operator-tokens"));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/tenant/operator-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockPrismaOperatorToken.count.mockResolvedValue(0);
    mockPrismaOperatorToken.create.mockResolvedValue({
      id: "tok-new",
      prefix: "op_xxxxx",
      name: "Test token",
      scope: "maintenance",
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      createdAt: new Date(),
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking OPERATOR_TOKEN_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 with OPERATOR_TOKEN_STALE_SESSION when session is older than 15 minutes", async () => {
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(
      Response.json(
        { error: "OPERATOR_TOKEN_STALE_SESSION" },
        { status: 403 },
      ),
    );

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("OPERATOR_TOKEN_STALE_SESSION");
  });

  it("returns 400 when body contains subjectUserId (strict schema rejection)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token", subjectUserId: "injected-user-id" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresInDays exceeds maximum (90)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token", expiresInDays: 100 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresInDays is below minimum (1)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token", expiresInDays: 0 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 with OPERATOR_TOKEN_LIMIT_EXCEEDED when active token count >= 50", async () => {
    mockPrismaOperatorToken.count.mockResolvedValue(50);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("OPERATOR_TOKEN_LIMIT_EXCEEDED");
  });

  it("returns 429 when rate limited after auth", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(429);
    expect(mockPrismaOperatorToken.create).not.toHaveBeenCalled();
  });

  it("returns 503 (fail-closed) when the create limiter signals redisErrored", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, redisErrored: true });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Test token" },
      }),
    );
    expect(res.status).toBe(503);
    expect(mockPrismaOperatorToken.create).not.toHaveBeenCalled();
  });

  it("creates token and returns plaintext with 201 and Cache-Control: no-store", async () => {
    const created = {
      id: "tok-new",
      prefix: "op_xxxxx",
      name: "My operator token",
      scope: "maintenance",
      expiresAt: new Date("2026-07-27"),
      createdAt: new Date("2026-04-27"),
    };
    mockPrismaOperatorToken.create.mockResolvedValue(created);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "My operator token", expiresInDays: 30 },
      }),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.id).toBe("tok-new");
    expect(body.prefix).toBe("op_xxxxx");
    expect(typeof body.plaintext).toBe("string");
    // Plaintext must start with op_ prefix
    expect(body.plaintext).toMatch(/^op_[A-Za-z0-9_-]{43}$/);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "OPERATOR_TOKEN_CREATE",
      }),
    );
  });

  it("emits audit OPERATOR_TOKEN_CREATE with tokenId and scope", async () => {
    const created = {
      id: "tok-new",
      prefix: "op_xxxxx",
      name: "My operator token",
      scope: "maintenance",
      expiresAt: new Date("2026-07-27"),
      createdAt: new Date("2026-04-27"),
    };
    mockPrismaOperatorToken.create.mockResolvedValue(created);

    await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "My operator token" },
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "OPERATOR_TOKEN_CREATE",
        metadata: expect.objectContaining({
          tokenId: "tok-new",
          tokenSubjectUserId: USER_ID,
          scope: "maintenance",
        }),
      }),
    );
  });

  it("defaults expiresInDays to 30 when not specified", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/tenant/operator-tokens", {
        body: { name: "Default expiry token" },
      }),
    );

    const createCall = mockPrismaOperatorToken.create.mock.calls[0][0];
    const expiresAt = createCall.data.expiresAt as Date;
    const expectedExpiry = new Date(Date.now() + 30 * 24 * 3600_000);
    // Allow 5 second tolerance
    expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
  });
});
