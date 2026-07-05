import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockTenantMember,
  mockUser,
  mockScimExternalMapping,
  mockWithTenantRls,
  applyTxHolder,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTenantMember: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  mockUser: { findUnique: vi.fn(), create: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  // Holds the rich POST tx (formerly the inner prisma.$transaction tx, now the
  // withTenantRls callback's tx directly), or a rejection to simulate a DB
  // constraint violation surfacing from the tx.
  applyTxHolder: { current: null as Record<string, unknown> | null, reject: null as unknown },
  mockWithTenantRls: vi.fn(),
}));

// withTenantRls now runs the POST body directly on its callback tx (the inner
// prisma.$transaction fold was removed). Route the test-configured rich tx (or
// rejection) through it; GET callbacks fall back to the top-level prisma mock.
mockWithTenantRls.mockImplementation(async (prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => {
  if (applyTxHolder.reject) throw applyTxHolder.reject;
  return fn(applyTxHolder.current ?? prisma);
});

vi.mock("@/lib/auth/tokens/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: null, userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockTenantMember,
    user: mockUser,
    scimExternalMapping: mockScimExternalMapping,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

function makeReq(options: { searchParams?: Record<string, string>; body?: unknown } = {}) {
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
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    applyTxHolder.current = null;
    applyTxHolder.reject = null;
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns tenant users", async () => {
    mockTenantMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      },
    ]);
    mockTenantMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].userName).toBe("test@example.com");
    expect(body.Resources[0].active).toBe(true);
  });

  it("filters by externalId", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue({ internalId: "user-1" });
    mockTenantMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "ext@example.com", name: "Ext" },
      },
    ]);
    mockTenantMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([{ internalId: "user-1", externalId: "ext-1" }]);

    const res = await GET(makeReq({ searchParams: { filter: 'externalId eq "ext-1"' } }));
    expect(res.status).toBe(200);
    expect(mockScimExternalMapping.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        externalId: "ext-1",
        resourceType: "User",
      },
    });
  });

  it("returns 400 for unsupported OR externalId filter", async () => {
    const res = await GET(
      makeReq({ searchParams: { filter: 'externalId eq "ext-1" or userName eq "u@example.com"' } }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid filter syntax", async () => {
    const res = await GET(makeReq({ searchParams: { filter: 'userName eq "bad" and' } }));
    expect(res.status).toBe(400);
  });

  it("returns 401 when SCIM token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 429 when GET is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    const res = await GET(makeReq());
    expect(res.status).toBe(429);
  });

  it("returns an empty list when externalId mapping is not found", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq({ searchParams: { filter: 'externalId eq "missing"' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ totalResults: 0, Resources: [] }),
    );
    expect(mockTenantMember.findMany).not.toHaveBeenCalled();
  });

  it("applies startIndex and count bounds", async () => {
    mockTenantMember.findMany.mockResolvedValue([]);
    mockTenantMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq({ searchParams: { startIndex: "0", count: "999" } }));
    expect(res.status).toBe(200);
    expect(mockTenantMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
  });

  it("includes externalId mappings in resources", async () => {
    mockTenantMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: new Date("2025-01-01T00:00:00.000Z"),
        user: { id: "user-1", email: "mapped@example.com", name: "Mapped" },
      },
    ]);
    mockTenantMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([{ internalId: "user-1", externalId: "ext-1" }]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.Resources[0]).toEqual(
      expect.objectContaining({ externalId: "ext-1", active: false }),
    );
  });
});

describe("POST /api/scim/v2/Users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    applyTxHolder.current = null;
    applyTxHolder.reject = null;
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("creates tenant member", async () => {
    applyTxHolder.current = {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "new-user", tenantId: "tenant-1", email: "new@example.com", name: "New" }),
      },
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "tm1", deactivatedAt: null }),
      },
      scimExternalMapping: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
          name: { formatted: "New" },
          externalId: "ext-1",
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_CREATE" }));
  });

  it("returns 409 when user already exists in tenant", async () => {
    applyTxHolder.current = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", tenantId: "tenant-1", email: "dup@example.com" }) },
      tenantMember: { findUnique: vi.fn().mockResolvedValue({ id: "tm1" }) },
    };

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

  it("returns 400 for invalid JSON on POST", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 409 when externalId is already mapped to another user", async () => {
    applyTxHolder.current = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", tenantId: "tenant-1", email: "dup@example.com", name: "Dup" }) },
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "tm1", deactivatedAt: null }),
      },
      scimExternalMapping: {
        findFirst: vi.fn().mockResolvedValue({
          tenantId: "tenant-1",
          externalId: "ext-1",
          internalId: "other-user",
          resourceType: "User",
        }),
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "dup@example.com",
          externalId: "ext-1",
        },
      }),
    );

    expect(res.status).toBe(409);
  });

  it("returns 401 when SCIM token validation fails on POST", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
        },
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 429 when POST is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
        },
      }),
    );

    expect(res.status).toBe(429);
  });

  it("returns 400 for schema validation failures on POST", async () => {
    const res = await POST(
      makeReq({
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"] },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("creates a deactivated member when active is false", async () => {
    let createdMemberData: Record<string, unknown> | undefined;
    applyTxHolder.current = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "user-1", tenantId: "tenant-1", email: "inactive@example.com", name: "Inactive" }),
      },
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          createdMemberData = data;
          return { id: "tm1", deactivatedAt: data.deactivatedAt };
        }),
      },
      scimExternalMapping: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "inactive@example.com",
          active: false,
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(createdMemberData?.deactivatedAt).toBeInstanceOf(Date);
  });

  it("reuses an existing externalId mapping for the same user", async () => {
    const deleteMany = vi.fn();
    const create = vi.fn();
    applyTxHolder.current = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", tenantId: "tenant-1", email: "same@example.com", name: "Same" }) },
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "tm1", deactivatedAt: null }),
      },
      scimExternalMapping: {
        findFirst: vi.fn().mockResolvedValue({
          tenantId: "tenant-1",
          externalId: "ext-1",
          internalId: "user-1",
          resourceType: "User",
        }),
        deleteMany,
        create,
      },
    };

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "same@example.com",
          externalId: "ext-1",
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 409 for global email uniqueness conflicts", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
    });
    applyTxHolder.reject = error;

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "conflict@example.com",
        },
      }),
    );

    expect(res.status).toBe(409);
  });

  it("returns 409 for externalId unique constraint errors", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
      meta: { modelName: "ScimExternalMapping" },
    });
    applyTxHolder.reject = error;

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "mapped@example.com",
          externalId: "ext-1",
        },
      }),
    );

    expect(res.status).toBe(409);
  });
});
