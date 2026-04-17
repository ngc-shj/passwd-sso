import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTeamMember,
  mockEntryFindUnique,
  mockHistoryFindMany,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamMember: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindMany: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return { requireTeamMember: mockRequireTeamMember, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    teamPasswordEntryHistory: { findMany: mockHistoryFindMany },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { GET } from "./route";
import { TeamAuthError } from "@/lib/team-auth";

const TEAM_ID = "team-1";
const ENTRY_ID = "entry-1";

function makeParams() {
  return createParams({ teamId: TEAM_ID, id: ENTRY_ID });
}

describe("GET /api/teams/[teamId]/passwords/[id]/history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when not a team member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(createRequest("GET"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to a different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await GET(createRequest("GET"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns history list with take:20 applied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: TEAM_ID });
    const changedAt = new Date("2025-06-01");
    mockHistoryFindMany.mockResolvedValue([
      {
        id: "h1",
        entryId: ENTRY_ID,
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        aadVersion: 1,
        teamKeyVersion: 2,
        itemKeyVersion: null,
        changedAt,
        changedBy: { id: "u1", name: "Admin", email: "admin@test.com" },
      },
    ]);

    const res = await GET(createRequest("GET"), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedBlob).toEqual({ ciphertext: "cipher", iv: "iv", authTag: "tag" });
    expect(json[0].teamKeyVersion).toBe(2);
    expect(json[0].changedBy.name).toBe("Admin");

    // Verify take:20 is passed to findMany
    expect(mockHistoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it("returns empty array when no history exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: TEAM_ID });
    mockHistoryFindMany.mockResolvedValue([]);

    const res = await GET(createRequest("GET"), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toEqual([]);
  });
});
