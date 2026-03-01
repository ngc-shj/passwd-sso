import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaTeam, mockWithUserTenantRls, mockWithBypassRls, mockResolveUserTenantId } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockPrismaTeam: { findUnique: vi.fn(), create: vi.fn() },
  mockWithUserTenantRls: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockResolveUserTenantId: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    team: mockPrismaTeam,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
  resolveUserTenantId: mockResolveUserTenantId,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { GET, POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: () => unknown) => fn());
    mockResolveUserTenantId.mockResolvedValue("tenant-1");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns list of teams with role", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        role: TEAM_ROLE.OWNER,
        team: {
          id: "team-1",
          name: "My Team",
          slug: "my-team",
          description: null,
          createdAt: now,
          _count: { members: 3 },
        },
      },
      {
        role: TEAM_ROLE.MEMBER,
        team: {
          id: "team-2",
          name: "Other",
          slug: "other",
          description: "desc",
          createdAt: now,
          _count: { members: 8 },
        },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe(TEAM_ROLE.OWNER);
    expect(json[0].memberCount).toBe(3);
    expect(json[1].role).toBe(TEAM_ROLE.MEMBER);
    expect(json[1].memberCount).toBe(8);
  });

  it("returns empty array when user has no teams", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("uses withBypassRls (not user tenant RLS) for cross-tenant membership query", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    await GET();
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockWithBypassRls).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
  });
});

describe("POST /api/teams (E2E-only)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => fn());
    mockResolveUserTenantId.mockResolvedValue("tenant-1");
  });

  const validE2EBody = {
    name: "E2E Team",
    slug: "e2e-team",
    teamMemberKey: {
      encryptedTeamKey: "encrypted-team-key-data",
      teamKeyIv: "a".repeat(24),
      teamKeyAuthTag: "b".repeat(32),
      ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
      hkdfSalt: "c".repeat(64),
      keyVersion: 1,
    },
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when teamMemberKey is missing", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: { name: "My Team", slug: "my-team" },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: { name: "" },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when slug already taken", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue({ id: "existing" });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SLUG_ALREADY_TAKEN");
  });

  it("returns 403 when tenant cannot be resolved during slug check", async () => {
    mockWithUserTenantRls.mockRejectedValue(new Error("TENANT_NOT_RESOLVED"));
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 409 on P2002 race condition during create", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`slug`)",
      { code: "P2002", clientVersion: "7.0.0", meta: { target: ["slug"] } },
    );
    mockPrismaTeam.create.mockRejectedValue(p2002);

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SLUG_ALREADY_TAKEN");
  });

  it("creates E2E team with TeamMemberKey (201)", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue(null);
    mockPrismaTeam.create.mockResolvedValue({
      id: "e2e-team-id",
      name: "E2E Team",
      slug: "e2e-team",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("e2e-team-id");
    expect(json.role).toBe(TEAM_ROLE.OWNER);
    expect(mockPrismaTeam.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant: { connect: { id: "tenant-1" } },
          teamKeyVersion: 1,
          memberKeys: expect.objectContaining({
            create: expect.objectContaining({
              encryptedTeamKey: "encrypted-team-key-data",
              keyVersion: 1,
            }),
          }),
        }),
      }),
    );
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/teams", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("saves wrapVersion to TeamMemberKey (S-26/F-24)", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue(null);
    mockPrismaTeam.create.mockResolvedValue({
      id: "e2e-team-id",
      name: "E2E Team",
      slug: "e2e-team",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: { ...validE2EBody, teamMemberKey: { ...validE2EBody.teamMemberKey, wrapVersion: 1 } },
    }));
    expect(res.status).toBe(201);
    expect(mockPrismaTeam.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberKeys: expect.objectContaining({
            create: expect.objectContaining({
              wrapVersion: 1,
            }),
          }),
        }),
      }),
    );
  });

  it("returns 400 when E2E body has invalid teamKeyIv", async () => {
    const invalidBody = {
      name: "Bad Team",
      slug: "bad-team",
      teamMemberKey: {
        encryptedTeamKey: "data",
        teamKeyIv: "short",
        teamKeyAuthTag: "b".repeat(32),
        ephemeralPublicKey: "pubkey",
        hkdfSalt: "c".repeat(64),
        keyVersion: 1,
      },
    };

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: invalidBody,
    }));
    expect(res.status).toBe(400);
  });
});
