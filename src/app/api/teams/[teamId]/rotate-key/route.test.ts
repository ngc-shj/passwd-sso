import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockTeamFindUnique,
  mockTransaction,
  MockTeamAuthError,
  mockWithTeamTenantRls,
  mockRateLimitCheck,
  mockRateLimitClear,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  // The rotation body runs on the context's transaction client, handed over
  // as fn's second argument.
  mockWithTeamTenantRls: vi.fn(
    async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown, _options?: unknown) =>
      fn("tenant-1", txMock),
  ),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockRateLimitClear: vi.fn(),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

const txMock = {
  // The in-tx CAS re-read (SELECT team_key_version FROM teams ... FOR UPDATE).
  $queryRaw: vi.fn(),
  team: { update: vi.fn() },
  teamMember: { findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    // The rotating member's role, re-read under the team lock.
    findFirst: vi.fn().mockResolvedValue({ role: "OWNER" }) },
  teamPasswordEntry: { updateMany: vi.fn(), findMany: vi.fn() },
  // createMany: the new version's rows; findMany: the actor's held versions (carry checks).
  teamMemberKey: { createMany: vi.fn(), findMany: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role reads and permission table: routes re-check the actor under their locks.
  activeTeamRole: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamRole,
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: mockTeamFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  logAuditBulkInTx: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: mockRateLimitClear,
  })),
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { POST } from "./route";
import { logAuditAsync, logAuditBulkInTx } from "@/lib/audit/audit";
import { TEAM_ROTATE_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

function createRequest(body: unknown) {
  return new NextRequest("http://localhost/api/teams/team-1/rotate-key", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function createParams(teamId: string) {
  return { params: Promise.resolve({ teamId }) };
}

const SNAPSHOT_IV = "e".repeat(24);
const SNAPSHOT_OVERVIEW_IV = "9".repeat(24);

function validEntry(id: string) {
  return {
    id,
    snapshotIv: SNAPSHOT_IV,
    snapshotOverviewIv: SNAPSHOT_OVERVIEW_IV,
    encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "ov", iv: "c".repeat(24), authTag: "d".repeat(32) },
    aadVersion: 1,
  };
}

function validMemberKey(userId: string) {
  return {
    userId,
    encryptedTeamKey: "enc-key",
    teamKeyIv: "a".repeat(24),
    teamKeyAuthTag: "b".repeat(32),
    ephemeralPublicKey: "pub-key",
    hkdfSalt: "c".repeat(64),
    keyVersion: 2,
  };
}

describe("POST /api/teams/[teamId]/rotate-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "660e8400-e29b-41d4-a716-446655440001" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockTeamFindUnique.mockResolvedValue({
      teamKeyVersion: 1,
    });
    txMock.$queryRaw.mockResolvedValue([{ team_key_version: 1 }]);
    txMock.team.update.mockResolvedValue({});
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }]);
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: "660e8400-e29b-41d4-a716-446655440100", teamKeyVersion: 1 }]);
    txMock.teamMemberKey.createMany.mockResolvedValue({ count: 1 });
    txMock.teamMemberKey.findMany.mockResolvedValue([{ keyVersion: 1 }]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when version mismatch", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 5, // should be 2
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.details.expected).toBe(2);
  });

  it("returns 400 when member key missing (F-26: checked inside tx)", async () => {
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }, { userId: "660e8400-e29b-41d4-a716-446655440002" }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")], // missing user-2
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.details.missingKeyFor).toBe("660e8400-e29b-41d4-a716-446655440002");
  });

  it("returns 404 when team not found", async () => {
    mockTeamFindUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("TEAM_NOT_FOUND");
  });

  it("returns 403 when user lacks permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(txMock.team.update).not.toHaveBeenCalled();
  });

  it("returns 400 when entries exceed max limit", async () => {
    const tooManyEntries = Array.from({ length: 1001 }, (_, i) => validEntry(`660e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`));
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: tooManyEntries,
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON (Q-4)", async () => {
    const req = new NextRequest("http://localhost/api/teams/team-1/rotate-key", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams("team-1"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when memberKeys contain non-member userId (F-18/S-22, F-26: inside tx)", async () => {
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001"), validMemberKey("660e8400-e29b-41d4-a716-446655440099")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.details.unknownUserId).toBe("660e8400-e29b-41d4-a716-446655440099");
  });

  it("returns 409 when teamKeyVersion changed concurrently (S-17 optimistic lock)", async () => {
    // Pre-read returns version 1, but inside tx it's already been bumped to 2
    txMock.$queryRaw.mockResolvedValue([{ team_key_version: 2 }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("locks the team row FOR NO KEY UPDATE before reading the team's members and entries", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    const [strings, teamId] = txMock.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toMatch(/FROM teams WHERE id = \?::uuid FOR NO KEY UPDATE/);
    expect(teamId).toBe("team-1");
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.teamMember.findMany.mock.invocationCallOrder[0],
    );
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.teamPasswordEntry.findMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses (403) without bumping the version when the rotating member no longer holds TEAM_UPDATE under the lock", async () => {
    // Departed, removed or demoted since requireTeamPermission: the rotation
    // would otherwise move the team to a key this actor generated and keeps.
    txMock.teamMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" });

    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("ACTOR_NOT_PERMITTED");
    expect(txMock.team.update).not.toHaveBeenCalled();
    expect(txMock.teamMemberKey.createMany).not.toHaveBeenCalled();
    expect(txMock.teamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "660e8400-e29b-41d4-a716-446655440001", deactivatedAt: null },
      select: { role: true },
    });
  });

  it("rotates key successfully and logs audit (S-2)", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.teamKeyVersion).toBe(2);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith("team-1", expect.any(Function), {
      timeout: TEAM_ROTATE_TX_TIMEOUT_MS,
    });
    expect(vi.mocked(logAuditAsync)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TEAM_KEY_ROTATION",
        teamId: "team-1",
        metadata: expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          entriesRotated: 1,
          entriesCarried: 0,
          membersUpdated: 1,
        }),
      }),
    );
  });

  it("rotates key successfully with UUID v4 entry IDs", async () => {
    const uuidEntry = "550e8400-e29b-41d4-a716-446655440000";
    txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: uuidEntry }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry(uuidEntry)],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.teamKeyVersion).toBe(2);
    expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: uuidEntry }),
      })
    );
  });

  it("applies a v0 entry only while the row still holds the snapshotted blob", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamPasswordEntry.updateMany.mock.calls[0][0].where).toEqual({
      id: "660e8400-e29b-41d4-a716-446655440100",
      teamId: "team-1",
      itemKeyVersion: 0,
      blobIv: SNAPSHOT_IV,
      overviewIv: SNAPSHOT_OVERVIEW_IV,
    });
  });

  it("applies a v1 entry only while the row still holds the snapshotted ItemKey wrap", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [{
          id: "660e8400-e29b-41d4-a716-446655440100",
          itemKeyVersion: 1,
          snapshotIv: SNAPSHOT_IV,
          encryptedItemKey: { ciphertext: "wrapped", iv: "f".repeat(24), authTag: "b".repeat(32) },
          aadVersion: 1,
        }],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamPasswordEntry.updateMany.mock.calls[0][0].where).toEqual({
      id: "660e8400-e29b-41d4-a716-446655440100",
      teamId: "team-1",
      itemKeyVersion: 1,
      itemKeyIv: SNAPSHOT_IV,
    });
  });

  it("rejects the rotation without bumping the version when an entry changed since the snapshot", async () => {
    // The snapshot predicate matches no row: the entry was edited or restored.
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ENTRY_COUNT_MISMATCH");
    expect(txMock.teamMemberKey.createMany).not.toHaveBeenCalled();
    expect(txMock.team.update).not.toHaveBeenCalled();
  });

  it("rejects an entry without snapshotIv", async () => {
    const { snapshotIv: _omitted, ...entry } = validEntry("660e8400-e29b-41d4-a716-446655440100");
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [entry],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
    expect(txMock.teamPasswordEntry.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when entry count does not match team entries (F-17)", async () => {
    // Team has 3 entries but client submits only 1
    txMock.teamPasswordEntry.findMany.mockResolvedValue([
      { id: "660e8400-e29b-41d4-a716-446655440100" },
      { id: "660e8400-e29b-41d4-a716-446655440101" },
      { id: "660e8400-e29b-41d4-a716-446655440102" },
    ]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ENTRY_COUNT_MISMATCH");
  });

  it("returns 400 when submitted entry IDs do not exactly match team entries", async () => {
    txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: "660e8400-e29b-41d4-a716-446655440100" }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440199")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ENTRY_COUNT_MISMATCH");
  });

  it("passes wrapVersion to TeamMemberKey createMany (F-19)", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [{ ...validMemberKey("660e8400-e29b-41d4-a716-446655440001"), wrapVersion: 1 }],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamMemberKey.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ wrapVersion: 1 }),
        ]),
      }),
    );
  });

  it("lists deactivated members for distribution of the new version, in the rotation transaction", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );

    expect(res.status).toBe(200);
    expect(txMock.teamMember.updateMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", deactivatedAt: { not: null }, keyDistributed: true },
      data: { keyDistributed: false },
    });
    expect(txMock.teamMember.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.team.update.mock.invocationCallOrder[0],
    );
  });

  it("uses newTeamKeyVersion for memberKey creation regardless of payload keyVersion (S-3)", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [{
          ...validMemberKey("660e8400-e29b-41d4-a716-446655440001"),
          keyVersion: 999, // intentionally wrong
        }],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamMemberKey.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ keyVersion: 2 }), // server forces correct version
        ]),
      }),
    );
  });

  it("includes trashed entries in rotation (all-entries policy)", async () => {
    // Team has 2 entries: one active, one trashed.
    // rotate-key must cover ALL entries including trash.
    txMock.teamPasswordEntry.findMany.mockResolvedValue([
      { id: "660e8400-e29b-41d4-a716-446655440100" },
      { id: "660e8400-e29b-41d4-a716-446655440110" },
    ]);
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [
          validEntry("660e8400-e29b-41d4-a716-446655440100"),
          validEntry("660e8400-e29b-41d4-a716-446655440110"),
        ],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledTimes(2);
    // Verify findMany was called without deletedAt filter
    expect(txMock.teamPasswordEntry.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1" },
      select: { id: true, teamKeyVersion: true },
    });
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("succeeds with entries having mixed teamKeyVersions after history restore (F-29)", async () => {
    // Two entries exist — one may have been restored from history with a stale teamKeyVersion.
    // rotate-key should update all entries regardless of their current teamKeyVersion.
    txMock.teamPasswordEntry.findMany.mockResolvedValue([
      { id: "660e8400-e29b-41d4-a716-446655440100" },
      { id: "660e8400-e29b-41d4-a716-446655440101" },
    ]);
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }]);
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [
          validEntry("660e8400-e29b-41d4-a716-446655440100"),
          validEntry("660e8400-e29b-41d4-a716-446655440101"),
        ],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledTimes(2);
  });
  it("rejects a v0 entry without snapshotOverviewIv (the overview is replaced too)", async () => {
    const { snapshotOverviewIv: _omitted, ...entry } = validEntry("660e8400-e29b-41d4-a716-446655440100");
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [entry],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
    expect(txMock.teamPasswordEntry.updateMany).not.toHaveBeenCalled();
  });

  it("releases the limiter slot when the rotation is refused", async () => {
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
    expect(mockRateLimitClear).toHaveBeenCalledWith("rl:team_rotate_key:team-1");
  });

  it("keeps the limiter slot taken after a committed rotation", async () => {
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:team_rotate_key:team-1");
    expect(mockRateLimitClear).not.toHaveBeenCalled();
  });

  it("does not release the slot of a request it refused as rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(
      createRequest({
        newTeamKeyVersion: 2,
        entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
        memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(429);
    expect(mockRateLimitClear).not.toHaveBeenCalled();
  });

  describe("carry (plan C3)", () => {
    const ROTATED = "660e8400-e29b-41d4-a716-446655440100";
    const CARRIED = "660e8400-e29b-41d4-a716-446655440200";

    beforeEach(() => {
      mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 1, tenantId: "tenant-1" });
      txMock.teamPasswordEntry.findMany.mockResolvedValue([
        { id: ROTATED, teamKeyVersion: 1 },
        { id: CARRIED, teamKeyVersion: 1 },
      ]);
    });

    function rotateWithCarry(carry: unknown[]) {
      return POST(
        createRequest({
          newTeamKeyVersion: 2,
          entries: [validEntry(ROTATED)],
          carry,
          memberKeys: [validMemberKey("660e8400-e29b-41d4-a716-446655440001")],
        }),
        createParams("team-1"),
      );
    }

    it("accepts a not_held carry when the actor holds no key at the entry's version, writing nothing to the entry", async () => {
      txMock.teamMemberKey.findMany.mockResolvedValue([]);
      const res = await rotateWithCarry([{ id: CARRIED, teamKeyVersion: 1, reason: "not_held" }]);
      expect(res.status).toBe(200);
      expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledTimes(1);
      expect(txMock.teamPasswordEntry.updateMany.mock.calls[0][0].where.id).toBe(ROTATED);
      expect(txMock.teamMemberKey.findMany).toHaveBeenCalledWith({
        where: { teamId: "team-1", userId: "660e8400-e29b-41d4-a716-446655440001" },
        select: { keyVersion: true },
        orderBy: { keyVersion: "asc" },
      });
    });

    it("refuses a not_held carry by an actor who holds the entry's version (TEAM_ROTATE_KEY_UNAVAILABLE)", async () => {
      const res = await rotateWithCarry([{ id: CARRIED, reason: "not_held" }]);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("TEAM_ROTATE_KEY_UNAVAILABLE");
      expect(txMock.team.update).not.toHaveBeenCalled();
      expect(txMock.teamPasswordEntry.updateMany).not.toHaveBeenCalled();
    });

    it("normalises a team key version below 1 to 1 for the holder check", async () => {
      txMock.teamPasswordEntry.findMany.mockResolvedValue([
        { id: ROTATED, teamKeyVersion: 1 },
        { id: CARRIED, teamKeyVersion: 0 },
      ]);
      const res = await rotateWithCarry([{ id: CARRIED, reason: "not_held" }]);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("TEAM_ROTATE_KEY_UNAVAILABLE");
    });

    it.each(["undecryptable", "key_invalid"])(
      "accepts a %s carry from a holder of the entry's version",
      async (reason) => {
        const res = await rotateWithCarry([{ id: CARRIED, reason }]);
        expect(res.status).toBe(200);
        expect(txMock.teamPasswordEntry.updateMany).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["undecryptable", "key_invalid"])(
      "refuses a %s carry from an actor not holding the entry's version (TEAM_ROTATE_CARRY_INVALID)",
      async (reason) => {
        txMock.teamMemberKey.findMany.mockResolvedValue([{ keyVersion: 2 }]);
        const res = await rotateWithCarry([{ id: CARRIED, reason }]);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe("TEAM_ROTATE_CARRY_INVALID");
        expect(txMock.team.update).not.toHaveBeenCalled();
      },
    );

    it("refuses a carry whose stated version is not the entry's (TEAM_ROTATE_CARRY_INVALID)", async () => {
      txMock.teamMemberKey.findMany.mockResolvedValue([]);
      const res = await rotateWithCarry([{ id: CARRIED, teamKeyVersion: 3, reason: "not_held" }]);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("TEAM_ROTATE_CARRY_INVALID");
    });

    it("refuses when entries plus carry miss an entry (ENTRY_COUNT_MISMATCH)", async () => {
      const res = await rotateWithCarry([]);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("ENTRY_COUNT_MISMATCH");
    });

    it("refuses an entry both rotated and carried (ENTRY_COUNT_MISMATCH)", async () => {
      txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: ROTATED, teamKeyVersion: 1 }]);
      const res = await rotateWithCarry([{ id: ROTATED, reason: "undecryptable" }]);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("ENTRY_COUNT_MISMATCH");
    });

    it("writes one in-transaction audit row per carried entry and counts carries in the summary", async () => {
      const res = await rotateWithCarry([{ id: CARRIED, reason: "undecryptable" }]);
      expect(res.status).toBe(200);
      expect(vi.mocked(logAuditBulkInTx)).toHaveBeenCalledWith(txMock, "tenant-1", [
        expect.objectContaining({
          action: "TEAM_KEY_ROTATION_CARRY",
          userId: "660e8400-e29b-41d4-a716-446655440001",
          teamId: "team-1",
          targetType: "TeamPasswordEntry",
          targetId: CARRIED,
          metadata: { reason: "undecryptable", teamKeyVersion: 1 },
        }),
      ]);
      expect(vi.mocked(logAuditBulkInTx).mock.invocationCallOrder[0]).toBeGreaterThan(
        txMock.team.update.mock.invocationCallOrder[0],
      );
      expect(vi.mocked(logAuditAsync)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TEAM_KEY_ROTATION",
          metadata: expect.objectContaining({ entriesRotated: 1, entriesCarried: 1 }),
        }),
      );
    });
  });
});
