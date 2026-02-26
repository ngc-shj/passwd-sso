import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockPrismaTeamPasswordEntry, mockPrismaTeamFolder, mockPrismaOrganization, mockAuditLogCreate,
  mockRequireTeamPermission,
  mockRequireTeamMember, mockHasTeamPermission, TeamAuthError,
  mockPrismaTransaction,
} = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaTeamPasswordEntry: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaTeamFolder: { findUnique: vi.fn() },
    mockPrismaOrganization: { findUnique: vi.fn() },
    mockAuditLogCreate: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    mockRequireTeamMember: vi.fn(),
    mockHasTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockPrismaTransaction: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaTeamPasswordEntry,
    orgFolder: mockPrismaTeamFolder,
    organization: mockPrismaOrganization,
    auditLog: { create: mockAuditLogCreate },
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  requireTeamMember: mockRequireTeamMember,
  hasTeamPermission: mockHasTeamPermission,
  TeamAuthError,
}));

import { GET, PUT, DELETE } from "./route";
import { ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const PW_ID = "pw-456";
const now = new Date("2025-01-01T00:00:00Z");

const validE2EBody = {
  encryptedBlob: { ciphertext: "new-blob-data", iv: "a".repeat(24), authTag: "b".repeat(32) },
  encryptedOverview: { ciphertext: "new-overview-data", iv: "c".repeat(24), authTag: "d".repeat(32) },
  aadVersion: 1,
  teamKeyVersion: 1,
};

function makeEntryForGET(overrides = {}) {
  return {
    id: PW_ID,
    orgId: TEAM_ID,
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
    orgId: TEAM_ID,
    createdById: "test-user-id",
    encryptedBlob: "old-blob",
    blobIv: "e".repeat(24),
    blobAuthTag: "f".repeat(32),
    aadVersion: 1,
    orgKeyVersion: 1,
    ...overrides,
  };
}

describe("GET /api/teams/[teamId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError from GET", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
        createParams({ teamId: TEAM_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns encrypted blobs as-is (E2E mode)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForGET({ tags: [{ id: "tag-1", name: "Work", color: "#ff0000" }] }),
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
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
    expect(json.teamKeyVersion).toBe(1);
    expect(json.isFavorite).toBe(false);
    expect(json.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json.tags).toHaveLength(1);
    // Should NOT contain decrypted fields
    expect(json.title).toBeUndefined();
    expect(json.password).toBeUndefined();
  });

  it("returns 404 when entry belongs to a different team (Q-6 IDOR)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForGET({ orgId: "other-team-999" }),
    );
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns teamFolderId in GET response when entry has a folder", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForGET({ orgFolderId: FOLDER_CUID }),
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.teamFolderId).toBe(FOLDER_CUID);
  });
});

describe("PUT /api/teams/[teamId]/passwords/[id]", () => {
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
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.ADMIN, userId: "test-user-id" });
    mockHasTeamPermission.mockReturnValue(true);
    mockAuditLogCreate.mockResolvedValue({});
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 1 });
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
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_TEAM_MEMBER", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError from PUT", async () => {
    mockRequireTeamMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      PUT(
        createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
          body: validE2EBody,
        }),
        createParams({ teamId: TEAM_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found for PUT", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to a different team (Q-7 IDOR)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForPUT({ orgId: "other-team-999" }),
    );
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when user lacks PASSWORD_UPDATE permission", async () => {
    mockHasTeamPermission.mockReturnValue(false);
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when teamKeyVersion does not match team's current version (F-13)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 2 }); // team is at v2

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, teamKeyVersion: 1 }, // stale version
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("returns 403 when MEMBER tries to update another's entry", async () => {
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.MEMBER, userId: "test-user-id" });
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(
      makeEntryForPUT({ createdById: "other-user" }),
    );
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on malformed JSON for PUT", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
      method: "PUT",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, createParams({ teamId: TEAM_ID, id: PW_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when E2E body has partial encryption fields", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    // encryptedBlob present but encryptedOverview missing → refine fails
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { encryptedBlob: validE2EBody.encryptedBlob, aadVersion: 1, teamKeyVersion: 1 },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when tagIds contains invalid CUID", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, tagIds: ["not-a-cuid"] },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("updates entry with full E2E blob replacement (200)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: validE2EBody,
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
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

  it("updates entry with teamFolderId when folder belongs to same team", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaTeamFolder.findUnique.mockResolvedValue({ orgId: TEAM_ID });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: FOLDER_CUID }),
      }),
    );
  });

  it("returns 400 when teamFolderId belongs to a different team in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaTeamFolder.findUnique.mockResolvedValue({ orgId: "other-team-999" });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("returns 400 when teamFolderId does not exist in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());
    mockPrismaTeamFolder.findUnique.mockResolvedValue(null);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("updates metadata only without history snapshot (Q-8)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());

    const TAG_CUID = "cm1234567890abcdefghijkl0";
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { tagIds: [TAG_CUID], isArchived: true },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    // No history snapshot for metadata-only update
    expect(txMock.orgPasswordEntryHistory.create).not.toHaveBeenCalled();
    // Tags and isArchived should be set
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isArchived: true,
          tags: { set: [{ id: TAG_CUID }] },
        }),
      }),
    );
  });

  it("clears teamFolderId when set to null in PUT", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(makeEntryForPUT());

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        body: { ...validE2EBody, teamFolderId: null },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaTeamFolder.findUnique).not.toHaveBeenCalled();
    expect(txMock.orgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: null }),
      }),
    );
  });
});

describe("DELETE /api/teams/[teamId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockAuditLogCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied for DELETE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError from DELETE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
        createParams({ teamId: TEAM_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to a different team (R-1 IDOR)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: "other-team-999" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("soft deletes by default", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: TEAM_ID });
    mockPrismaTeamPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTeamPasswordEntry.update).toHaveBeenCalled();
  });

  it("permanently deletes when permanent=true", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: TEAM_ID });
    mockPrismaTeamPasswordEntry.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaTeamPasswordEntry.delete).toHaveBeenCalled();
  });
});
