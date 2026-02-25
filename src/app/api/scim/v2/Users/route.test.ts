import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockOrgMember,
  mockUser,
  mockScimExternalMapping,
  mockTransaction,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockOrgMember: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  mockUser: { findUnique: vi.fn(), create: vi.fn() },
  mockScimExternalMapping: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), create: vi.fn() },
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));
vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockOrgMember,
    user: mockUser,
    scimExternalMapping: mockScimExternalMapping,
    $transaction: mockTransaction,
  },
}));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", orgId: "org-1", createdById: "u1", auditUserId: "u1" },
};

function makeReq(
  options: { searchParams?: Record<string, string>; body?: unknown } = {},
) {
  const url = new URL("http://localhost/api/scim/v2/Users");
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = { method: options.body ? "POST" : "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest(url.toString(), init as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/scim/v2/Users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 401 for invalid token", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns list of users with correct SCIM structure", async () => {
    mockOrgMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        orgId: "org-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      },
    ]);
    mockOrgMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].userName).toBe("test@example.com");
  });

  it("passes pagination params correctly", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);
    mockOrgMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    await GET(makeReq({ searchParams: { startIndex: "5", count: "10" } }));

    expect(mockOrgMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 4, take: 10 }),
    );
  });

  it("returns 400 for invalid filter", async () => {
    const res = await GET(
      makeReq({ searchParams: { filter: 'unsupported eq "x"' } }),
    );
    expect(res.status).toBe(400);
  });

  it("removes default deactivatedAt when active filter is inside AND", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);
    mockOrgMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    await GET(
      makeReq({
        searchParams: { filter: 'userName eq "test@example.com" and active eq false' },
      }),
    );

    // The where clause should NOT have deactivatedAt: null at top level
    // since the active filter inside AND controls it
    const callArgs = mockOrgMember.findMany.mock.calls[0][0];
    expect(callArgs.where.deactivatedAt).toBeUndefined();
    expect(callArgs.where.AND).toBeDefined();
  });

  it("removes default deactivatedAt when active filter is inside OR", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);
    mockOrgMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    await GET(
      makeReq({
        searchParams: { filter: 'active eq true or userName eq "test@example.com"' },
      }),
    );

    const callArgs = mockOrgMember.findMany.mock.calls[0][0];
    // Top-level deactivatedAt: null should be removed
    expect(callArgs.where.deactivatedAt).toBeUndefined();
    expect(callArgs.where.OR).toBeDefined();
  });

  it("filters by externalId via ScimExternalMapping", async () => {
    mockScimExternalMapping.findUnique.mockResolvedValue({
      internalId: "user-1",
    });
    mockOrgMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        orgId: "org-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "ext@example.com", name: "Ext" },
      },
    ]);
    mockOrgMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([
      { internalId: "user-1", externalId: "ext-1" },
    ]);

    const res = await GET(
      makeReq({ searchParams: { filter: 'externalId eq "ext-1"' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
  });
});

describe("POST /api/scim/v2/Users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("creates a new user and returns 201", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "new-user",
            email: "new@example.com",
            name: "New User",
          }),
        },
        orgMember: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null) // existence check
            .mockResolvedValueOnce({
              userId: "new-user",
              deactivatedAt: null,
            }), // re-fetch
          create: vi.fn().mockResolvedValue({}),
        },
        scimExternalMapping: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
          name: { formatted: "New User" },
          externalId: "ext-1",
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userName).toBe("new@example.com");
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("normalizes email to lowercase", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const mockUserFindUnique = vi.fn().mockResolvedValue(null);
      const mockUserCreate = vi.fn().mockResolvedValue({
        id: "new-user",
        email: "upper@example.com",
        name: null,
      });
      const tx = {
        user: { findUnique: mockUserFindUnique, create: mockUserCreate },
        orgMember: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ userId: "new-user", deactivatedAt: null }),
          create: vi.fn().mockResolvedValue({}),
        },
        scimExternalMapping: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      const result = await fn(tx);
      // Verify the email was lowercased in the user lookup
      expect(mockUserFindUnique).toHaveBeenCalledWith({
        where: { email: "upper@example.com" },
      });
      return result;
    });

    await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "UPPER@EXAMPLE.COM",
        },
      }),
    );
  });

  it("returns 409 for active duplicate user", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ id: "existing-user", email: "dup@example.com" }),
        },
        orgMember: {
          findUnique: vi.fn().mockResolvedValue({
            id: "m1",
            deactivatedAt: null, // active
          }),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "dup@example.com",
        },
      }),
    );
    expect(res.status).toBe(409);
  });

  it("re-activates a deactivated member", async () => {
    const mockMemberUpdate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ id: "user-1", email: "re@example.com" }),
        },
        orgMember: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({
              id: "m1",
              deactivatedAt: new Date("2024-01-01"),
            })
            .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null }),
          update: mockMemberUpdate,
        },
        scimExternalMapping: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "re@example.com",
          externalId: "ext-re",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deactivatedAt: null, scimManaged: true }),
      }),
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing userName", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when externalId is already mapped to a different user", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "new-user",
            email: "new@example.com",
            name: null,
          }),
        },
        orgMember: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValue({}),
        },
        scimExternalMapping: {
          findUnique: vi.fn().mockResolvedValue({
            internalId: "other-user", // different user
            externalId: "ext-conflict",
          }),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
          externalId: "ext-conflict",
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("externalId");
  });

  it("returns 409 on P2002 race condition for ScimExternalMapping create", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "7.0.0", meta: { modelName: "ScimExternalMapping" } },
    );
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "new-user",
            email: "race@example.com",
            name: null,
          }),
        },
        orgMember: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ userId: "new-user", deactivatedAt: null }),
          create: vi.fn().mockResolvedValue({}),
        },
        scimExternalMapping: {
          findUnique: vi.fn().mockResolvedValue(null), // check passes
          create: vi.fn().mockRejectedValue(p2002),    // but create races
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "race@example.com",
          externalId: "ext-race",
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("externalId");
  });
});
