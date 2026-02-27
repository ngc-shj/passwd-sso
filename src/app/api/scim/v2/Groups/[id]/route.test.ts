import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockScimGroupMapping,
  mockTeamMember,
  mockTransaction,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockScimGroupMapping: { findUnique: vi.fn() },
  mockTeamMember: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
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
    scimGroupMapping: mockScimGroupMapping,
    teamMember: mockTeamMember,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({ withTenantRls: mockWithTenantRls }));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
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
});

describe("PATCH /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ teamMember: mockTeamMember }));
  });

  it("adds a member", async () => {
    mockTeamMember.findUnique.mockResolvedValue({ id: "tm1", role: "MEMBER" });
    mockTeamMember.update.mockResolvedValue({});
    mockTeamMember.findMany.mockResolvedValue([]);

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

    expect(res.status).toBe(200);
    expect(mockTeamMember.update).toHaveBeenCalled();
  });
});

describe("PUT /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ teamMember: mockTeamMember }));
  });

  it("replaces role members", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "tm1", userId: "user-1", role: "ADMIN" }])
      .mockResolvedValueOnce([]);
    mockTeamMember.findUnique.mockResolvedValue({ id: "tm2", role: "MEMBER" });
    mockTeamMember.update.mockResolvedValue({});

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

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 405", async () => {
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(405);
  });
});
