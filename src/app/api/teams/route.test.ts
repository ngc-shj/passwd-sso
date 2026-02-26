import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaOrganization } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockPrismaOrganization: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaTeamMember,
    organization: mockPrismaOrganization,
  },
}));

import { GET, POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns list of orgs with role", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        role: TEAM_ROLE.OWNER,
        org: { id: "team-1", name: "My Team", slug: "my-team", description: null, createdAt: now },
      },
      {
        role: TEAM_ROLE.MEMBER,
        org: { id: "team-2", name: "Other", slug: "other", description: "desc", createdAt: now },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe(TEAM_ROLE.OWNER);
    expect(json[1].role).toBe(TEAM_ROLE.MEMBER);
  });

  it("returns empty array when user has no orgs", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("POST /api/teams (E2E-only)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  const validE2EBody = {
    name: "E2E Team",
    slug: "e2e-team",
    orgMemberKey: {
      encryptedOrgKey: "encrypted-team-key-data",
      orgKeyIv: "a".repeat(24),
      orgKeyAuthTag: "b".repeat(32),
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

  it("returns 400 when orgMemberKey is missing", async () => {
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
    mockPrismaOrganization.findUnique.mockResolvedValue({ id: "existing" });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SLUG_ALREADY_TAKEN");
  });

  it("creates E2E team with TeamMemberKey (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    mockPrismaOrganization.create.mockResolvedValue({
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
    expect(mockPrismaOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgKeyVersion: 1,
          memberKeys: expect.objectContaining({
            create: expect.objectContaining({
              encryptedOrgKey: "encrypted-team-key-data",
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
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    mockPrismaOrganization.create.mockResolvedValue({
      id: "e2e-team-id",
      name: "E2E Team",
      slug: "e2e-team",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams", {
      body: { ...validE2EBody, orgMemberKey: { ...validE2EBody.orgMemberKey, wrapVersion: 1 } },
    }));
    expect(res.status).toBe(201);
    expect(mockPrismaOrganization.create).toHaveBeenCalledWith(
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

  it("returns 400 when E2E body has invalid orgKeyIv", async () => {
    const invalidBody = {
      name: "Bad Team",
      slug: "bad-team",
      orgMemberKey: {
        encryptedOrgKey: "data",
        orgKeyIv: "short",
        orgKeyAuthTag: "b".repeat(32),
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
