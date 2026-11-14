import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockWithTeamTenantRls,
  mockWithBypassRls,
  MockTeamAuthError,
  mockTeamFindUnique,
  mockTeamPasswordEntryFindMany,
  mockTeamMemberFindMany,
  mockTeamMemberKeyFindMany,
  mockUserFindMany,
  mockTenantMemberFindMany,
  mockTenantMemberDepartureFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string) => unknown) => fn("tenant-1")),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
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
  mockUserFindMany: vi.fn(),
  // The key-holders' tenant rows and departure records (readTenantRows).
  mockTenantMemberFindMany: vi.fn(),
  mockTenantMemberDepartureFindMany: vi.fn(),
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
    user: { findMany: mockUserFindMany },
    tenantMember: { findMany: mockTenantMemberFindMany },
    tenantMemberDeparture: { findMany: mockTenantMemberDepartureFindMany },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
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
    mockTeamMemberKeyFindMany.mockResolvedValue([{ userId: "user-1" }]);
    mockUserFindMany.mockResolvedValue([{ id: "user-1", ecdhPublicKey: "public-key-data" }]);
    // withTeamTenantRls is called 3 times: team, entries+members, member keys
    mockWithTeamTenantRls.mockImplementation(async (_teamId: string, fn: (tenantId: string) => unknown) => fn("tenant-1"));
    mockTenantMemberFindMany.mockResolvedValue([]);
    mockTenantMemberDepartureFindMany.mockResolvedValue([]);
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
    expect(mockUserFindMany).not.toHaveBeenCalled();
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
    mockTeamMemberKeyFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    mockUserFindMany.mockResolvedValue([
      { id: "user-1", ecdhPublicKey: "public-key-data" },
      { id: "user-2", ecdhPublicKey: null },
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
    // The per-member key read is skipped when no active members; the only
    // member-key read is the caller's own held versions.
    expect(mockTeamMemberKeyFindMany).toHaveBeenCalledTimes(1);
    expect(mockTeamMemberKeyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-1", userId: "user-1" } }),
    );
    expect(mockUserFindMany).not.toHaveBeenCalled();
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

  it("uses bypass user lookup so cross-tenant guests remain eligible for rotation", async () => {
    mockTeamMemberFindMany.mockResolvedValue([{ userId: "owner-user" }, { userId: "guest-user" }]);
    mockTeamMemberKeyFindMany.mockResolvedValue([{ userId: "owner-user" }, { userId: "guest-user" }]);
    mockUserFindMany.mockResolvedValue([
      { id: "owner-user", ecdhPublicKey: "owner-public-key" },
      { id: "guest-user", ecdhPublicKey: "guest-public-key" },
    ]);

    const res = await GET(createRequest("team-1"), createParams("team-1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockUserFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["owner-user", "guest-user"] } },
      select: { id: true, ecdhPublicKey: true },
    });
    expect(json.members).toEqual([
      { userId: "owner-user", ecdhPublicKey: "owner-public-key" },
      { userId: "guest-user", ecdhPublicKey: "guest-public-key" },
    ]);
  });

  describe("a key-holder who left the tenant, judged against their admission to the team", () => {
    const ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");
    const at = (ms: number) => new Date(ADMITTED_AT.getTime() + ms);
    const holder = (userId: string, over: Record<string, unknown> = {}) => ({
      userId, admittedAt: ADMITTED_AT, createdAt: ADMITTED_AT, ...over,
    });
    /** user-1 is active; user-2's tenant state is given. */
    const state = (
      user2: { deactivatedAt?: Date | null; departedAt?: Date | null; hasRow?: boolean },
      user2Row = holder("user-2"),
    ) => {
      mockTeamMemberFindMany.mockResolvedValue([holder("user-1"), user2Row]);
      mockTenantMemberFindMany.mockResolvedValue([
        { userId: "user-1", role: "MEMBER", deactivatedAt: null },
        ...(user2.hasRow === false ? [] : [{ userId: "user-2", role: "MEMBER", deactivatedAt: user2.deactivatedAt ?? null }]),
      ]);
      mockTenantMemberDepartureFindMany.mockResolvedValue(
        user2.departedAt ? [{ userId: "user-2", departedAt: user2.departedAt }] : [],
      );
      mockTeamMemberKeyFindMany.mockImplementation(async ({ where }: { where: { userId: unknown } }) => {
        const ids = (where.userId as { in?: string[] }).in;
        return ids ? ids.map((userId) => ({ userId })) : [{ keyVersion: 1 }];
      });
      mockUserFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, ecdhPublicKey: `pk-${id}` })));
    };
    const listed = async () => {
      const res = await GET(createRequest("team-1"), createParams("team-1"));
      expect(res.status).toBe(200);
      return ((await res.json()).members as { userId: string }[]).map((m) => m.userId);
    };

    it("leaves out a key-holder whose tenant row departed after, or at, their admission", async () => {
      for (const departed of [{ deactivatedAt: at(1) }, { deactivatedAt: at(0) }, { departedAt: at(1), hasRow: false }]) {
        state(departed);
        expect(await listed()).toEqual(["user-1"]);
      }
      expect(mockTenantMemberFindMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", userId: { in: ["user-1", "user-2"] } },
        select: { userId: true, role: true, deactivatedAt: true },
      });
    });

    it("lists a guest, an active, a re-admitted and a re-provisioned key-holder", async () => {
      for (const [user2, row] of [
        [{ hasRow: false }, holder("user-2")],
        [{}, holder("user-2")],
        // created before the departure, re-admitted after it: admitted_at decides.
        [{ deactivatedAt: at(-1000) }, holder("user-2", { createdAt: at(-5000) })],
        [{ departedAt: at(-1000) }, holder("user-2")],
      ] as const) {
        state(user2, row);
        expect(await listed()).toEqual(["user-1", "user-2"]);
      }
    });
  });

  it("re-throws non-TeamAuthError permission errors", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("DB_CONNECTION_LOST"));
    await expect(GET(createRequest("team-1"), createParams("team-1"))).rejects.toThrow("DB_CONNECTION_LOST");
  });
  it("returns the caller's held team key versions and each entry's version, overview IV and ItemKey id", async () => {
    // Two member-key reads: the caller's held versions (where.userId is the
    // caller) and the latest key per active member.
    mockTeamMemberKeyFindMany.mockImplementation(async (args: { where: { userId: unknown } }) =>
      args.where.userId === "user-1" ? [{ keyVersion: 1 }, { keyVersion: 3 }] : [{ userId: "user-1" }],
    );
    mockTeamPasswordEntryFindMany.mockResolvedValue([{ ...sampleEntry, itemKeyId: "item-key-id-1" }]);

    const res = await GET(createRequest("team-1"), createParams("team-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.actorKeyVersions).toEqual([1, 3]);
    expect(json.entries[0]).toMatchObject({
      teamKeyVersion: 1,
      overviewIv: "c".repeat(24),
      itemKeyId: "item-key-id-1",
    });
    expect(mockTeamMemberKeyFindMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "user-1" },
      select: { keyVersion: true },
      orderBy: { keyVersion: "asc" },
    });
    expect(mockTeamPasswordEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ teamKeyVersion: true, overviewIv: true, itemKeyId: true }),
      }),
    );
  });
});
