import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireOrgPermission,
  OrgAuthError,
  mockLogAudit,
  mockScimToken,
  mockOrganization,
  mockHashToken,
} = vi.hoisted(
  () => {
    class _OrgAuthError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "OrgAuthError";
        this.status = status;
      }
    }
    return {
      mockAuth: vi.fn(),
      mockRequireOrgPermission: vi.fn(),
      OrgAuthError: _OrgAuthError,
      mockLogAudit: vi.fn(),
      mockScimToken: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
      mockOrganization: { findUnique: vi.fn() },
      mockHashToken: vi.fn().mockReturnValue("hashed-token"),
    };
  },
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { scimToken: mockScimToken, organization: mockOrganization },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/scim/token-utils", () => ({
  generateScimToken: () => "scim_mock_token_value",
}));

import { GET, POST } from "./route";

function makeParams(orgId: string) {
  return { params: Promise.resolve({ orgId }) };
}

function makeReq(options: { body?: unknown } = {}) {
  const init: RequestInit = { method: options.body ? "POST" : "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest(
    "http://localhost/api/orgs/org-1/scim-tokens",
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

describe("GET /api/orgs/[orgId]/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockOrganization.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 401 if not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeReq(), makeParams("org-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 if no SCIM_MANAGE permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new OrgAuthError("FORBIDDEN", 403),
    );
    const res = await GET(makeReq(), makeParams("org-1"));
    expect(res.status).toBe(403);
  });

  it("returns token list", async () => {
    mockScimToken.findMany.mockResolvedValue([
      {
        id: "t1",
        description: "Test token",
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: { id: "user-1", name: "User", email: "u@example.com" },
      },
    ]);

    const res = await GET(makeReq(), makeParams("org-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].description).toBe("Test token");
  });
});

describe("POST /api/orgs/[orgId]/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockOrganization.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 409 when active token limit is exceeded", async () => {
    mockScimToken.count.mockResolvedValue(10);
    const res = await POST(
      makeReq({ body: { description: "Overflow" } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("SCIM_TOKEN_LIMIT_EXCEEDED");
  });

  it("excludes expired tokens from active count", async () => {
    mockScimToken.count.mockResolvedValue(0);
    mockScimToken.create.mockResolvedValue({
      id: "t-ok",
      description: null,
      expiresAt: null,
      createdAt: new Date(),
    });

    await POST(
      makeReq({ body: { description: "After expired" } }),
      makeParams("org-1"),
    );
    // Verify count query includes expiry filter (OR clause)
    expect(mockScimToken.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          OR: expect.arrayContaining([
            { expiresAt: null },
            { expiresAt: { gt: expect.any(Date) } },
          ]),
        }),
      }),
    );
  });

  it("creates a token and returns plaintext once", async () => {
    mockScimToken.count.mockResolvedValue(0);
    mockScimToken.create.mockResolvedValue({
      id: "t-new",
      description: "My token",
      expiresAt: new Date("2026-06-01"),
      createdAt: new Date(),
    });

    const res = await POST(
      makeReq({ body: { description: "My token", expiresInDays: 365 } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(201);
    // S-22: Verify Cache-Control: no-store on token response
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toBe("scim_mock_token_value");
    expect(body.id).toBe("t-new");
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("returns 400 for expiresInDays exceeding max", async () => {
    const res = await POST(
      makeReq({ body: { expiresInDays: 3651 } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for expiresInDays of zero", async () => {
    const res = await POST(
      makeReq({ body: { expiresInDays: 0 } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      makeReq({ body: { expiresInDays: -1 } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(400);
  });

  it("accepts null expiresInDays (never expires)", async () => {
    mockScimToken.count.mockResolvedValue(0);
    mockScimToken.create.mockResolvedValue({
      id: "t-no-exp",
      description: null,
      expiresAt: null,
      createdAt: new Date(),
    });

    const res = await POST(
      makeReq({ body: { expiresInDays: null } }),
      makeParams("org-1"),
    );
    expect(res.status).toBe(201);
    // Verify expiresAt was set to null
    expect(mockScimToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: null, tenantId: "tenant-1" }),
      }),
    );
  });
});
