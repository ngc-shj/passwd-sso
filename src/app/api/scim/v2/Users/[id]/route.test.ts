import { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockTenantMember,
  mockTeamMember,
  mockScimExternalMapping,
  mockTeamMemberKey,
  mockTransaction,
  mockWithTenantRls,
  mockInvalidateUserSessions,
  mockLogger,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTenantMember: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  mockTeamMember: { deleteMany: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  mockTeamMemberKey: { deleteMany: vi.fn() },
  mockTransaction: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: () => unknown) => fn()),
  mockInvalidateUserSessions: vi.fn().mockResolvedValue({ sessions: 1, extensionTokens: 0, apiKeys: 0 }),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: null, userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockTenantMember,
    teamMember: mockTeamMember,
    scimExternalMapping: mockScimExternalMapping,
    teamMemberKey: mockTeamMemberKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/auth/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));
vi.mock("@/lib/auth/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => mockLogger,
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(options: { method?: string; body?: unknown } = {}) {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest("http://localhost/api/scim/v2/Users/user-1", init as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns tenant user resource", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("u@example.com");
    expect(body.active).toBe(true);
  });

  it("returns 404 when user cannot be resolved", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when resolved user has no email resource", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: null, name: "User" },
      });

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(404);
  });

  it("returns 401 when SCIM token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when GET is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(429);
  });
});

describe("PUT /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("deactivates tenant member", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tm1" } }),
    );
  });

  it("returns 403 when deactivating OWNER via PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", deactivatedAt: null });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "owner@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(403);
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 409 when externalId conflicts with another user on PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue({
      tenantId: "tenant-1",
      externalId: "ext-1",
      internalId: "other-user",
      resourceType: "User",
    });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
          externalId: "ext-1",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.detail).toContain("externalId");
  });

  it("sets externalId mapping when provided on PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    mockScimExternalMapping.create.mockResolvedValue({});

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
          externalId: "ext-new",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", internalId: "user-1", resourceType: "User" },
    });
    expect(mockScimExternalMapping.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", externalId: "ext-new", resourceType: "User", internalId: "user-1" },
    });
  });

  it("returns 400 for invalid JSON on PUT", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PUT",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PUT(req, makeParams("user-1"));
    expect(res!.status).toBe(400);
  });

  it("reactivates member and removes external mapping when externalId is omitted", async () => {
    const deactivatedAt = new Date("2024-01-01T00:00:00.000Z");

    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        internalId: "user-1",
        resourceType: "User",
      },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }));
  });

  it("returns 400 for schema validation failures on PUT", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PUT target is missing", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
        },
      }),
      makeParams("missing"),
    );
    expect(res!.status).toBe(404);
  });

  it("returns 429 when PUT is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("returns 409 for unique-constraint failures from mapping create", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("dup", {
              code: "P2002",
              clientVersion: "test",
              meta: { modelName: "ScimExternalMapping" },
            }),
          ),
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          externalId: "ext-1",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
  });

  it("triggers invalidateUserSessions on PUT deactivation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", { tenantId: "tenant-1" });
  });

  it("does NOT trigger invalidateUserSessions on PUT reactivation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }),
      makeParams("user-1"),
    );

    expect(mockInvalidateUserSessions).not.toHaveBeenCalled();
  });

  it("returns 200 and logs error when PUT deactivation invalidation fails", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    mockInvalidateUserSessions.mockRejectedValue(new Error("db error"));

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "session-invalidation-failed",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessionInvalidationFailed: true }),
      }),
    );
  });
});

describe("PATCH /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 400 for unsupported patch operation", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: "active" }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 403 when deactivating OWNER via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", deactivatedAt: null });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(403);
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("updates member state via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm1" },
        data: expect.objectContaining({ scimManaged: true, provisioningSource: "SCIM" }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_DEACTIVATE" }));
  });

  it("returns 400 for invalid JSON on PATCH", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PATCH",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, makeParams("user-1"));
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PATCH target is missing", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("missing"),
    );
    expect(res!.status).toBe(404);
  });

  it("reactivates member via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date("2024-01-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }));
  });

  it("returns 400 for schema validation failures on PATCH", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 429 when PATCH is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("triggers invalidateUserSessions on PATCH deactivation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", { tenantId: "tenant-1" });
  });

  it("does NOT trigger invalidateUserSessions on PATCH reactivation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        },
      }),
      makeParams("user-1"),
    );

    expect(mockInvalidateUserSessions).not.toHaveBeenCalled();
  });

  it("returns 200 and logs error when PATCH deactivation invalidation fails", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "u@example.com", name: "User" },
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockInvalidateUserSessions.mockRejectedValue(new Error("db error"));

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "session-invalidation-failed",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessionInvalidationFailed: true }),
      }),
    );
  });
});

describe("DELETE /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("removes tenant member and related records", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(204);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
  });

  it("returns 403 when deleting OWNER via DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", user: { email: "owner@example.com" } });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when related resources block deletion", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "test",
      }),
    );

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(409);
  });

  it("returns 404 when deleting an unknown user", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("missing"));
    expect(res!.status).toBe(404);
  });

  it("returns 429 when DELETE is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(429);
  });

  it("triggers invalidateUserSessions on SCIM DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockResolvedValue([]);

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", { tenantId: "tenant-1" });
  });

  it("returns 204 even if session invalidation fails on DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockResolvedValue([]);
    mockInvalidateUserSessions.mockRejectedValue(new Error("db error"));

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(204);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "session-invalidation-failed",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessionInvalidationFailed: true }),
      }),
    );
  });

  it("includes invalidation counts in audit metadata on DELETE success", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockResolvedValue([]);
    mockInvalidateUserSessions.mockResolvedValue({ sessions: 2, extensionTokens: 1, apiKeys: 0 });

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0 }),
      }),
    );
  });
});
