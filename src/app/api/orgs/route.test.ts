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

import { GET, POST } from "./route";
import { ORG_ROLE } from "@/lib/constants";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/orgs", () => {
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
    mockPrismaOrgMember.findMany.mockResolvedValue([
      {
        role: ORG_ROLE.OWNER,
        org: { id: "org-1", name: "My Org", slug: "my-org", description: null, createdAt: now },
      },
      {
        role: ORG_ROLE.MEMBER,
        org: { id: "org-2", name: "Other", slug: "other", description: "desc", createdAt: now },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe(ORG_ROLE.OWNER);
    expect(json[1].role).toBe(ORG_ROLE.MEMBER);
  });

  it("returns empty array when user has no orgs", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("POST /api/orgs (E2E-only)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  const validE2EBody = {
    name: "E2E Org",
    slug: "e2e-org",
    orgMemberKey: {
      encryptedOrgKey: "encrypted-org-key-data",
      orgKeyIv: "a".repeat(24),
      orgKeyAuthTag: "b".repeat(32),
      ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
      hkdfSalt: "c".repeat(64),
      keyVersion: 1,
    },
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: validE2EBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when orgMemberKey is missing", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: { name: "My Org", slug: "my-org" },
    }));
    expect(res.status).toBe(400);
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
      body: validE2EBody,
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SLUG_ALREADY_TAKEN");
  });

  it("creates E2E org with OrgMemberKey (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    mockPrismaOrganization.create.mockResolvedValue({
      id: "e2e-org-id",
      name: "E2E Org",
      slug: "e2e-org",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: validE2EBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("e2e-org-id");
    expect(json.role).toBe(ORG_ROLE.OWNER);
    expect(mockPrismaOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgKeyVersion: 1,
          memberKeys: expect.objectContaining({
            create: expect.objectContaining({
              encryptedOrgKey: "encrypted-org-key-data",
              keyVersion: 1,
            }),
          }),
        }),
      }),
    );
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/orgs", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("saves wrapVersion to OrgMemberKey (S-26/F-24)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    mockPrismaOrganization.create.mockResolvedValue({
      id: "e2e-org-id",
      name: "E2E Org",
      slug: "e2e-org",
      description: null,
      createdAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
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
      name: "Bad Org",
      slug: "bad-org",
      orgMemberKey: {
        encryptedOrgKey: "data",
        orgKeyIv: "short",
        orgKeyAuthTag: "b".repeat(32),
        ephemeralPublicKey: "pubkey",
        hkdfSalt: "c".repeat(64),
        keyVersion: 1,
      },
    };

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs", {
      body: invalidBody,
    }));
    expect(res.status).toBe(400);
  });
});
