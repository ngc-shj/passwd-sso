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
  // The key-holders' tenant-row lock (tenant_members, tenant_member_departures)
  // and the in-tx CAS re-read (SELECT team_key_version FROM teams ... FOR NO KEY UPDATE).
  $queryRaw: vi.fn(),
  // set / restore lock_timeout around the tenant-row lock.
  $executeRaw: vi.fn(),
  team: { update: vi.fn() },
  teamMember: { findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    // The rotating member's role, re-read under the team lock.
    findFirst: vi.fn() },
  teamPasswordEntry: { updateMany: vi.fn(), findMany: vi.fn() },
  // createMany: the new version's rows; findMany: the actor's held versions (carry checks).
  teamMemberKey: { createMany: vi.fn(), findMany: vi.fn() },
  // The key-holders' tenant rows and departure records, read unlocked (readTenantRows).
  tenantMember: { findMany: vi.fn() },
  tenantMemberDeparture: { findMany: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role reads and permission table: routes re-check the actor under their locks.
  activeTeamAdmission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamAdmission,
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
  logAuditInTx: vi.fn(),
  logAuditBulkInTx: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
// The route's success limiter (max 1) is stubbed; the other limiters —
// among them the failed-attempt limiter from rate-limiters.ts — are the real
// in-memory ones, so their bound is what production configures.
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));
vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...actual,
    createRateLimiter: vi.fn((options: Parameters<typeof actual.createRateLimiter>[0]) =>
      options.max === 1
        ? { check: mockRateLimitCheck, clear: mockRateLimitClear }
        : actual.createRateLimiter(options),
    ),
  };
});
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { POST } from "./route";
import { logAuditAsync, logAuditBulkInTx, logAuditInTx } from "@/lib/audit/audit";
import { TEAM_ROTATE_KEY_FAILURE_LIMIT } from "@/lib/security/rate-limiters";
import { TEAM_ROTATE_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { documentedMetadataKeys } from "@/__tests__/helpers/audit-log-reference";
import { teamLockQuery, lockQueryCalls } from "@/__tests__/helpers/team-rotation-lock-mock";

const ACTOR = "660e8400-e29b-41d4-a716-446655440001";
const ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");
/** The rotating member's admission, re-read under the team lock. */
const actorAdmission = (role = "OWNER") => ({ role, admittedAt: ADMITTED_AT, createdAt: ADMITTED_AT });
/** A key-holder's row as the rotation reads it under the team lock. */
const keyHolder = (userId: string, over: Record<string, unknown> = {}) => ({
  userId, admittedAt: ADMITTED_AT, createdAt: ADMITTED_AT, ...over,
});
type TenantState = { userId: string; deactivatedAt?: Date | null; departedAt?: Date | null; hasRow?: boolean };
/** Answer the team's version and the given users' tenant rows / departure records to the real lockTenantRows (the actor's lock). */
const lockedState = (teamKeyVersion = 1, tenants: TenantState[] = []) =>
  teamLockQuery((sql) => {
    if (sql.includes("FROM tenant_members")) {
      return tenants.filter((t) => t.hasRow !== false)
        .map((t) => ({ user_id: t.userId, role: "MEMBER", deactivated_at: t.deactivatedAt ?? null }));
    }
    if (sql.includes("FROM tenant_member_departures")) {
      return tenants.filter((t) => t.departedAt).map((t) => ({ user_id: t.userId, departed_at: t.departedAt }));
    }
    return [{ team_key_version: teamKeyVersion }];
  });
/** The users' tenant state, to both the actor's tenant-row lock and the key-holders' unlocked read. */
const tenantsAre = (tenants: TenantState[]) => {
  txMock.$queryRaw.mockImplementation(lockedState(1, tenants));
  txMock.tenantMember.findMany.mockResolvedValue(
    tenants.filter((t) => t.hasRow !== false)
      .map((t) => ({ userId: t.userId, role: "MEMBER", deactivatedAt: t.deactivatedAt ?? null })),
  );
  txMock.tenantMemberDeparture.findMany.mockResolvedValue(
    tenants.filter((t) => t.departedAt).map((t) => ({ userId: t.userId, departedAt: t.departedAt })),
  );
};

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
      tenantId: "tenant-1",
    });
    txMock.$queryRaw.mockImplementation(lockedState());
    txMock.tenantMember.findMany.mockResolvedValue([]);
    txMock.tenantMemberDeparture.findMany.mockResolvedValue([]);
    txMock.teamMember.findFirst.mockResolvedValue(actorAdmission());
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
    txMock.$queryRaw.mockImplementation(lockedState(2));
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
    const calls = lockQueryCalls(txMock.$queryRaw);
    const tenantRows = calls.find((c) => c.sql.includes("FROM tenant_members"))!;
    const teamLock = calls.find((c) => c.sql.includes("FROM teams"))!;
    expect(teamLock.sql).toMatch(/FROM teams WHERE id = \?::uuid FOR NO KEY UPDATE/);
    expect(teamLock.values).toEqual(["team-1"]);
    // The actor's tenant row, then the team, then the key-holder set.
    expect(tenantRows.order).toBeLessThan(teamLock.order);
    expect(teamLock.order).toBeLessThan(txMock.teamMember.findMany.mock.invocationCallOrder[0]);
    expect(teamLock.order).toBeLessThan(
      txMock.teamPasswordEntry.findMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses (403) without bumping the version when the rotating member no longer holds TEAM_UPDATE under the lock", async () => {
    // Departed, removed or demoted since requireTeamPermission: the rotation
    // would otherwise move the team to a key this actor generated and keeps.
    txMock.teamMember.findFirst.mockResolvedValueOnce(actorAdmission("MEMBER"));

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
      select: { role: true, admittedAt: true, createdAt: true },
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
    // The summary commits with the rotation, after the version bump.
    expect(vi.mocked(logAuditInTx)).toHaveBeenCalledWith(
      txMock,
      "tenant-1",
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
    expect(vi.mocked(logAuditInTx).mock.invocationCallOrder[0]).toBeGreaterThan(
      txMock.team.update.mock.invocationCallOrder[0],
    );
    expect(vi.mocked(logAuditAsync)).not.toHaveBeenCalled();
    // The keys docs/operations/audit-log-reference.md documents for the action.
    expect(Object.keys(vi.mocked(logAuditInTx).mock.calls[0][2].metadata ?? {}).sort())
      .toEqual(documentedMetadataKeys("TEAM_KEY_ROTATION"));
  });

  it("writes no rotation summary when the rotation is refused", async () => {
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
    expect(vi.mocked(logAuditInTx)).not.toHaveBeenCalled();
    expect(vi.mocked(logAuditAsync)).not.toHaveBeenCalled();
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
      where: { teamId: "team-1", keyDistributed: true, OR: [{ deactivatedAt: { not: null } }, { userId: { in: [] } }] },
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

  describe("a key-holder who left the tenant, judged against their admission to the team", () => {
    const HOLDER = "660e8400-e29b-41d4-a716-446655440002";
    const at = (ms: number) => new Date(ADMITTED_AT.getTime() + ms);
    const ENTRY = "660e8400-e29b-41d4-a716-446655440100";
    // A team id per request: the real in-memory failure limiter keeps its
    // count per (team, actor) for the whole file, and these cells refuse often.
    let teamSeq = 0;
    let teamId = "";
    const rotate = (memberUserIds: string[]) => {
      teamSeq += 1;
      teamId = `team-leftover-${teamSeq}`;
      txMock.teamMemberKey.createMany.mockResolvedValue({ count: memberUserIds.length });
      return POST(
        createRequest({
          newTeamKeyVersion: 2,
          entries: [validEntry(ENTRY)],
          memberKeys: memberUserIds.map(validMemberKey),
        }),
        createParams(teamId),
      );
    };
    const holders = (holder = keyHolder(HOLDER)) =>
      txMock.teamMember.findMany.mockResolvedValue([keyHolder(ACTOR), holder]);
    const expectNothingRotated = () => {
      expect(txMock.teamMemberKey.createMany).not.toHaveBeenCalled();
      expect(txMock.teamMember.updateMany).not.toHaveBeenCalled();
      expect(txMock.team.update).not.toHaveBeenCalled();
    };

    it("rotates without a key for a key-holder whose tenant row departed after their admission, and lists them for distribution", async () => {
      holders();
      tenantsAre([{ userId: HOLDER, deactivatedAt: at(1) }]);

      const res = await rotate([ACTOR]);

      expect(res.status).toBe(200);
      expect(txMock.teamMemberKey.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: ACTOR, keyVersion: 2 })],
      });
      expect(txMock.teamMember.updateMany).toHaveBeenCalledWith({
        where: { teamId, keyDistributed: true, OR: [{ deactivatedAt: { not: null } }, { userId: { in: [HOLDER] } }] },
        data: { keyDistributed: false },
      });
    });

    it("refuses a key supplied for a leftover key-holder as for a non-member, rotating nothing", async () => {
      holders();
      tenantsAre([{ userId: HOLDER, deactivatedAt: at(1) }]);

      const res = await rotate([ACTOR, HOLDER]);

      expect(res.status).toBe(400);
      expect((await res.json()).details.unknownUserId).toBe(HOLDER);
      expectNothingRotated();
    });

    it("treats a departure equal to the admission, or a departure record after it, as leftover", async () => {
      for (const state of [
        { userId: HOLDER, deactivatedAt: at(0) },
        { userId: HOLDER, departedAt: at(1), hasRow: false },
      ]) {
        holders();
        tenantsAre([state]);
        const res = await rotate([ACTOR, HOLDER]);
        expect(res.status).toBe(400);
        expect((await res.json()).details.unknownUserId).toBe(HOLDER);
      }
      expectNothingRotated();
    });

    it("still requires a key for a guest, an active, a re-admitted and a re-provisioned key-holder", async () => {
      for (const [state, holder] of [
        [{ userId: HOLDER, hasRow: false }, keyHolder(HOLDER)],
        [{ userId: HOLDER }, keyHolder(HOLDER)],
        // created before the departure, re-admitted after it: admitted_at decides.
        [{ userId: HOLDER, deactivatedAt: at(-1000) }, keyHolder(HOLDER, { createdAt: at(-5000) })],
        [{ userId: HOLDER, departedAt: at(-1000) }, keyHolder(HOLDER)],
      ] as const) {
        holders(holder);
        tenantsAre([state]);
        const res = await rotate([ACTOR]);
        expect(res.status).toBe(400);
        expect((await res.json()).details.missingKeyFor).toBe(HOLDER);
      }
      expectNothingRotated();
    });

    it("refuses (403) an actor whose own tenant row departed after their admission", async () => {
      holders();
      tenantsAre([{ userId: ACTOR, deactivatedAt: at(1) }]);

      const res = await rotate([ACTOR, HOLDER]);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("ACTOR_NOT_PERMITTED");
      expectNothingRotated();
    });

    it("locks only the actor's tenant row before the team row, and reads the key-holders' unlocked after it", async () => {
      holders();

      expect((await rotate([ACTOR, HOLDER])).status).toBe(200);

      const calls = lockQueryCalls(txMock.$queryRaw);
      const tenantLocks = calls.filter((c) => c.sql.includes("FROM tenant_members"));
      const teamLock = calls.find((c) => c.sql.includes("FROM teams"))!;
      expect(tenantLocks).toHaveLength(1);
      expect(tenantLocks[0].values).toEqual(["tenant-1", [ACTOR]]);
      expect(tenantLocks[0].order).toBeLessThan(teamLock.order);
      expect(txMock.tenantMember.findMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", userId: { in: [ACTOR, HOLDER] } },
        select: { userId: true, role: true, deactivatedAt: true },
      });
      expect(teamLock.order).toBeLessThan(txMock.tenantMember.findMany.mock.invocationCallOrder[0]);
    });
  });

  describe("failed-attempt limit", () => {
    const ACTOR = "660e8400-e29b-41d4-a716-446655440001";
    // A team id per test: the real in-memory limiter keeps its count per key
    // for the whole file.
    let teamSeq = 0;
    let teamId = "";
    beforeEach(() => {
      teamSeq += 1;
      teamId = `team-fail-${teamSeq}`;
    });
    const rotate = () =>
      POST(
        createRequest({
          newTeamKeyVersion: 2,
          entries: [validEntry("660e8400-e29b-41d4-a716-446655440100")],
          memberKeys: [validMemberKey(ACTOR)],
        }),
        createParams(teamId),
      );
    const refuse = () => txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 0 });
    const commit = () => txMock.teamPasswordEntry.updateMany.mockResolvedValue({ count: 1 });

    it("refuses with 429 once the failed rotations reach the limit, without opening the transaction", async () => {
      refuse();
      for (let i = 0; i < TEAM_ROTATE_KEY_FAILURE_LIMIT; i++) {
        expect((await rotate()).status).toBe(400);
      }
      mockWithTeamTenantRls.mockClear();
      mockRateLimitClear.mockClear();

      const res = await rotate();
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
      // The success slot it took is released: nothing was rotated.
      expect(mockRateLimitClear).toHaveBeenCalledWith(`rl:team_rotate_key:${teamId}`);
    });

    it("lets a rotation through below the limit, and a committed one resets the count", async () => {
      refuse();
      for (let i = 0; i < TEAM_ROTATE_KEY_FAILURE_LIMIT - 1; i++) {
        expect((await rotate()).status).toBe(400);
      }
      commit();
      expect((await rotate()).status).toBe(200);
      refuse();
      for (let i = 0; i < TEAM_ROTATE_KEY_FAILURE_LIMIT; i++) {
        expect((await rotate()).status).toBe(400);
      }
    });
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
      expect(Object.keys(vi.mocked(logAuditBulkInTx).mock.calls[0][2][0].metadata ?? {}).sort())
        .toEqual(documentedMetadataKeys("TEAM_KEY_ROTATION_CARRY"));
      expect(vi.mocked(logAuditBulkInTx).mock.invocationCallOrder[0]).toBeGreaterThan(
        txMock.team.update.mock.invocationCallOrder[0],
      );
      expect(vi.mocked(logAuditInTx)).toHaveBeenCalledWith(
        txMock,
        "tenant-1",
        expect.objectContaining({
          action: "TEAM_KEY_ROTATION",
          metadata: expect.objectContaining({ entriesRotated: 1, entriesCarried: 1 }),
        }),
      );
    });
  });
});
