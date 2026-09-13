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
  mockGuardMember,
  mockGuardMapping,
  mockInvalidateUserSessions,
  mockLogger,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTenantMember: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  mockTeamMember: { deleteMany: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  mockTeamMemberKey: { deleteMany: vi.fn() },
  mockTransaction: vi.fn(),
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma)),
  // The reactivation guard's reads live on their OWN client: it resolves the
  // SCIM id and reads the active-membership set in one bypass, and handing it the
  // shared prisma mock would consume from the `mockResolvedValueOnce` sequences
  // the tenant-context cells depend on. `mockGuardMember` is the seam a cell uses
  // to make the guard fire.
  mockGuardMember: { findUnique: vi.fn(), findMany: vi.fn() },
  mockGuardMapping: { findFirst: vi.fn() },
  mockInvalidateUserSessions: vi.fn().mockResolvedValue({ sessions: 1, extensionTokens: 0, apiKeys: 0 }),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockRealignAfterActivation } = vi.hoisted(() => ({ mockRealignAfterActivation: vi.fn() }));

// Identity is read after the tenant context, through the same bypass seam as the guard.
const { mockGuardUser, mockWithBypassRls } = vi.hoisted(() => {
  const mockGuardUser = { findMany: vi.fn(), findUnique: vi.fn() };
  return {
    mockGuardUser,
    mockWithBypassRls: vi.fn((_prisma: unknown, fn: (tx: unknown) => unknown) =>
      fn({ tenantMember: mockGuardMember, scimExternalMapping: mockGuardMapping, user: mockGuardUser })),
  };
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
    teamMember: mockTeamMember,
    scimExternalMapping: mockScimExternalMapping,
    teamMemberKey: mockTeamMemberKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls, withBypassRls: mockWithBypassRls }));
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));
vi.mock("@/lib/tenant/tenant-realignment", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  realignAfterActivation: mockRealignAfterActivation,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => mockLogger,
}));

import { GET, PUT, PATCH, DELETE } from "./route";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1", actorType: "HUMAN" as const },
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
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "u@example.com", name: "User", image: null }]);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("returns tenant user resource", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("u@example.com");
    expect(body.active).toBe(true);
  });

  it("builds the resource from identity read after the tenant context, not through the relation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "moved@example.com", name: "Moved", image: null }]);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).userName).toBe("moved@example.com");
    const snapshotRead = mockTenantMember.findUnique.mock.calls[1][0];
    expect(snapshotRead).not.toHaveProperty("include");
    expect(snapshotRead.select).toEqual({ userId: true, deactivatedAt: true });
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
    );
  });

  it("returns 404 when user cannot be resolved", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when resolved user has no email resource", async () => {
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: null, name: "User", image: null }]);
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
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
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(429);
  });
});

describe("PUT /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "u@example.com", name: "User", image: null }]);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("deactivates tenant member", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
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
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("refuses PUT reactivation when the user is active in another tenant", async () => {
    // The guard the CREATE path has always had and the reactivation arms did
    // not. Reachable by a holder of THIS tenant's SCIM token — a principal with
    // no authority in the tenant the user actually belongs to. Two active
    // memberships makes `resolveUserTenantIdFromClient` throw, and the proxy
    // auth gate calls it on every request, so the effect is that this tenant can
    // invalidate every session of a user who belongs to another.
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "other-tenant" }]);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(409);
    // Positive: nothing was written. A 409 with the update already applied would
    // be the same status and the opposite outcome.
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("allows PUT reactivation when the user's only active membership is this tenant", async () => {
    // The allow half. Without it the guard is indistinguishable from one that
    // refuses every reactivation.
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "tenant-1" }]);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    // Wired here, not inherited: `vi.clearAllMocks()` clears calls, not
    // implementations, so a cell that relied on a sibling's `$transaction` stub
    // passed in file order and failed alone. Measured on both of these.
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
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalled();
  });

  it("answers 200 and logs when the realignment after a committed reactivation fails", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
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
    mockRealignAfterActivation.mockRejectedValue(new Error("bypass unavailable"));

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      "scim.realign-failed",
    );
  });

  it("does not refuse a DEACTIVATING PUT even with an active membership elsewhere", async () => {
    // The boundary: the guard is on the TRANSITION, not on the state. A request
    // that deactivates cannot add a second active membership, and refusing it
    // would block the very operation that repairs the condition.
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: new Date() });
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "other-tenant" }]);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    // Wired here, not inherited: `vi.clearAllMocks()` clears calls, not
    // implementations, so a cell that relied on a sibling's `$transaction` stub
    // passed in file order and failed alone. Measured on both of these.
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
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalled();
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
    // After the commit: this tenant's context cannot write a users row filed elsewhere.
    expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-1", "tenant-1", {
      source: "scim",
      actorUserId: "u1",
      actorType: "HUMAN",
    });
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
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
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

  // L2 — SCIM deactivation fail-open backstop.
  // When invalidateUserSessions throws, the handler logs + returns 200 (fail-open:
  // existing sessions/tokens are NOT revoked in that window). This is safe ONLY
  // because the deactivation itself is committed (tenantMember.update with
  // deactivatedAt) BEFORE the invalidation attempt, and every long-lived
  // user-bound token validator independently re-checks tenantMember.deactivatedAt
  // and fails closed — see the "SCIM fail-open backstop" tests in
  // api-key.test.ts, extension-token.test.ts (C13a), oauth-server.test.ts (C13a).
  // This test pins the producer half: the fail-open path still persists the
  // deactivation the backstop depends on.
  it("returns 200, persists deactivation, and logs error when PUT invalidation fails (fail-open backstop)", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
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
    // The deactivation IS committed even though invalidation failed — this is the
    // state the validator backstop reads to reject the un-revoked token next time.
    expect(mockTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tm1" } }),
    );
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
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "u@example.com", name: "User", image: null }]);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
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

  it("refuses PATCH reactivation when the user is active in another tenant", async () => {
    // The PUT twin got three cells and this one got none — deleting the whole
    // PATCH guard block left the entire suite green (measured). Same twin-drift
    // shape the round itself was reviewing.
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "other-tenant" }]);

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

    expect(res!.status).toBe(409);
    // Nothing was written. A 409 with the update already applied is the same
    // status and the opposite outcome.
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("does not refuse a name-only PATCH, which cannot reactivate", async () => {
    // The boundary PUT and PATCH do NOT share. `patchScimUser` touches
    // `deactivatedAt` only when `operations.active !== undefined`, so a
    // display-name PATCH performs no transition — gating it on `!== false`
    // (PUT's predicate) 409'd it. PUT's schema defaults `active` to true and
    // writes unconditionally, so `!== false` is correct there and wrong here.
    mockGuardMember.findMany.mockResolvedValue([{ tenantId: "other-tenant" }]);
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date("2024-01-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date("2024-01-01T00:00:00.000Z"),
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "name.formatted", value: "Renamed" }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    // No transition, so nothing to realign.
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("reactivates member via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date("2024-01-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
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
    expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-1", "tenant-1", {
      source: "scim",
      actorUserId: "u1",
      actorType: "HUMAN",
    });
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
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
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
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "u@example.com", name: "User", image: null }]);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("removes tenant member and related records", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(204);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
  });

  it("returns 403 when deleting OWNER via DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER" });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when related resources block deletion", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
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
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(429);
  });

  it("triggers invalidateUserSessions on SCIM DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue([]);

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", { tenantId: "tenant-1" });
  });

  it("returns 204 even if session invalidation fails on DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
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
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue([]);
    mockInvalidateUserSessions.mockResolvedValue({ sessions: 2, extensionTokens: 1, apiKeys: 0 });

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0 }),
      }),
    );
  });

  it("records the email read after the tenant context, not through the membership's relation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue([]);
    mockGuardUser.findUnique.mockResolvedValue({ email: "moved@example.com", name: "Moved", locale: null });

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockTenantMember.findUnique.mock.calls[1][0].select).toEqual({ id: true, role: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ email: "moved@example.com" }) }),
    );
  });

  it("still records the committed deletion when the email read fails", async () => {
    // The read runs after the deletion committed. Throwing out of it answered the
    // IdP with a 500 for a user that was gone and left SCIM_USER_DELETE unwritten
    // (round-5 F2).
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue([]);
    mockGuardUser.findUnique.mockRejectedValue(new Error("bypass unavailable"));

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(res!.status).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_DELETE",
        metadata: expect.objectContaining({ email: null }),
      }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      "scim.delete-contact-read-failed",
    );
  });
});
