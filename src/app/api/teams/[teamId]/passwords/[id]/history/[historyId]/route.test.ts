import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeamPasswordEntry,
  mockPrismaTeamPasswordEntryHistory,
  mockRequireTeamMember,
  TeamAuthError,
  mockWithTeamTenantRls,
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
    mockPrismaTeamPasswordEntry: { findUnique: vi.fn() },
    mockPrismaTeamPasswordEntryHistory: { findUnique: vi.fn() },
    mockRequireTeamMember: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    teamPasswordEntryHistory: mockPrismaTeamPasswordEntryHistory,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { GET } from "./route";

const TEAM_ID = "team-123";
const ENTRY_ID = "entry-456";
const HISTORY_ID = "hist-789";

function makeUrl() {
  return `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${ENTRY_ID}/history/${HISTORY_ID}`;
}

function makeParams() {
  return createParams({ teamId: TEAM_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

describe("GET /api/teams/[teamId]/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamMember.mockResolvedValue({ id: "member-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when not team member", async () => {
    mockRequireTeamMember.mockRejectedValue(
      new TeamAuthError("NOT_A_MEMBER", 403),
    );
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(createRequest("GET", makeUrl()), makeParams()),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry teamId does not match", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({
      teamId: "other-team",
      entryType: "LOGIN",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({
      teamId: TEAM_ID,
      entryType: "LOGIN",
    });
    mockPrismaTeamPasswordEntryHistory.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history entryId does not match", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({
      teamId: TEAM_ID,
      entryType: "LOGIN",
    });
    mockPrismaTeamPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: "other-entry",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns encrypted history blob as-is (E2E mode)", async () => {
    const changedAt = new Date("2025-01-01");
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({
      teamId: TEAM_ID,
      entryType: "LOGIN",
    });
    mockPrismaTeamPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: ENTRY_ID,
      encryptedBlob: "encrypted-blob-data",
      blobIv: "aabbccddee001122",
      blobAuthTag: "aabbccddee0011223344556677889900",
      aadVersion: 1,
      teamKeyVersion: 1,
      changedAt,
    });

    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(HISTORY_ID);
    expect(json.entryId).toBe(ENTRY_ID);
    expect(json.entryType).toBe("LOGIN");
    expect(json.encryptedBlob).toBe("encrypted-blob-data");
    expect(json.blobIv).toBe("aabbccddee001122");
    expect(json.blobAuthTag).toBe("aabbccddee0011223344556677889900");
    expect(json.aadVersion).toBe(1);
    expect(json.teamKeyVersion).toBe(1);
    // Should NOT contain decrypted fields
    expect(json.title).toBeUndefined();
    expect(json.password).toBeUndefined();
  });
});
