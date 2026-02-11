import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaGrant } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant },
}));

import { GET } from "./route";

describe("GET /api/emergency-access/pending-confirmations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns ACCEPTED grants without escrow", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([
      {
        id: "grant-1",
        granteeId: "grantee-1",
        granteePublicKey: '{"kty":"EC"}',
        keyAlgorithm: "ECDH-P256",
        grantee: { name: "Grantee", email: "g@test.com" },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("grant-1");
  });

  it("returns STALE grants needing re-escrow", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([
      {
        id: "stale-grant-1",
        granteeId: "grantee-1",
        granteePublicKey: '{"kty":"EC"}',
        keyAlgorithm: "ECDH-P256",
        grantee: { name: "Grantee", email: "g@test.com" },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("stale-grant-1");
  });

  it("queries with correct OR conditions", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([]);

    await GET();

    expect(mockPrismaGrant.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: "owner-1",
        granteePublicKey: { not: null },
        OR: [
          { status: "ACCEPTED", encryptedSecretKey: null },
          { status: "STALE" },
        ],
      },
      select: {
        id: true,
        granteeId: true,
        granteePublicKey: true,
        keyAlgorithm: true,
        grantee: { select: { name: true, email: true } },
      },
    });
  });
});
