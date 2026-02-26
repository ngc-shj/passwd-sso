import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockOrgMember,
  mockScimExternalMapping,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockOrgMember: { findMany: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
}));

vi.mock("@/lib/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));
vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockOrgMember,
    scimExternalMapping: mockScimExternalMapping,
  },
}));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "org-1", orgId: "org-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

function makeReq(
  options: { searchParams?: Record<string, string>; body?: unknown } = {},
) {
  const url = new URL("http://localhost/api/scim/v2/Groups");
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

describe("GET /api/scim/v2/Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 3 role-based groups (ADMIN, MEMBER, VIEWER)", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(3);
    const names = body.Resources.map((r: { displayName: string }) => r.displayName);
    expect(names).toContain("ADMIN");
    expect(names).toContain("MEMBER");
    expect(names).toContain("VIEWER");
  });

  it("filters groups by displayName", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await GET(
      makeReq({ searchParams: { filter: 'displayName eq "ADMIN"' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].displayName).toBe("ADMIN");
  });

  it("returns 400 for unsupported filter", async () => {
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await GET(
      makeReq({ searchParams: { filter: 'userName eq "test"' } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("displayName eq");
  });

  it("includes members in group response", async () => {
    mockOrgMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        role: "ADMIN",
        deactivatedAt: null,
        user: { id: "user-1", email: "admin@example.com" },
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    const adminGroup = body.Resources.find(
      (r: { displayName: string }) => r.displayName === "ADMIN",
    );
    expect(adminGroup.members).toHaveLength(1);
    expect(adminGroup.members[0].value).toBe("user-1");
  });
});

describe("POST /api/scim/v2/Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("registers external mapping for valid role and returns 201", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.create.mockResolvedValue({});
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          externalId: "ext-grp-1",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockScimExternalMapping.create).toHaveBeenCalled();
  });

  it("returns 400 for unknown group name without echoing input", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "UNKNOWN_ROLE",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // S-23: Error should NOT echo the user-provided displayName
    expect(body.detail).not.toContain("UNKNOWN_ROLE");
    expect(body.detail).toContain("Valid names");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Groups", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Invalid JSON");
  });

  it("returns 409 on P2002 race condition for ScimExternalMapping create", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "7.0.0", meta: { modelName: "ScimExternalMapping" } },
    );
    mockScimExternalMapping.findFirst.mockResolvedValue(null); // check passes
    mockScimExternalMapping.create.mockRejectedValue(p2002);    // but create races

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          externalId: "ext-grp-race",
        },
      }),
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
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    mockScimExternalMapping.create.mockRejectedValue(p2002);

    await expect(
      POST(
        makeReq({
          body: {
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
            displayName: "ADMIN",
            externalId: "ext-grp-race",
          },
        }),
      ),
    ).rejects.toBe(p2002);
  });

  it("returns 409 when externalId is already mapped to a different group", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue({
      internalId: "different-group-id",
      externalId: "ext-grp-conflict",
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          externalId: "ext-grp-conflict",
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("externalId");
  });
});
