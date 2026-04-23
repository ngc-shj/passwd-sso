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
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

const txMock = {
  team: { findUnique: vi.fn(), update: vi.fn() },
  teamMember: { findMany: vi.fn() },
  teamPasswordEntry: { updateMany: vi.fn(), findMany: vi.fn() },
  teamMemberKey: { createMany: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
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
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/auth/session/csrf", () => ({ assertOrigin: vi.fn(() => null) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));

import { POST } from "./route";
import { logAuditAsync } from "@/lib/audit/audit";

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

function validEntry(id: string) {
  return {
    id,
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
    // Interactive transaction: call the callback with tx proxy
    txMock.team.findUnique.mockResolvedValue({ teamKeyVersion: 1 });
    txMock.team.update.mockResolvedValue({});
    txMock.teamMember.findMany.mockResolvedValue([{ userId: "660e8400-e29b-41d4-a716-446655440001" }]);
    txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: "660e8400-e29b-41d4-a716-446655440100" }]);
    txMock.teamMemberKey.createMany.mockResolvedValue({ count: 1 });
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
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
    txMock.team.findUnique.mockResolvedValue({ teamKeyVersion: 2 });
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
    expect(mockTransaction).toHaveBeenCalled();
    expect(vi.mocked(logAuditAsync)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TEAM_KEY_ROTATION",
        teamId: "team-1",
        metadata: expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          entriesRotated: 1,
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
      select: { id: true },
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
});
