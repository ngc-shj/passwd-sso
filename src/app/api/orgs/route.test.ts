import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrganization } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findMany: vi.fn() },
  mockPrismaOrganization: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    organization: mockPrismaOrganization,
  },
}));

// Mock crypto-server: generateOrgKey + wrapOrgKey
vi.mock("@/lib/crypto-server", () => ({
  generateOrgKey: vi.fn(() => Buffer.alloc(32)),
  wrapOrgKey: vi.fn(() => ({
    ciphertext: "wrapped-cipher",
    iv: "wrapped-iv",
    authTag: "wrapped-tag",
  })),
}));

import { GET, POST } from "./route";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/orgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns list of orgs with role", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValue([
      {
        role: "OWNER",
        org: { id: "org-1", name: "My Org", slug: "my-org", description: null, createdAt: now },
      },
      {
        role: "MEMBER",
        org: { id: "org-2", name: "Other", slug: "other", description: "desc", createdAt: now },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe("OWNER");
    expect(json[1].role).toBe("MEMBER");
  });

  it("returns empty array when user has no orgs", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("POST /api/orgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  const validBody = { name: "My Org", slug: "my-org" };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: validBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: { name: "" },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when slug already taken", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({ id: "existing" });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: validBody,
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SLUG_ALREADY_TAKEN");
  });

  it("creates org with wrapped encryption key (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    mockPrismaOrganization.create.mockResolvedValue({
      id: "new-org-id",
      name: "My Org",
      slug: "my-org",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: validBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-org-id");
    expect(json.role).toBe("OWNER");
    expect(mockPrismaOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedOrgKey: "wrapped-cipher",
          orgKeyIv: "wrapped-iv",
          orgKeyAuthTag: "wrapped-tag",
          members: { create: { userId: "test-user-id", role: "OWNER" } },
        }),
      }),
    );
  });
});
