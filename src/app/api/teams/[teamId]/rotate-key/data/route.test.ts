import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockWithTeamTenantRls,
  MockTeamAuthError,
  mockTeamFindUnique,
  mockTeamPasswordEntryFindMany,
  mockTeamMemberFindMany,
  mockTeamMemberKeyFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockTeamFindUnique: vi.fn(),
  mockTeamPasswordEntryFindMany: vi.fn(),
  mockTeamMemberFindMany: vi.fn(),
  mockTeamMemberKeyFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: mockTeamFindUnique },
    teamPasswordEntry: { findMany: mockTeamPasswordEntryFindMany },
    teamMember: { findMany: mockTeamMemberFindMany },
    teamMemberKey: { findMany: mockTeamMemberKeyFindMany },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

function createRequest(teamId: string) {
  return new NextRequest(`http://localhost/api/teams/${teamId}/rotate-key/data`, {
    method: "GET",
  });
}

function createParams(teamId: string) {
  return { params: Promise.resolve({ teamId }) };
}

const sampleEntry = {
  id: "00000000-0000-4000-a000-000000000001",
  encryptedBlob: "blob",
  blobIv: "a".repeat(24),
  blobAuthTag: "b".repeat(32),
  encryptedOverview: "overview",
  overviewIv: "c".repeat(24),
  overviewAuthTag: "d".repeat(32),
  teamKeyVersion: 1,
  itemKeyVersion: 1,
  encryptedItemKey: "item-key",
  itemKeyIv: "e".repeat(24),
  itemKeyAuthTag: "f".repeat(32),
  aadVersion: 1,
};

describe("GET /api/teams/[teamId]/rotate-key/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 1 });
    mockTeamPasswordEntryFindMany.mockResolvedValue([sampleEntry]);
    mockTeamMemberFindMany.mockResolvedValue([{ userId: "user-1" }]);
    mockTeamMemberKeyFindMany.mockResolvedValue([
      { userId: "user-1", user: { ecdhPublicKey: "public-key-data" } },
    ]);
    // withTeamTenantRls is called 3 times: team, entries+members, member keys
    mockWithTeamTenantRls.mockImplementation(async (_teamId: string, fn: () => unknown) => fn());
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when user lacks team permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new MockTeamAuthError("FORBIDDEN", 403));
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when team not found and does not fetch entries or member keys", async () => {
    mockTeamFindUnique.mockResolvedValue(null);
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("TEAM_NOT_FOUND");
    // Early return: only 1 withTeamTenantRls call (team findUnique)
    expect(mockWithTeamTenantRls).toHaveBeenCalledTimes(1);
    expect(mockTeamPasswordEntryFindMany).not.toHaveBeenCalled();
    expect(mockTeamMemberFindMany).not.toHaveBeenCalled();
    expect(mockTeamMemberKeyFindMany).not.toHaveBeenCalled();
  });

  it("returns teamKeyVersion, entries, and members on success", async () => {
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teamKeyVersion).toBe(1);
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].id).toBe("00000000-0000-4000-a000-000000000001");
    expect(json.members).toHaveLength(1);
    expect(json.members[0].userId).toBe("user-1");
    expect(json.members[0].ecdhPublicKey).toBe("public-key-data");
  });

  it("excludes members without an ECDH public key", async () => {
    mockTeamMemberFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    mockTeamMemberKeyFindMany.mockResolvedValue([
      { userId: "user-1", user: { ecdhPublicKey: "public-key-data" } },
      { userId: "user-2", user: { ecdhPublicKey: null } },
    ]);
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // user-2 has no ecdhPublicKey and must be filtered out
    expect(json.members).toHaveLength(1);
    expect(json.members[0].userId).toBe("user-1");
  });

  it("returns empty members array when no active members have distributed keys", async () => {
    mockTeamMemberFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.members).toHaveLength(0);
    // teamMemberKey.findMany should not be called when no active members
    expect(mockTeamMemberKeyFindMany).not.toHaveBeenCalled();
    // Only 2 withTeamTenantRls calls: team + entries/members (no memberKeys call)
    expect(mockWithTeamTenantRls).toHaveBeenCalledTimes(2);
  });

  it("returns empty entries array when team has no password entries", async () => {
    mockTeamPasswordEntryFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(0);
  });

  it("scopes queries to teamId via withTeamTenantRls (called 3 times: team, entries+members, memberKeys)", async () => {
    await GET(createRequest("team-abc"), createParams("team-abc"));
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith("team-abc", expect.any(Function));
    // 3 calls: team findUnique, entries+members, memberKeys
    expect(mockWithTeamTenantRls).toHaveBeenCalledTimes(3);
  });

  it("re-throws non-TeamAuthError permission errors", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("DB_CONNECTION_LOST"));
    await expect(GET(createRequest("team-1"), createParams("team-1"))).rejects.toThrow("DB_CONNECTION_LOST");
  });
});
