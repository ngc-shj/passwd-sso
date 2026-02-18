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
    auditLog: { create: vi.fn().mockResolvedValue({}) },
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
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/orgs/[orgId]/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
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

  it("returns decrypted overview list with entryType", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        entryType: ENTRY_TYPE.LOGIN,
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
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json[0].isFavorite).toBe(true);
  });

  it("filters by entryType when type query param is provided", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { type: "SECURE_NOTE" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "SECURE_NOTE" }),
      })
    );
  });

  it("does not filter by entryType when type param is absent", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const call = mockPrismaOrgPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("returns 403 when user lacks permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new OrgAuthError("FORBIDDEN", 403)
    );
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from GET", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
        createParams({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("skips entries with corrupt encrypted data", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-good",
        entryType: ENTRY_TYPE.LOGIN,
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: "pw-corrupt",
        entryType: ENTRY_TYPE.LOGIN,
        encryptedOverview: "bad-cipher",
        overviewIv: "bad-iv",
        overviewAuthTag: "bad-tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData
      .mockReturnValueOnce(JSON.stringify({ title: "Good", username: "user", urlHost: null }))
      .mockImplementationOnce(() => { throw new Error("decrypt failed"); });

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe("Good");
  });

  it("filters by trash when trash=true", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { trash: "true" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: { not: null } }),
      })
    );
  });

  it("excludes deleted items by default", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("filters by archived when archived=true", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { archived: "true" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: true }),
      })
    );
  });

  it("excludes archived items by default", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: false }),
      })
    );
  });

  it("filters by favorites when favorites=true", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { favorites: "true" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          favorites: { some: { userId: "test-user-id" } },
        }),
      })
    );
  });

  it("filters by tag when tag param is provided", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { tag: "tag-456" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { some: { id: "tag-456" } },
        }),
      })
    );
  });

  it("filters by folder when folder param is provided", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        searchParams: { folder: "folder-789" },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(mockPrismaOrgPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgFolderId: "folder-789",
        }),
      })
    );
  });

  it("does not filter by folder when folder param is absent", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const call = mockPrismaOrgPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("orgFolderId");
  });

  it("passes AAD to decryptServerData for entries with aadVersion >= 1", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-aad",
        entryType: ENTRY_TYPE.LOGIN,
        aadVersion: 1,
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
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

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );

    // decryptServerData should be called with a Buffer AAD argument (3rd arg)
    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeInstanceOf(Buffer);
    expect(decryptCall[2].length).toBeGreaterThan(0);
  });

  it("passes undefined AAD for legacy entries with aadVersion=0", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-legacy",
        entryType: ENTRY_TYPE.LOGIN,
        aadVersion: 0,
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Legacy", username: "user", urlHost: null })
    );

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );

    // decryptServerData should be called without AAD (3rd arg = undefined)
    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeUndefined();
  });

  it("returns SECURE_NOTE entries with snippet", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-note",
        entryType: "SECURE_NOTE",
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My Note", snippet: "Some secret content..." })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(json[0].entryType).toBe("SECURE_NOTE");
    expect(json[0].title).toBe("My Note");
    expect(json[0].snippet).toBe("Some secret content...");
  });
});

describe("POST /api/orgs/[orgId]/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
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

  it("returns OrgAuthError status when POST permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-OrgAuthError from POST", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
        createParams({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ orgId: ORG_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 404 when org not found in POST", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(404);
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

  it("creates entry with tags connected", async () => {
    const TAG_CUID = "cm1234567890abcdefghijkl0";
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      tags: [{ id: TAG_CUID, name: "Work", color: "#ff0000" }],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validBody, tagIds: [TAG_CUID] },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaOrgPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: { connect: [{ id: TAG_CUID }] },
        }),
      }),
    );
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

  it("encrypts with AAD and stores aadVersion=1", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
    });

    await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validBody }),
      createParams({ orgId: ORG_ID }),
    );

    // encryptServerData should be called twice (blob + overview) with Buffer AAD args
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
    const blobCall = mockEncryptServerData.mock.calls[0];
    const overviewCall = mockEncryptServerData.mock.calls[1];
    expect(blobCall[2]).toBeInstanceOf(Buffer);
    expect(overviewCall[2]).toBeInstanceOf(Buffer);
    // Blob and overview AAD should be different (different vaultType)
    expect(blobCall[2].equals(overviewCall[2])).toBe(false);

    // Prisma create should include aadVersion=1
    expect(mockPrismaOrgPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aadVersion: 1,
        }),
      }),
    );
  });

  it("creates SECURE_NOTE entry (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-note",
      tags: [],
      createdAt: now,
    });

    const noteBody = {
      entryType: "SECURE_NOTE",
      title: "My Note",
      content: "Secret content here",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: noteBody }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-note");
    expect(json.title).toBe("My Note");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2); // blob + overview
  });

  it("returns 400 when SECURE_NOTE has no title", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const noteBody = {
      entryType: "SECURE_NOTE",
      title: "",
      content: "Some content",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: noteBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("creates CREDIT_CARD entry (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-card",
      tags: [],
      createdAt: now,
    });

    const cardBody = {
      entryType: "CREDIT_CARD",
      title: "My Card",
      cardholderName: "John Doe",
      cardNumber: "4111111111111111",
      brand: "Visa",
      expiryMonth: "12",
      expiryYear: "2028",
      cvv: "123",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: cardBody }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-card");
    expect(json.title).toBe("My Card");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2); // blob + overview
  });

  it("returns 400 when CREDIT_CARD has no title", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const cardBody = {
      entryType: "CREDIT_CARD",
      title: "",
      cardNumber: "4111111111111111",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: cardBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when CREDIT_CARD has non-digit characters in cardNumber", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const cardBody = {
      entryType: "CREDIT_CARD",
      title: "Bad Card",
      cardNumber: "4111-1111-1111-1111",
      brand: "Visa",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: cardBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when CREDIT_CARD fails Luhn check", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const cardBody = {
      entryType: "CREDIT_CARD",
      title: "Bad Card",
      cardNumber: "4111111111111112",
      brand: "Visa",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: cardBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when CREDIT_CARD length mismatches brand", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const cardBody = {
      entryType: "CREDIT_CARD",
      title: "Bad Card",
      cardNumber: "4111111111111111",
      brand: "American Express",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: cardBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("creates IDENTITY entry (201)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-identity",
      tags: [],
      createdAt: now,
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "My ID",
      fullName: "John Doe",
      idNumber: "AB1234567",
      phone: "+81-90-1234-5678",
      email: "john@example.com",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-identity");
    expect(json.title).toBe("My ID");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2); // blob + overview
  });

  it("returns 400 when IDENTITY has no title", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "",
      fullName: "John Doe",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when IDENTITY has invalid phone format", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "Bad ID",
      phone: "abc-invalid-phone!",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when IDENTITY has invalid email format", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "Bad ID",
      email: "not-an-email",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when IDENTITY expiryDate is before issueDate", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "Bad Date ID",
      issueDate: "2025-06-01",
      expiryDate: "2025-01-01",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when IDENTITY expiryDate equals issueDate", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "Same Date ID",
      issueDate: "2025-06-01",
      expiryDate: "2025-06-01",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when IDENTITY has future dateOfBirth", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag",
    });

    const identityBody = {
      entryType: "IDENTITY",
      title: "Future DOB",
      dateOfBirth: "2099-12-31",
    };
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: identityBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns IDENTITY entries with fullName and idNumberLast4 in GET", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-identity",
        entryType: "IDENTITY",
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My Passport", fullName: "John Doe", idNumberLast4: "4567" })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(json[0].entryType).toBe("IDENTITY");
    expect(json[0].title).toBe("My Passport");
    expect(json[0].fullName).toBe("John Doe");
    expect(json[0].idNumberLast4).toBe("4567");
  });

  it("returns CREDIT_CARD entries with brand and lastFour in GET", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      encryptedOrgKey: "ek",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
    });
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-card",
        entryType: "CREDIT_CARD",
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        isArchived: false,
        favorites: [],
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My Visa", brand: "Visa", lastFour: "1111", cardholderName: "John" })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(json[0].entryType).toBe("CREDIT_CARD");
    expect(json[0].title).toBe("My Visa");
    expect(json[0].brand).toBe("Visa");
    expect(json[0].lastFour).toBe("1111");
  });
});
