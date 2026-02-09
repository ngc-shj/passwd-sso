import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrganization, mockPrismaOrgPasswordEntry, mockRequireOrgPermission, mockUnwrapOrgKey, mockEncryptServerData, mockDecryptServerData, OrgAuthError } = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaOrganization: { findUnique: vi.fn() },
    mockPrismaOrgPasswordEntry: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockRequireOrgPermission: vi.fn(),
    mockUnwrapOrgKey: vi.fn(),
    mockEncryptServerData: vi.fn(),
    mockDecryptServerData: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: mockPrismaOrganization,
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: mockUnwrapOrgKey,
  encryptServerData: mockEncryptServerData,
  decryptServerData: mockDecryptServerData,
}));

import { GET, POST } from "./route";

const ORG_ID = "org-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/orgs/[orgId]/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockPrismaOrgPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when org not found", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns decrypted overview list", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [{ id: "fav-1" }],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Test", username: "admin", urlHost: "example.com" })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe("Test");
    expect(json[0].isFavorite).toBe(true);
  });
});

describe("POST /api/orgs/[orgId]/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockEncryptServerData.mockReturnValue({ ciphertext: "enc", iv: "iv", authTag: "tag" });
  });

  const validBody = { title: "My Password", password: "secret123" };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: {} }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("creates org password entry with encryption (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.title).toBe("My Password");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2); // blob + overview
  });
});
