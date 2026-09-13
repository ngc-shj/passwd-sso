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
  mockGuardUser,
  mockGuardMember,
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
  // The cross-tenant guard's own reads. It runs BEFORE the tenant context, on
  // its own client, so handing it the shared prisma mock would consume from the
  // sequences the POST cells depend on. Defaults: the email resolves to nobody,
  // and nobody is active anywhere else.
  mockGuardUser: { findUnique: vi.fn(), findMany: vi.fn() },
  mockGuardMember: { findMany: vi.fn(), count: vi.fn() },
}));

// The bypass seam: the POST guard's reads and the GET list both run through it.
const { mockRealignAfterActivation, mockLoggerError } = vi.hoisted(() => ({
  mockRealignAfterActivation: vi.fn(),
  mockLoggerError: vi.fn(),
}));

const { mockWithBypassRls } = vi.hoisted(() => ({
  mockWithBypassRls: vi.fn((_prisma: unknown, fn: (tx: unknown) => unknown) =>
    fn({ user: mockGuardUser, tenantMember: mockGuardMember, scimExternalMapping: mockScimExternalMapping })),
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
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  getLogger: () => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/tenant/tenant-realignment", () => ({
  realignAfterActivation: mockRealignAfterActivation,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from "./route";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

/** An existing user as the ownership read selects them: column plus relevant memberships. */
function ownedUser(id: string, email: string) {
  return { id, email, tenantId: "tenant-1", tenantMemberships: [] };
}
function foreignUser(
  id: string,
  email: string,
  tenantMemberships: Array<{ tenantId: string; deactivatedAt: Date | null }> = [],
) {
  return { id, email, tenantId: "other-tenant", tenantMemberships };
}

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
    // Guard defaults: the email resolves to nobody, and nobody is active
    // elsewhere. Cells that exercise the guard override these.
    mockGuardUser.findUnique.mockResolvedValue(null);
    mockGuardMember.findMany.mockResolvedValue([]);
    applyTxHolder.reject = null;
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns tenant users", async () => {
    mockGuardMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      },
    ]);
    mockGuardMember.count.mockResolvedValue(1);
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
    mockGuardMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "ext@example.com", name: "Ext" },
      },
    ]);
    mockGuardMember.count.mockResolvedValue(1);
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
    expect(mockGuardMember.findMany).not.toHaveBeenCalled();
  });

  it("applies startIndex and count bounds", async () => {
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq({ searchParams: { startIndex: "0", count: "999" } }));
    expect(res.status).toBe(200);
    expect(mockGuardMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
  });

  it("includes externalId mappings in resources", async () => {
    mockGuardMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: new Date("2025-01-01T00:00:00.000Z"),
        user: { id: "user-1", email: "mapped@example.com", name: "Mapped" },
      },
    ]);
    mockGuardMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([{ internalId: "user-1", externalId: "ext-1" }]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.Resources[0]).toEqual(
      expect.objectContaining({ externalId: "ext-1", active: false }),
    );
  });

  it("lists under a bypass with every condition ANDed under the token's tenant", async () => {
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMember.count.mockResolvedValue(0);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq({ searchParams: { filter: 'userName eq "u@example.com"' } }));
    expect(res.status).toBe(200);
    const { where } = mockGuardMember.findMany.mock.calls[0][0];
    expect(where.AND[0]).toEqual({ tenantId: "tenant-1" });
    expect(where.AND).toContainEqual({
      user: { is: { email: { equals: "u@example.com", mode: "insensitive" } } },
    });
    expect(mockGuardMember.count).toHaveBeenCalledWith({ where });
    expect(mockWithTenantRls).not.toHaveBeenCalled();
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
    );
  });
});

describe("POST /api/scim/v2/Users", () => {
  // The users the ownership read finds. Both that read and the resource read-back
  // go through the bypass seam's `user.findMany`; the query tells them apart.
  let existingUsers: Array<Record<string, unknown>> = [];
  const postReq = (userName: string, extra: Record<string, unknown> = {}) =>
    makeReq({
      body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, ...extra },
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    applyTxHolder.current = null;
    // Guard defaults: the email names no existing user, and nobody is active
    // elsewhere. Cells that exercise the guards override these.
    existingUsers = [];
    mockGuardMember.findMany.mockResolvedValue([]);
    applyTxHolder.reject = null;
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // The created resource is read back after the tenant context closes.
    mockGuardUser.findMany.mockImplementation(
      async ({ where }: { where: { email?: unknown; id?: { in: string[] } } }) =>
        where.email
          ? existingUsers
          : (where.id?.in ?? []).map((id) => ({ id, email: `${id}@example.com`, name: null, image: null })),
    );
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("refuses to provision a user who is already active in another tenant", async () => {
    existingUsers = [
      foreignUser("user-elsewhere", "elsewhere@example.com", [{ tenantId: "other-tenant", deactivatedAt: null }]),
    ];

    const res = await POST(postReq("elsewhere@example.com"));

    expect(res.status).toBe(409);
    // Nothing was provisioned: the tenant context never opened.
    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("attaches an existing user this tenant owns, without creating another, and realigns after the commit", async () => {
    existingUsers = [ownedUser("user-here", "here@example.com")];
    const userCreate = vi.fn();
    applyTxHolder.current = {
      user: { create: userCreate },
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "tm-here", role: "MEMBER", deactivatedAt: null }),
      },
      scimExternalMapping: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), deleteMany: vi.fn() },
    };

    const res = await POST(postReq("here@example.com"));

    expect(res.status).toBe(201);
    expect(userCreate).not.toHaveBeenCalled();
    expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-here", "tenant-1");
  });

  it("refuses a user another tenant owns although they are active nowhere, before any tenant write", async () => {
    // Round-5 S1: "active nowhere else" is uniqueness, not authority. Attaching
    // this user and realigning them handed a released user's tenancy to whichever
    // tenant named their email first.
    existingUsers = [foreignUser("user-moved", "moved@example.com")];

    const res = await POST(postReq("moved@example.com"));

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("managed by another organization");
    expect(mockWithTenantRls).not.toHaveBeenCalled();
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("answers the existing-member 409 for a foreign user who already holds a membership here", async () => {
    existingUsers = [
      foreignUser("user-moved", "moved@example.com", [{ tenantId: "tenant-1", deactivatedAt: new Date("2025-01-01") }]),
    ];

    const res = await POST(postReq("moved@example.com"));

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("already exists in this tenant");
    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("refuses to choose between existing users whose emails differ only in case", async () => {
    existingUsers = [ownedUser("user-a", "Same@example.com"), ownedUser("user-b", "same@EXAMPLE.com")];

    const res = await POST(postReq("same@example.com"));

    expect(res.status).toBe(409);
    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("does not refuse an inactive provision on the second-active-membership guard", async () => {
    // F4: PUT's predicate. A membership created inactive cannot become a second
    // active one, so the guard's answer does not apply to it.
    existingUsers = [ownedUser("user-1", "inactive@example.com")];
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "other-tenant" }]);
    applyTxHolder.current = {
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({ id: "tm1", deactivatedAt: data.deactivatedAt })),
      },
      scimExternalMapping: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), deleteMany: vi.fn() },
    };

    const inactive = await POST(postReq("inactive@example.com", { active: false }));
    expect(inactive.status).toBe(201);

    // The deny side: the same user provisioned active is still refused.
    const active = await POST(postReq("inactive@example.com"));
    expect(active.status).toBe(409);
  });

  it("answers 201 and logs when the realignment after a committed provision fails", async () => {
    existingUsers = [ownedUser("user-moved", "moved@example.com")];
    mockRealignAfterActivation.mockRejectedValue(new Error("bypass unavailable"));
    applyTxHolder.current = {
      tenantMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "tm-moved", deactivatedAt: null }),
      },
      scimExternalMapping: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), deleteMany: vi.fn() },
    };

    const res = await POST(postReq("moved@example.com"));

    expect(res.status).toBe(201);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-moved" }),
      "scim.realign-failed",
    );
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
    // A user this request created is filed under this tenant already.
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("returns 409 when user already exists in tenant", async () => {
    existingUsers = [ownedUser("user-1", "dup@example.com")];
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
    existingUsers = [ownedUser("user-1", "dup@example.com")];
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
    existingUsers = [ownedUser("user-1", "inactive@example.com")];
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
    // Nothing was activated, so nothing is realigned.
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("reuses an existing externalId mapping for the same user", async () => {
    existingUsers = [ownedUser("user-1", "same@example.com")];
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
