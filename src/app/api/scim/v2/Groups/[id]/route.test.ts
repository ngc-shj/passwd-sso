import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockScimGroupMapping,
  mockTeamMember,
  mockTenantMember,
  mockTransaction,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockScimGroupMapping: { findUnique: vi.fn() },
  mockTeamMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
  },
  mockTenantMember: { findUnique: vi.fn(), findMany: vi.fn() },
  mockTransaction: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/auth/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: null, userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimGroupMapping: mockScimGroupMapping,
    teamMember: mockTeamMember,
    tenantMember: mockTenantMember,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/auth/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

const mapping = {
  id: "m1",
  externalGroupId: "grp-1",
  role: "ADMIN",
  teamId: "team-1",
  team: { slug: "core" },
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
  return new NextRequest("http://localhost/api/scim/v2/Groups/grp-1", init as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 404 when mapping not found", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);
    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(404);
  });

  it("returns mapped group resource", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("grp-1");
    expect(body.displayName).toBe("core:ADMIN");
  });

  it("returns 429 when group lookups are rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);

    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(429);
  });

  it("returns 401 when SCIM token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(401);
  });

  it("filters out members without email from group resource", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.findMany.mockResolvedValue([
      { userId: "user-1", user: { id: "user-1", email: null } },
      { userId: "user-2", user: { id: "user-2", email: "u2@example.com" } },
    ]);

    const res = await GET(makeReq(), makeParams("grp-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({ value: "user-2", display: "u2@example.com" }),
    ]);
  });
});

describe("PATCH /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    // Default transaction: pass tx with batch-capable mocks
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        teamMember: mockTeamMember,
        tenantMember: mockTenantMember,
      }),
    );
  });

  it("adds a member", async () => {
    // Existing member (role update path): findMany returns the member, updateMany is called
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "tm1", userId: "user-1", role: "MEMBER" }]) // tx.teamMember.findMany (existing members)
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTeamMember.updateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.updateMany).toHaveBeenCalled();
  });

  it("returns 400 when removing a missing member", async () => {
    // Remove op: findMany returns empty (user not in team)
    mockTeamMember.findMany.mockResolvedValueOnce([]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: 'members[value eq "user-9"]' }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
  });

  it("returns 403 when patch would modify an owner", async () => {
    // findMany returns an existing OWNER member
    mockTeamMember.findMany.mockResolvedValueOnce([{ id: "tm1", userId: "user-1", role: "OWNER" }]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(403);
  });

  it("creates a team member when adding a tenant user who is not yet in the team", async () => {
    // User not yet in team (toCreate path): findMany returns empty, tenantMember.findMany confirms active
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // tx.teamMember.findMany (no existing team member)
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValueOnce([{ userId: "user-1" }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          teamId: "team-1",
          userId: "user-1",
          tenantId: "tenant-1",
          role: "ADMIN",
          scimManaged: true,
        },
      ],
    });
  });

  it("downgrades a member to MEMBER when removing the mapped role", async () => {
    // Remove op sequence: applyAddOperations with addOps=[] returns early (no findMany)
    // (1) tx.teamMember.findMany for validate existence, (2) tx.teamMember.findMany in applyRemoveOperations
    // (3) prisma.teamMember.findMany in loadGroupMembers after tx
    const member = [{ id: "tm1", userId: "user-1", role: "ADMIN" }];
    mockTeamMember.findMany
      .mockResolvedValueOnce(member) // validate existence in removeOps
      .mockResolvedValueOnce(member) // freshMembers in applyRemoveOperations
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTeamMember.updateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: 'members[value eq "user-1"]' }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["tm1"] } },
      data: { deactivatedAt: expect.any(Date) },
    });
  });

  it("returns 400 when adding a user not in the tenant", async () => {
    // User not in team and not in tenant: tenantMember.findMany returns empty
    mockTeamMember.findMany.mockResolvedValueOnce([]);
    mockTenantMember.findMany.mockResolvedValueOnce([]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "nonexistent-user" }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.detail).toContain("Referenced member");
  });

  it("returns 400 for invalid JSON on PATCH", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Groups/grp-1", {
      method: "PATCH",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, makeParams("grp-1"));
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PATCH target is missing", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
        },
      }),
      makeParams("missing"),
    );

    expect(res!.status).toBe(404);
  });

  it("returns 400 for schema validation failures on PATCH", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] },
      }),
      makeParams("grp-1"),
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
          Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
        },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("rethrows unexpected transaction errors on PATCH", async () => {
    mockTransaction.mockRejectedValue(new Error("boom"));

    await expect(
      PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [{ op: "add", path: "members", value: [{ value: "user-1" }] }],
          },
        }),
        makeParams("grp-1"),
      ),
    ).rejects.toThrow("boom");
  });
});

describe("PUT /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    // Default transaction: pass tx with batch-capable mocks
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        teamMember: mockTeamMember,
        tenantMember: mockTenantMember,
      }),
    );
  });

  it("replaces role members", async () => {
    // Pre-tx read: current ADMIN members (user-1 will be removed)
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "tm1", userId: "user-1", role: "ADMIN" }]) // prisma.teamMember.findMany (current members)
      .mockResolvedValueOnce([{ id: "tm2", userId: "user-2", role: "MEMBER" }]) // tx.teamMember.findMany (existing for toAdd)
      .mockResolvedValueOnce([{ id: "tm1", userId: "user-1", role: "ADMIN" }]) // tx.teamMember.findMany (freshMembers for toRemove)
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValue([]);
    mockTeamMember.updateMany.mockResolvedValue({ count: 1 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: "user-2" }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
  });

  it("creates team member when user exists in tenant but not in team", async () => {
    // Pre-tx read: no current ADMIN members
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // prisma.teamMember.findMany (current members)
      .mockResolvedValueOnce([]) // tx.teamMember.findMany (no existing for toAdd)
      .mockResolvedValueOnce([{ id: "tm-created", userId: "user-2", role: "ADMIN", user: { id: "user-2", email: "u2@example.com" } }]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValueOnce([{ userId: "user-2" }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: "user-2" }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          teamId: "team-1",
          userId: "user-2",
          tenantId: "tenant-1",
          role: "ADMIN",
          scimManaged: true,
        },
      ],
    });
  });

  it("returns 400 when displayName does not match the mapped role", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:VIEWER",
          members: [{ value: "user-2" }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
  });

  it("returns 400 when requested member is not active in the tenant", async () => {
    // No current members; user-2 is not a team member and not in tenant
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // prisma.teamMember.findMany (current members)
      .mockResolvedValueOnce([]); // tx.teamMember.findMany (no existing for toAdd)
    mockTenantMember.findMany.mockResolvedValueOnce([]);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: "user-2" }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.detail).toContain("Referenced member");
  });

  it("returns 403 when PUT targets an owner-mapped group", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue({ ...mapping, role: "OWNER" });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:OWNER",
          members: [],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(403);
  });

  it("returns 404 when PUT target is missing", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [],
        },
      }),
      makeParams("missing"),
    );

    expect(res!.status).toBe(404);
  });

  it("returns 400 for schema validation failures on PUT", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"] },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 429 when PUT is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [],
        },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(429);
  });
});

describe("DELETE /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_URL = "http://localhost:3000";
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 405", async () => {
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(405);
  });

  it("returns 401 when token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when DELETE is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(429);
  });
});
