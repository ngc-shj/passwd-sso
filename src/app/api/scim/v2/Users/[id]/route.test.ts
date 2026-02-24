import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockOrgMember,
  mockScimExternalMapping,
  mockOrgMemberKey,
  mockTransaction,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockOrgMember: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), deleteMany: vi.fn() },
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
    scimExternalMapping: mockScimExternalMapping,
    orgMemberKey: mockOrgMemberKey,
    $transaction: mockTransaction,
  },
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", orgId: "org-1", createdById: "u1", auditUserId: "u1" },
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

  it("returns user resource when found via direct userId", async () => {
    mockOrgMember.findUnique.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
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
  });

  it("returns 403 when trying to deactivate OWNER", async () => {
    // resolveUserId → direct match
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "owner-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "OWNER", deactivatedAt: null }) // OWNER check
    ;

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

  it("updates OrgMember and returns the resource", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", deactivatedAt: null }) // role check
      .mockResolvedValueOnce({ // fetchUserResource
        userId: "user-1",
        orgId: "org-1",
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
    expect(mockLogAudit).toHaveBeenCalled();
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
        orgId: "org-1",
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
        data: expect.objectContaining({ deactivatedAt: expect.any(Date) }),
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
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER", userId: "user-1" }); // member lookup
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res.status).toBe(204);
    // $transaction receives an array of 3 Prisma operations (deleteMany x2 + delete x1)
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
    const txArg = mockTransaction.mock.calls[0][0];
    expect(txArg).toHaveLength(3);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("blocks DELETE on OWNER", async () => {
    mockOrgMember.findUnique
      .mockResolvedValueOnce({ userId: "owner-1" }) // resolveUserId
      .mockResolvedValueOnce({ id: "m1", role: "OWNER", userId: "owner-1" });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("owner-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown user", async () => {
    mockOrgMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("unknown"));
    expect(res.status).toBe(404);
  });
});
