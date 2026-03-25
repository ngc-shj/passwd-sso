import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaScimToken,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockHashToken,
  mockGenerateScimToken,
  mockRateLimitCheck,
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
    mockPrismaScimToken: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockHashToken: vi.fn((t: string) => `hashed:${t}`),
    mockGenerateScimToken: vi.fn(() => "scim_test_plaintext_token"),
    mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { scimToken: mockPrismaScimToken },
}));
vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/scim/token-utils", () => ({
  generateScimToken: mockGenerateScimToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));

import { GET, POST } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR = { id: "membership-1", tenantId: TENANT_ID, userId: "user-1", role: "OWNER" };

describe("GET /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking SCIM_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));

    await expect(
      GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens")),
    ).rejects.toThrow("boom");
  });

  it("returns token list for authorized user", async () => {
    const tokens = [
      { id: "tok-1", description: "CI", createdAt: "2025-01-01", lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null },
    ];
    mockPrismaScimToken.findMany.mockResolvedValue(tokens);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(tokens);
  });
});

describe("POST /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaScimToken.count.mockResolvedValue(0);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking SCIM_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/tenant/scim-tokens", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 409 when token limit is exceeded", async () => {
    mockPrismaScimToken.count.mockResolvedValue(10);
    mockPrismaScimToken.create.mockResolvedValue({
      id: "tok-new",
      description: null,
      expiresAt: null,
      createdAt: new Date(),
    });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(409);
  });

  it("creates token and returns plaintext with 201 and no-store", async () => {
    const created = {
      id: "tok-new",
      description: "CI token",
      expiresAt: new Date("2026-01-01"),
      createdAt: new Date("2025-01-01"),
    };
    mockPrismaScimToken.create.mockResolvedValue(created);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "CI token", expiresInDays: 365 },
      }),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toBe("scim_test_plaintext_token");
    expect(body.id).toBe("tok-new");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "SCIM_TOKEN_CREATE",
      }),
    );
  });

  it("returns 400 for invalid expiresInDays (below minimum)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { expiresInDays: 0 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for expiresInDays exceeding maximum", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { expiresInDays: 3651 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a non-expiring token when expiresInDays is null", async () => {
    mockPrismaScimToken.create.mockResolvedValue({
      id: "tok-never",
      description: "permanent",
      expiresAt: null,
      createdAt: new Date("2025-01-01"),
    });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "permanent", expiresInDays: null },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaScimToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiresAt: null }) }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("rethrows unexpected errors from POST", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));

    await expect(
      POST(
        createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
          body: { description: "test" },
        }),
      ),
    ).rejects.toThrow("boom");
  });
});
