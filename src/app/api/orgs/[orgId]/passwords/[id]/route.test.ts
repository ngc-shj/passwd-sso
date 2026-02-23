import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockPrismaOrgPasswordEntry, mockPrismaOrgFolder, mockAuditLogCreate,
  mockRequireOrgPermission,
  mockRequireOrgMember, mockHasOrgPermission, OrgAuthError,
  mockPrismaTransaction,
} = vi.hoisted(() => {
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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaOrgFolder: { findUnique: vi.fn() },
    mockAuditLogCreate: vi.fn(),
    mockRequireOrgPermission: vi.fn(),
    mockRequireOrgMember: vi.fn(),
    mockHasOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
    mockPrismaTransaction: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    orgFolder: mockPrismaOrgFolder,
    auditLog: { create: mockAuditLogCreate },
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  requireOrgMember: mockRequireOrgMember,
  hasOrgPermission: mockHasOrgPermission,
  OrgAuthError,
}));

import { GET, PUT, DELETE } from "./route";
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const PW_ID = "pw-456";
const now = new Date("2025-01-01T00:00:00Z");

const validE2EBody = {
  encryptedBlob: { ciphertext: "new-blob-data", iv: "a".repeat(24), authTag: "b".repeat(32) },
  encryptedOverview: { ciphertext: "new-overview-data", iv: "c".repeat(24), authTag: "d".repeat(32) },
  aadVersion: 1,
  orgKeyVersion: 1,
};

function makeEntryForGET(overrides = {}) {
  return {
    id: PW_ID,
    orgId: ORG_ID,
    entryType: ENTRY_TYPE.LOGIN,
    encryptedBlob: "encrypted-blob-data",
    blobIv: "aabbccddee001122",
    blobAuthTag: "aabbccddee0011223344556677889900",
    encryptedOverview: "encrypted-overview-data",
    overviewIv: "ffeeddccbbaa9988",
    overviewAuthTag: "ffeeddccbbaa99887766554433221100",
    aadVersion: 1,
    orgKeyVersion: 1,
    isArchived: false,
    orgFolderId: null,
    tags: [],
    createdBy: { id: "u1", name: "User", image: null },
    updatedBy: { id: "u1", name: "User" },
    favorites: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEntryForPUT(overrides = {}) {
  return {
    orgId: ORG_ID,
    createdById: "test-user-id",
    encryptedBlob: "old-blob",
    blobIv: "e".repeat(24),
    blobAuthTag: "f".repeat(32),
    aadVersion: 1,
    orgKeyVersion: 1,
    ...overrides,
  };
}

describe("GET /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from GET", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns encrypted blobs as-is (E2E mode)", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForGET({ tags: [{ id: "tag-1", name: "Work", color: "#ff0000" }] }),
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.encryptedBlob).toBe("encrypted-blob-data");
    expect(json.blobIv).toBe("aabbccddee001122");
    expect(json.blobAuthTag).toBe("aabbccddee0011223344556677889900");
    expect(json.encryptedOverview).toBe("encrypted-overview-data");
    expect(json.overviewIv).toBe("ffeeddccbbaa9988");
    expect(json.overviewAuthTag).toBe("ffeeddccbbaa99887766554433221100");
    expect(json.aadVersion).toBe(1);
    expect(json.orgKeyVersion).toBe(1);
    expect(json.isFavorite).toBe(false);
    expect(json.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json.tags).toHaveLength(1);
    // Should NOT contain decrypted fields
    expect(json.title).toBeUndefined();
    expect(json.password).toBeUndefined();
  });

  it("returns orgFolderId in GET response when entry has a folder", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForGET({ orgFolderId: FOLDER_CUID }),
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.orgFolderId).toBe(FOLDER_CUID);
  });
});

describe("PUT /api/orgs/[orgId]/passwords/[id]", () => {
  const txMock = {
    orgPasswordEntryHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    orgPasswordEntry: {
      update: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: ORG_ROLE.ADMIN, userId: "test-user-id" });
    mockHasOrgPermission.mockReturnValue(true);
    mockAuditLogCreate.mockResolvedValue({});
    txMock.orgPasswordEntryHistory.create.mockResolvedValue({});
    txMock.orgPasswordEntryHistory.findMany.mockResolvedValue([]);
    txMock.orgPasswordEntryHistory.deleteMany.mockResolvedValue({ count: 0 });
    txMock.orgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      updatedAt: now,
    });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("NOT_ORG_MEMBER", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from PUT", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      PUT(
        createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
          body: validE2EBody,
        }),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found for PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when user lacks PASSWORD_UPDATE permission", async () => {
    mockHasOrgPermission.mockReturnValue(false);
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when MEMBER tries to update another's entry", async () => {
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: ORG_ROLE.MEMBER, userId: "test-user-id" });
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForPUT({ createdById: "other-user" }),
    );
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on malformed JSON for PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
      method: "PUT",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, createParams({ orgId: ORG_ID, id: PW_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when E2E body has partial encryption fields", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    // encryptedBlob present but encryptedOverview missing → refine fails
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { encryptedBlob: validE2EBody.encryptedBlob, aadVersion: 1, orgKeyVersion: 1 },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when tagIds contains invalid CUID", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, tagIds: ["not-a-cuid"] },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("updates entry with full E2E blob replacement (200)", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.entryType).toBe(ENTRY_TYPE.LOGIN);

    // Verify old blob saved to history (inside transaction)
    expect(txMock.orgPasswordEntryHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: PW_ID,
          encryptedBlob: "old-blob",
          blobIv: "e".repeat(24),
          blobAuthTag: "f".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
        }),
      }),
    );

    // Verify new blob written (inside same transaction)
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedBlob: "new-blob-data",
          blobIv: "a".repeat(24),
          blobAuthTag: "b".repeat(32),
          encryptedOverview: "new-overview-data",
          overviewIv: "c".repeat(24),
          overviewAuthTag: "d".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
        }),
      }),
    );
  });

  it("updates entry with orgFolderId when folder belongs to same org", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: ORG_ID });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: FOLDER_CUID }),
      }),
    );
  });

  it("returns 400 when orgFolderId belongs to a different org in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: "other-org-999" });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("returns 400 when orgFolderId does not exist in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaOrgFolder.findUnique.mockResolvedValue(null);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("clears orgFolderId when set to null in PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, orgFolderId: null },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaOrgFolder.findUnique).not.toHaveBeenCalled();
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: null }),
      }),
    );
  });
});

describe("DELETE /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });
    mockAuditLogCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied for DELETE", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from DELETE", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("soft deletes by default", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaOrgPasswordEntry.update).toHaveBeenCalled();
  });

  it("permanently deletes when permanent=true", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaOrgPasswordEntry.delete).toHaveBeenCalled();
  });
});
