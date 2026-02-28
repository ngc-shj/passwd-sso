import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamPasswordEntry, mockPrismaTeamFolder, mockPrismaTeam, mockAuditLogCreate, mockRequireTeamPermission, TeamAuthError, mockWithUserTenantRls } = vi.hoisted(() => {
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
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockPrismaTeamFolder: { findUnique: vi.fn() },
    mockPrismaTeam: { findUnique: vi.fn() },
    mockAuditLogCreate: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    teamFolder: mockPrismaTeamFolder,
    team: mockPrismaTeam,
    auditLog: { create: mockAuditLogCreate },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET, POST } from "./route";
import { ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams/[teamId]/passwords", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
    mockPrismaTeamPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when user lacks permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403)
    );
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError from GET", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns encrypted overviews as-is (E2E mode)", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        entryType: ENTRY_TYPE.LOGIN,
        encryptedOverview: "enc-overview",
        overviewIv: "aabbccdd11223344",
        overviewAuthTag: "aabbccdd11223344aabbccdd11223344",
        aadVersion: 1,
        teamKeyVersion: 1,
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
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedOverview).toBe("enc-overview");
    expect(json[0].overviewIv).toBe("aabbccdd11223344");
    expect(json[0].teamKeyVersion).toBe(1);
    expect(json[0].isFavorite).toBe(true);
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    // Should NOT contain decrypted fields
    expect(json[0].title).toBeUndefined();
    expect(json[0].username).toBeUndefined();
  });

  it("filters by entryType when type query param is provided", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { type: "SECURE_NOTE" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "SECURE_NOTE" }),
      })
    );
  });

  it("does not filter by entryType when type param is absent", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    const call = mockPrismaTeamPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters by trash when trash=true", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { trash: "true" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: { not: null } }),
      })
    );
  });

  it("excludes deleted items by default", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("filters by archived when archived=true", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { archived: "true" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: true }),
      })
    );
  });

  it("excludes archived items by default", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: false }),
      })
    );
  });

  it("filters by favorites when favorites=true", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { favorites: "true" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          favorites: { some: { userId: "test-user-id" } },
        }),
      })
    );
  });

  it("filters by tag when tag param is provided", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { tag: "tag-456" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { some: { id: "tag-456" } },
        }),
      })
    );
  });

  it("filters by folder when folder param is provided", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        searchParams: { folder: "folder-789" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockPrismaTeamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamFolderId: "folder-789",
        }),
      })
    );
  });

  it("does not filter by folder when folder param is absent", async () => {
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`),
      createParams({ teamId: TEAM_ID }),
    );
    const call = mockPrismaTeamPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("teamFolderId");
  });
});

describe("POST /api/teams/[teamId]/passwords (E2E)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
    mockPrismaTeam.findUnique.mockResolvedValue({ teamKeyVersion: 1 });
  });

  const validE2EBody = {
    encryptedBlob: { ciphertext: "enc-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "enc-overview", iv: "c".repeat(24), authTag: "d".repeat(32) },
    aadVersion: 1,
    teamKeyVersion: 1,
    entryType: "LOGIN",
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when POST permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError from POST", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on invalid E2E body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { encryptedBlob: { ciphertext: "x", iv: "short", authTag: "y" } },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when teamKeyVersion does not match team's current version (S-15)", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue({ teamKeyVersion: 2 });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, teamKeyVersion: 1 }, // stale version
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("returns 409 when team not found (Q-9)", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("creates E2E entry with pre-encrypted blobs (201)", async () => {
    mockPrismaTeamPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.entryType).toBe("LOGIN");
    expect(mockPrismaTeamPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedBlob: "enc-blob",
          blobIv: "a".repeat(24),
          blobAuthTag: "b".repeat(32),
          encryptedOverview: "enc-overview",
          overviewIv: "c".repeat(24),
          overviewAuthTag: "d".repeat(32),
          aadVersion: 1,
          teamKeyVersion: 1,
          entryType: "LOGIN",
          teamId: TEAM_ID,
          createdById: "test-user-id",
          updatedById: "test-user-id",
        }),
      }),
    );
  });

  it("creates entry with tags connected", async () => {
    const TAG_CUID = "cm1234567890abcdefghijkl0";
    mockPrismaTeamPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [{ id: TAG_CUID, name: "Work", color: "#ff0000" }],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, tagIds: [TAG_CUID] },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaTeamPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: { connect: [{ id: TAG_CUID }] },
        }),
      }),
    );
  });

  it("creates entry with teamFolderId when folder belongs to same team", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamFolder.findUnique.mockResolvedValue({ teamId: TEAM_ID });
    mockPrismaTeamPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaTeamPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ teamFolderId: FOLDER_CUID }),
      }),
    );
  });

  it("returns 400 when teamFolderId belongs to a different team", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamFolder.findUnique.mockResolvedValue({ teamId: "other-team-999" });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("returns 400 when teamFolderId does not exist", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaTeamFolder.findUnique.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, teamFolderId: FOLDER_CUID },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("creates entry with requireReprompt and expiresAt", async () => {
    mockPrismaTeamPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, {
        body: { ...validE2EBody, requireReprompt: true, expiresAt: "2026-12-31T00:00:00+00:00" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaTeamPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requireReprompt: true,
          expiresAt: new Date("2026-12-31T00:00:00+00:00"),
        }),
      }),
    );
  });

  it("creates entry without folder validation when teamFolderId is not provided", async () => {
    mockPrismaTeamPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords`, { body: validE2EBody }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaTeamFolder.findUnique).not.toHaveBeenCalled();
  });
});
