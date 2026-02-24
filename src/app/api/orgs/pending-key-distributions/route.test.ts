import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaOrgMember } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findMany: vi.fn() },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
  },
}));

import { GET } from "./route";

describe("GET /api/orgs/pending-key-distributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when user is not admin of any E2E org", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValueOnce([]); // admin memberships
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it("returns pending members for admin orgs", async () => {
    // First call: admin memberships
    mockPrismaOrgMember.findMany.mockResolvedValueOnce([
      { orgId: "org-1" },
      { orgId: "org-2" },
    ]);
    // Second call: pending members
    mockPrismaOrgMember.findMany.mockResolvedValueOnce([
      {
        id: "member-1",
        orgId: "org-1",
        userId: "pending-user",
        user: { ecdhPublicKey: "pub-key", name: "Test User", email: "test@test.com" },
        org: { orgKeyVersion: 1 },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0]).toEqual({
      memberId: "member-1",
      orgId: "org-1",
      userId: "pending-user",
      ecdhPublicKey: "pub-key",
      orgKeyVersion: 1,
    });
    // PII (name, email) must NOT be included in response (S-16)
    expect(json[0]).not.toHaveProperty("name");
    expect(json[0]).not.toHaveProperty("email");
  });

  it("queries for pending members with correct filters", async () => {
    mockPrismaOrgMember.findMany
      .mockResolvedValueOnce([{ orgId: "org-1" }])
      .mockResolvedValueOnce([]);

    await GET();

    // Second findMany call should filter by keyDistributed: false and ecdhPublicKey not null
    expect(mockPrismaOrgMember.findMany).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        where: expect.objectContaining({
          keyDistributed: false,
          user: { ecdhPublicKey: { not: null } },
        }),
      }),
    );
  });
});
