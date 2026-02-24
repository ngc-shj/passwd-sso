import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgPasswordEntry, mockPrismaOrgFolder, mockPrismaOrganization, mockAuditLogCreate, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
    mockPrismaOrgPasswordEntry: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockPrismaOrgFolder: { findUnique: vi.fn() },
    mockPrismaOrganization: { findUnique: vi.fn() },
    mockAuditLogCreate: vi.fn(),
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    orgFolder: mockPrismaOrgFolder,
    organization: mockPrismaOrganization,
    auditLog: { create: mockAuditLogCreate },
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { GET, POST } from "./route";
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/orgs/[orgId]/passwords", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
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

  it("returns encrypted overviews as-is (E2E mode)", async () => {
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        entryType: ENTRY_TYPE.LOGIN,
        encryptedOverview: "enc-overview",
        overviewIv: "aabbccdd11223344",
        overviewAuthTag: "aabbccdd11223344aabbccdd11223344",
        aadVersion: 1,
        orgKeyVersion: 1,
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

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedOverview).toBe("enc-overview");
    expect(json[0].overviewIv).toBe("aabbccdd11223344");
    expect(json[0].orgKeyVersion).toBe(1);
    expect(json[0].isFavorite).toBe(true);
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    // Should NOT contain decrypted fields
    expect(json[0].title).toBeUndefined();
    expect(json[0].username).toBeUndefined();
  });

  it("filters by entryType when type query param is provided", async () => {
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
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const call = mockPrismaOrgPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters by trash when trash=true", async () => {
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
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`),
      createParams({ orgId: ORG_ID }),
    );
    const call = mockPrismaOrgPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("orgFolderId");
  });
});

describe("POST /api/orgs/[orgId]/passwords (E2E)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 1 });
  });

  const validE2EBody = {
    encryptedBlob: { ciphertext: "enc-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "enc-overview", iv: "c".repeat(24), authTag: "d".repeat(32) },
    aadVersion: 1,
    orgKeyVersion: 1,
    entryType: "LOGIN",
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when POST permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
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
        createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
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

  it("returns 400 on invalid E2E body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { encryptedBlob: { ciphertext: "x", iv: "short", authTag: "y" } },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when orgKeyVersion does not match org's current version (S-15)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 2 });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validE2EBody, orgKeyVersion: 1 }, // stale version
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ORG_KEY_VERSION_MISMATCH");
  });

  it("returns 409 when org not found (Q-9)", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ORG_KEY_VERSION_MISMATCH");
  });

  it("creates E2E entry with pre-encrypted blobs (201)", async () => {
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.entryType).toBe("LOGIN");
    expect(mockPrismaOrgPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedBlob: "enc-blob",
          blobIv: "a".repeat(24),
          blobAuthTag: "b".repeat(32),
          encryptedOverview: "enc-overview",
          overviewIv: "c".repeat(24),
          overviewAuthTag: "d".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
          entryType: "LOGIN",
          orgId: ORG_ID,
          createdById: "test-user-id",
          updatedById: "test-user-id",
        }),
      }),
    );
  });

  it("creates entry with tags connected", async () => {
    const TAG_CUID = "cm1234567890abcdefghijkl0";
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [{ id: TAG_CUID, name: "Work", color: "#ff0000" }],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validE2EBody, tagIds: [TAG_CUID] },
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

  it("creates entry with orgFolderId when folder belongs to same org", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaOrgPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: FOLDER_CUID }),
      }),
    );
  });

  it("returns 400 when orgFolderId belongs to a different org", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: "other-org-999" });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("returns 400 when orgFolderId does not exist", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgFolder.findUnique.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("creates entry without folder validation when orgFolderId is not provided", async () => {
    mockPrismaOrgPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords`, { body: validE2EBody }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaOrgFolder.findUnique).not.toHaveBeenCalled();
  });
});
