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
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), extractRequestMeta: () => ({ ip: null, userAgent: null }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimGroupMapping: mockScimGroupMapping,
    team: mockTeam,
    teamMember: mockTeamMember,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({ withTenantRls: mockWithTenantRls }));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
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
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
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
    mockCheckScimRateLimit.mockResolvedValue(false);

    const res = await GET(makeReq());
    expect(res.status).toBe(429);
  });

  it("filters members without email from group resources", async () => {
    mockScimGroupMapping.findMany.mockResolvedValue([
      { externalGroupId: "grp-1", role: "ADMIN", teamId: "team-1", team: { slug: "core" } },
    ]);
    mockTeamMember.findMany.mockResolvedValue([
      { userId: "user-1", user: { id: "user-1", email: null } },
      { userId: "user-2", user: { id: "user-2", email: "u2@example.com" } },
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.Resources[0].members).toEqual([
      expect.objectContaining({ value: "user-2", display: "u2@example.com" }),
    ]);
  });
});

describe("POST /api/scim/v2/Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
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
    mockCheckScimRateLimit.mockResolvedValue(false);

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

    expect(res.status).toBe(201);
    expect(mockScimGroupMapping.create).not.toHaveBeenCalled();
  });
});
