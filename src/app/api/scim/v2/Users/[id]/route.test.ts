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
}));

vi.mock("@/lib/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
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
vi.mock("@/lib/tenant-rls", () => ({ withTenantRls: mockWithTenantRls }));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
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
});

describe("PUT /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(res.status).toBe(200);
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

    expect(res.status).toBe(403);
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

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("externalId");
  });
});

describe("PATCH /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(res.status).toBe(400);
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

    expect(res.status).toBe(403);
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("removes tenant member and related records", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", user: { email: "u@example.com" } });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res.status).toBe(204);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
  });

  it("returns 403 when deleting OWNER via DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", user: { email: "owner@example.com" } });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
