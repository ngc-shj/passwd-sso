import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockOrgMember,
  mockUser,
  mockScimExternalMapping,
  mockOrgMemberKey,
  mockTransaction,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockOrgMember: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  mockUser: { update: vi.fn() },
  mockScimExternalMapping: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  mockOrgMemberKey: { deleteMany: vi.fn() },
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
    orgMemberKey: mockOrgMemberKey,
    $transaction: mockTransaction,
  },
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "team-1", orgId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
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
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 404 when user not found", async () => {
    mockOrgMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("unknown"));
    expect(res.status).toBe(404);
  });

  it("resolves user via externalId in ScimExternalMapping", async () => {
    // First call: direct userId lookup → not found
    mockOrgMember.findUnique
      .mockResolvedValueOnce(null) // resolveUserId direct lookup
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "internal-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "internal-1", email: "ext@example.com", name: "Ext User" },
      });
    // resolveUserId: ScimExternalMapping.findFirst → found
    mockScimExternalMapping.findFirst
      .mockResolvedValueOnce({ internalId: "internal-1" });
    // fetchUserResource: ScimExternalMapping.findFirst → no mapping
    mockScimExternalMapping.findFirst
      .mockResolvedValueOnce(null);

    const res = await GET(makeReq(), makeParams("ext-id-123"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("ext@example.com");
    // Verify ScimExternalMapping.findFirst was searched in tenant scope
    expect(mockScimExternalMapping.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          externalId: "ext-id-123",
          resourceType: "User",
        }),
      }),
    );
  });

  it("returns user resource when found via direct userId", async () => {
    mockOrgMember.findUnique.mockResolvedValue({
      userId: "user-1",
      orgId: "team-1",
      deactivatedAt: null,
      role: "MEMBER",
      user: { id: "user-1", email: "test@example.com", name: "Test" },
    });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("test@example.com");
    expect(body.active).toBe(true);
  });
});

describe("PUT /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    // PUT uses $transaction — execute callback with mock tx objects
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        orgMember: mockOrgMember,
        user: mockUser,
        scimExternalMapping: mockScimExternalMapping,
      }),
    );
  });

  it("returns 403 when trying to deactivate OWNER", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "owner-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "OWNER", deactivatedAt: null }); // OWNER check

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "owner@example.com",
          active: false,
        },
      }),
      makeParams("owner-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when externalId is already mapped to a different user", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }); // role check
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue({
      internalId: "other-user",
      externalId: "ext-1",
    });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
          externalId: "ext-1",
        },
      }),
      makeParams("user-1"),
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
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }); // role check
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.create.mockRejectedValue(p2002);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
          externalId: "ext-race",
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("externalId");
  });

  it("does not remap unrelated P2002 errors to externalId conflict", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "7.0.0", meta: { modelName: "User" } },
    );
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.create.mockRejectedValue(p2002);

    await expect(
      PUT(
        makeReq({
          method: "PUT",
          body: {
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: "test@example.com",
            active: true,
            externalId: "ext-race",
          },
        }),
        makeParams("user-1"),
      ),
    ).rejects.toBe(p2002);
  });

  it("updates OrgMember atomically via $transaction", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // T3-1: Verify scimManaged is always set in PUT
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scimManaged: true }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("logs SCIM_USER_DEACTIVATE when deactivating active user via PUT", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // active → deactivate
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1", orgId: "team-1", deactivatedAt: new Date(),
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SCIM_USER_DEACTIVATE" }),
    );
  });

  it("logs SCIM_USER_REACTIVATE when reactivating deactivated user via PUT", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: new Date("2024-01-01") }) // deactivated → reactivate
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1", orgId: "team-1", deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
        },
      }),
      makeParams("user-1"),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }),
    );
  });

  it("reactivates a deactivated user via PUT active:true", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: new Date("2024-01-01"), userId: "user-1" }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deactivatedAt: null }),
      }),
    );
  });

  it("does not update User.name via PUT (multi-team safety)", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Old Name" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          name: { formatted: "New Name" },
          active: true,
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    expect(mockUser.update).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    mockOrgMember.findUnique.mockResolvedValueOnce({ userId: "user-1" }); // resolveUserId

    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PUT",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await PUT(req, makeParams("user-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Invalid JSON");
  });

  it("clears externalId mapping when externalId is omitted in PUT", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
          // no externalId — should trigger cleanup
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          internalId: "user-1",
          resourceType: "User",
        }),
      }),
    );
  });
});

describe("PATCH /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("deactivates a user via PATCH active=false", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // member lookup
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: new Date(),
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
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
    expect(res.status).toBe(200);
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deactivatedAt: expect.any(Date),
          scimManaged: true,
        }),
      }),
    );
  });

  it("blocks PATCH active=false on OWNER", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "owner-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "OWNER", deactivatedAt: null }); // member lookup

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("owner-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for unsupported patch op", async () => {
    mockOrgMember.findUnique.mockResolvedValueOnce({ userId: "user-1" }); // resolveUserId

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
    expect(res.status).toBe(400);
  });

  it("reactivates a deactivated user via PATCH active=true", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: new Date("2024-01-01") }) // member lookup
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
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
    expect(res.status).toBe(200);
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deactivatedAt: null,
          scimManaged: true,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }),
    );
  });

  it("does not update User.name via PATCH (multi-team safety)", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // member lookup
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "team-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "name.formatted", value: "New Name" }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    // User.update should NOT be called — PATCH skips User.name for multi-team safety
    expect(mockUser.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("deletes OrgMember, OrgMemberKey, and ScimExternalMapping atomically", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ // member lookup (includes user for email)
        id: "m1",
        role: "MEMBER",
        userId: "user-1",
        user: { email: "test@example.com" },
      });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res.status).toBe(204);
    // $transaction receives an array of 3 Prisma operations (deleteMany x2 + delete x1)
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
    const txArg = mockTransaction.mock.calls[0][0];
    expect(txArg).toHaveLength(3);
    expect(mockLogAudit).toHaveBeenCalled();
    // Verify audit metadata contains email
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ email: "test@example.com" }),
      }),
    );
  });

  it("blocks DELETE on OWNER", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "owner-1" }) // resolveUserId
      .mockResolvedValueOnce({
        id: "m1",
        role: "OWNER",
        userId: "owner-1",
        user: { email: "owner@example.com" },
      });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("owner-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown user", async () => {
    mockOrgMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("unknown"));
    expect(res.status).toBe(404);
  });

  it("returns 409 on P2003 FK constraint violation", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2003 = new Prisma.PrismaClientKnownRequestError(
      "Foreign key constraint failed",
      { code: "P2003", clientVersion: "7.0.0", meta: {} },
    );
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({
        id: "m1",
        role: "MEMBER",
        userId: "user-1",
        user: { email: "test@example.com" },
      });
    mockTransaction.mockRejectedValue(p2003);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("related resources");
  });

  it("returns 404 when scimId exceeds 255 characters", async () => {
    const longId = "a".repeat(256);
    const res = await GET(makeReq(), makeParams(longId));
    expect(res.status).toBe(404);
    // resolveUserId should short-circuit, no DB calls
    expect(mockOrgMember.findUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/scim/v2/Users/[id] — additional edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    mockOrgMember.findUnique.mockResolvedValueOnce({ userId: "user-1" }); // resolveUserId

    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PATCH",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await PATCH(req, makeParams("user-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Invalid JSON");
  });

  it("returns 400 for missing PatchOp schema URN", async () => {
    mockOrgMember.findUnique.mockResolvedValueOnce({ userId: "user-1" }); // resolveUserId

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["wrong:schema"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("PatchOp");
  });
});

describe("PUT /api/scim/v2/Users/[id] — externalId change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        orgMember: mockOrgMember,
        user: mockUser,
        scimExternalMapping: mockScimExternalMapping,
      }),
    );
  });

  it("deletes stale mapping before creating new one when externalId changes", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1", orgId: "team-1", deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      });
    mockOrgMember.update.mockResolvedValue({});
    // New externalId "ext-B" doesn't exist yet
    mockScimExternalMapping.findFirst
      .mockResolvedValueOnce(null) // uniqueness check
      .mockResolvedValueOnce({ externalId: "ext-B" }); // fetchUserResource
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockScimExternalMapping.create.mockResolvedValue({});

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "test@example.com",
          active: true,
          externalId: "ext-B",
        },
      }),
      makeParams("user-1"),
    );
    expect(res.status).toBe(200);
    // deleteMany should be called BEFORE create to clear stale mapping
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          internalId: "user-1",
          resourceType: "User",
        }),
      }),
    );
    expect(mockScimExternalMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: "ext-B" }),
      }),
    );
  });
});
