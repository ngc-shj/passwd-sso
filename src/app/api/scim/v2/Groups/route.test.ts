import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockScimGroupMapping,
  mockTeam,
  mockTeamMember,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockScimGroupMapping: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  mockTeam: { findUnique: vi.fn(), findFirst: vi.fn() },
  mockTeamMember: { findMany: vi.fn() },
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

const { mockLogAuditInTx } = vi.hoisted(() => ({ mockLogAuditInTx: vi.fn() }));

vi.mock("@/lib/auth/tokens/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimGroupMapping: mockScimGroupMapping,
    team: mockTeam,
    teamMember: mockTeamMember,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1", actorType: "HUMAN" as const },
};

function makeReq(options: { searchParams?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL("http://localhost/api/scim/v2/Groups");
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) url.searchParams.set(k, v);
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
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns tenant group mappings", async () => {
    mockScimGroupMapping.findMany.mockResolvedValue([
      {
        externalGroupId: "grp-1",
        role: "ADMIN",
        teamId: "team-1",
        team: { slug: "core" },
      },
    ]);
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].id).toBe("grp-1");
    expect(body.Resources[0].displayName).toBe("core:ADMIN");
  });

  it("filters by displayName", async () => {
    mockScimGroupMapping.findMany.mockResolvedValue([
      { externalGroupId: "grp-1", role: "ADMIN", teamId: "team-1", team: { slug: "core" } },
      { externalGroupId: "grp-2", role: "VIEWER", teamId: "team-1", team: { slug: "core" } },
    ]);
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq({ searchParams: { filter: 'displayName eq "core:ADMIN"' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
  });

  it("returns 400 for unsupported filter syntax", async () => {
    const res = await GET(makeReq({ searchParams: { filter: 'members eq "user-1"' } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when filter exceeds max length", async () => {
    const res = await GET(makeReq({ searchParams: { filter: "x".repeat(257) } }));
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

  it("filters members without email from group resources", async () => {
    mockScimGroupMapping.findMany.mockResolvedValue([
      { externalGroupId: "grp-1", role: "ADMIN", teamId: "team-1", team: { slug: "core" } },
    ]);
    mockTeamMember.findMany.mockResolvedValue([
      { userId: "user-1", teamId: "team-1", role: "ADMIN", user: { id: "user-1", email: null } },
      { userId: "user-2", teamId: "team-1", role: "ADMIN", user: { id: "user-2", email: "u2@example.com" } },
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.Resources[0].members).toEqual([
      expect.objectContaining({ value: "user-2", display: "u2@example.com" }),
    ]);
  });

  it("lists only members with an active membership in this tenant", async () => {
    mockScimGroupMapping.findMany.mockResolvedValue([
      { externalGroupId: "grp-1", role: "ADMIN", teamId: "team-1", team: { slug: "core" } },
    ]);
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(mockTeamMember.findMany.mock.calls[0][0].where.user).toEqual({
      tenantMemberships: { some: { tenantId: "tenant-1", deactivatedAt: null } },
    });
  });
});

describe("POST /api/scim/v2/Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("creates a tenant group mapping", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);
    mockScimGroupMapping.create.mockResolvedValue({});
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockScimGroupMapping.create).toHaveBeenCalled();
    // TEAM scope (C4): the team owner sees a new IdP mapping, even though
    // mapping creation itself touches no member row.
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({
        scope: "TEAM",
        teamId: "team-1",
        action: "SCIM_GROUP_MAPPING_CREATE",
        metadata: expect.objectContaining({ scimTokenId: "t1", externalGroupId: "grp-1", role: "ADMIN" }),
      }),
    );
  });

  it("does not audit mapping creation when reusing an existing mapping", async () => {
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    mockScimGroupMapping.findUnique.mockResolvedValue({ id: "mapping-1", teamId: "team-1", role: "ADMIN" });
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:admin",
          externalId: "grp-1",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockScimGroupMapping.create).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("reports only members with an active membership in this tenant in the created group", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);
    mockScimGroupMapping.create.mockResolvedValue({});
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockTeamMember.findMany.mock.calls[0][0].where.user).toEqual({
      tenantMemberships: { some: { tenantId: "tenant-1", deactivatedAt: null } },
    });
  });

  it("returns 400 when externalId is missing", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when displayName format is invalid on POST", async () => {
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "invalid-no-colon",
          externalId: "grp-new",
        },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("displayName");
  });

  it("returns 409 when externalId points at another group", async () => {
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    mockScimGroupMapping.findUnique.mockResolvedValue({
      id: "mapping-1",
      teamId: "team-2",
      role: "VIEWER",
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
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
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
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
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
        },
      }),
    );

    expect(res.status).toBe(429);
  });

  it("returns 400 for invalid JSON on POST", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Groups", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for schema validation failures on POST", async () => {
    const res = await POST(
      makeReq({
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"] },
      }),
    );

    expect(res.status).toBe(400);
  });

  // C/F2/S-F3 (review round 2, F-N3/T-N3/T-N4): POST never reads `members`
  // for mapping creation, but the body is still schema-validated whole —
  // a malformed member value 400s here too, a behavior change from when the
  // field went unvalidated (noted in the deviation log).
  it("returns 400 for a non-uuid member value, although POST never reads members for the mapping it creates", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
          members: [{ value: "not-a-uuid" }],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockScimGroupMapping.create).not.toHaveBeenCalled();
  });

  it("treats blank externalId as invalid", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "   ",
        },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when team slug in displayName is not found in tenant", async () => {
    mockTeam.findFirst.mockResolvedValue(null);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          externalId: "grp-1",
        },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when slug is empty in displayName", async () => {
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: ":ADMIN",
          externalId: "grp-new",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("displayName");
  });

  it("returns 400 when role in displayName is not a valid SCIM group role", async () => {
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:OWNER",
          externalId: "grp-new",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("displayName");
  });

  it("reuses an existing mapping for the same team and role", async () => {
    mockTeam.findFirst.mockResolvedValue({ id: "team-1", slug: "core" });
    mockScimGroupMapping.findUnique.mockResolvedValue({
      id: "mapping-1",
      teamId: "team-1",
      role: "ADMIN",
    });
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:admin",
          externalId: "grp-1",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockScimGroupMapping.create).not.toHaveBeenCalled();
  });
});
