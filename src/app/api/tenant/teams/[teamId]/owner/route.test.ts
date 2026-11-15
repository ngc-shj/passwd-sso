import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockRequireRecent,
  mockLimiterCheck,
  mockCreateRateLimiter,
  mockLockTenantRows,
  mockWithBoundedLockWait,
  mockLogAuditInTx,
  tx,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockRequireRecent: vi.fn(),
  mockLimiterCheck: vi.fn(),
  // Recording factory — assertRedisFailClosed's factory-attribution step
  // reads mockCreateRateLimiter.mock.{calls,results}.
  mockCreateRateLimiter: vi.fn(),
  mockLockTenantRows: vi.fn(),
  mockWithBoundedLockWait: vi.fn(),
  mockLogAuditInTx: vi.fn(),
  tx: {
    team: { findUnique: vi.fn() },
    teamMember: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    // Read by the real readTenantRows for the OWNER rows' tenant rows.
    tenantMember: { findMany: vi.fn() },
    tenantMemberDeparture: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", async () => ({
  requireTenantPermission: mockRequireTenantPermission,
  // The real role → permission table: the route re-checks the actor's role under the lock.
  hasTenantPermission: (await vi.importActual<typeof import("@/lib/auth/access/tenant-auth")>("@/lib/auth/access/tenant-auth")).hasTenantPermission,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({ requireRecentCurrentAuthMethod: mockRequireRecent }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter.mockImplementation((_opts: unknown) => ({ check: mockLimiterCheck })),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(tx),
}));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBoundedLockWait: mockWithBoundedLockWait,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  logAuditAsync: vi.fn(),
}));

import { POST } from "./route";
import { TENANT_ROLE, TEAM_ROLE } from "@/lib/constants";
import type { LockedTenantRow } from "@/lib/team/tenant-row-lock";

// Module-scope snapshot (route.ts `ownerAssignLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const ownerAssignLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const ownerAssignLimiter = mockCreateRateLimiter.mock.results[0]!.value as { check: typeof mockLimiterCheck };

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

// The actor's row carries their tenant role as of the lock (ADMIN unless a cell says otherwise).
const active: LockedTenantRow = { hasRow: true, role: "ADMIN", deactivatedAt: null, departedAt: null };
const left: LockedTenantRow = { hasRow: true, role: "ADMIN", deactivatedAt: new Date(), departedAt: null };
const activeOwner: LockedTenantRow = { ...active, role: "OWNER" };

const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const OWNER2_ID = "55555555-5555-4555-8555-555555555555";
const ADMITTED = new Date("2026-01-01T00:00:00.000Z");
const BEFORE = new Date("2025-12-01T00:00:00.000Z");
const AFTER = new Date("2026-02-01T00:00:00.000Z");

type OwnerRow = { userId: string; admittedAt: Date | null; createdAt: Date };
type TenantFixture = {
  rows?: { userId: string; deactivatedAt?: Date | null }[];
  departures?: { userId: string; departedAt: Date }[];
};

// The team's active OWNER rows (the HAS_OWNER read) and the other OWNER rows
// demoted on assignment are both teamMember.findMany: told apart by the
// `deactivatedAt: null` filter only the first carries.
function seedOwners(owners: OwnerRow[], demoted: { userId: string }[] = owners.map((o) => ({ userId: o.userId }))) {
  tx.teamMember.findMany.mockImplementation(async (args: { where: { deactivatedAt?: unknown } }) =>
    "deactivatedAt" in args.where ? owners : demoted);
}

// The tenant rows readTenantRows reads for the OWNER rows' users.
function seedTenant({ rows = [], departures = [] }: TenantFixture) {
  const inIds = (args: { where: { userId: { in: string[] } } }) => args.where.userId.in;
  tx.tenantMember.findMany.mockImplementation(async (args: { where: { userId: { in: string[] } } }) =>
    rows.filter((r) => inIds(args).includes(r.userId))
      .map((r) => ({ userId: r.userId, role: "MEMBER", deactivatedAt: r.deactivatedAt ?? null })));
  tx.tenantMemberDeparture.findMany.mockImplementation(async (args: { where: { userId: { in: string[] } } }) =>
    departures.filter((d) => inIds(args).includes(d.userId)));
}

function assign(userId: string = TARGET_ID) {
  return POST(
    createRequest("POST", `http://localhost:3000/api/tenant/teams/${TEAM_ID}/owner`, { body: { userId } }),
    createParams({ teamId: TEAM_ID }),
  );
}

describe("POST /api/tenant/teams/[teamId]/owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_ID } });
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });
    mockRequireRecent.mockResolvedValue(null);
    mockLimiterCheck.mockResolvedValue({ allowed: true });
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [TARGET_ID, active]]));
    mockWithBoundedLockWait.mockImplementation(async (_tx: unknown, lock: () => Promise<unknown>) => lock());
    tx.team.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    tx.teamMember.findFirst.mockResolvedValue({ id: "tm-target", admittedAt: null, createdAt: ADMITTED });
    seedOwners([], [{ userId: "departed-owner" }]);
    seedTenant({});
    tx.teamMember.updateMany.mockResolvedValue({ count: 1 });
    tx.teamMember.update.mockResolvedValue({});
    tx.$queryRaw.mockResolvedValue([{ id: TEAM_ID }]);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => assign(),
      limiter: ownerAssignLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [tx.teamMember.update, tx.teamMember.updateMany, mockLogAuditInTx],
      limiterFactory: ownerAssignLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("assigns the OWNER, demotes the departed owner and audits in the transaction", async () => {
    const res = await assign();

    expect(res.status).toBe(200);
    expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, role: TEAM_ROLE.OWNER, id: { not: "tm-target" } },
      data: { role: TEAM_ROLE.ADMIN },
    });
    expect(tx.teamMember.update).toHaveBeenCalledWith({ where: { id: "tm-target" }, data: { role: TEAM_ROLE.OWNER } });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
      action: "TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN",
      teamId: TEAM_ID,
      metadata: { targetUserId: TARGET_ID, demotedUserIds: ["departed-owner"], selfAssigned: false },
    }));
  });

  it("locks, records and answers the target by its canonical (lowercase) id when given in uppercase", async () => {
    // Hex letters: an all-digit id reads the same in either case.
    const target = "abcdef12-3456-4789-8abc-def123456789";
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [target, active]]));

    const res = await assign(target.toUpperCase());

    expect(res.status).toBe(200);
    expect((await res.json()).ownerUserId).toBe(target);
    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "tenant-1", [ACTOR_ID, target], "share", expect.anything());
    expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
      metadata: expect.objectContaining({ targetUserId: target }),
    }));
  });

  it("locks both tenant rows, then the team FOR NO KEY UPDATE, before re-checking ownership", async () => {
    await assign();

    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "tenant-1", [ACTOR_ID, TARGET_ID], "share", expect.anything());
    expect((tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?")).toMatch(/FROM teams WHERE id = \?::uuid FOR NO KEY UPDATE/);
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.teamMember.findMany.mock.invocationCallOrder[0]);
  });

  describe("refusals change nothing and audit nothing", () => {
    const nothingChanged = () => {
      expect(tx.teamMember.update).not.toHaveBeenCalled();
      expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    };

    it("a caller without TEAM_OWNER_ASSIGN (a team ADMIN, a tenant MEMBER)", async () => {
      const { TenantAuthError } = await vi.importActual<typeof import("@/lib/auth/access/tenant-auth")>("@/lib/auth/access/tenant-auth");
      mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

      expect((await assign()).status).toBe(403);
      nothingChanged();
    });

    it("a team of another tenant (404)", async () => {
      tx.team.findUnique.mockResolvedValue({ tenantId: "tenant-2" });

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("a team that has an active OWNER (409)", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED }]);
      seedTenant({ rows: [{ userId: OWNER_ID }] });

      expect((await assign()).status).toBe(409);
      nothingChanged();
    });

    it("a team whose OWNER was re-admitted after their tenant departure (409: not a leftover)", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: AFTER, createdAt: BEFORE }]);
      seedTenant({ rows: [{ userId: OWNER_ID }], departures: [{ userId: OWNER_ID, departedAt: ADMITTED }] });

      expect((await assign()).status).toBe(409);
      nothingChanged();
    });

    it("a team whose OWNER is a guest with no tenant row here (409: not a leftover)", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED }]);
      seedTenant({});

      expect((await assign()).status).toBe(409);
      nothingChanged();
    });

    it("a team with a leftover OWNER row AND a live one (409)", async () => {
      seedOwners([
        { userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED },
        { userId: OWNER2_ID, admittedAt: null, createdAt: ADMITTED },
      ]);
      seedTenant({ rows: [{ userId: OWNER_ID }, { userId: OWNER2_ID }], departures: [{ userId: OWNER_ID, departedAt: AFTER }] });

      expect((await assign()).status).toBe(409);
      nothingChanged();
    });

    it("a target whose membership is a leftover (departed at or after admission)", async () => {
      mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [TARGET_ID, { ...active, departedAt: AFTER }]]));

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("a target whose departure equals their admission (the boundary counts as leftover)", async () => {
      mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [TARGET_ID, { ...active, departedAt: ADMITTED }]]));

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("an OWNER-row tenant read that fails propagates, never read as \"not leftover\"", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED }]);
      tx.tenantMemberDeparture.findMany.mockRejectedValue(new Error("db down"));

      await expect(assign()).rejects.toThrow("db down");
      nothingChanged();
    });

    it("a target who left the tenant", async () => {
      mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [TARGET_ID, left]]));

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("an actor who left the tenant since the permission check", async () => {
      mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, left], [TARGET_ID, active]]));

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("a target who is not an active member of the team", async () => {
      tx.teamMember.findFirst.mockResolvedValue(null);

      expect((await assign()).status).toBe(404);
      nothingChanged();
    });

    it("a stale step-up", async () => {
      mockRequireRecent.mockResolvedValue(Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));

      expect((await assign()).status).toBe(403);
      nothingChanged();
    });

    it("self-assignment by a tenant ADMIN", async () => {
      const res = await assign(ACTOR_ID);

      expect(res.status).toBe(403);
      expect(mockLockTenantRows).not.toHaveBeenCalled();
      nothingChanged();
    });
  });

  describe("a leftover OWNER counts as absent", () => {
    it("assigns, demoting the leftover OWNER row to ADMIN", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED }]);
      seedTenant({ rows: [{ userId: OWNER_ID }], departures: [{ userId: OWNER_ID, departedAt: AFTER }] });

      const res = await assign();

      expect(res.status).toBe(200);
      expect(tx.tenantMemberDeparture.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: "tenant-1", userId: { in: [OWNER_ID] } },
      }));
      expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, role: TEAM_ROLE.OWNER, id: { not: "tm-target" } },
        data: { role: TEAM_ROLE.ADMIN },
      });
      expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
        metadata: expect.objectContaining({ demotedUserIds: [OWNER_ID] }),
      }));
    });

    it("assigns when the OWNER's departure equals their admission (boundary)", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: ADMITTED, createdAt: BEFORE }]);
      seedTenant({ rows: [{ userId: OWNER_ID }], departures: [{ userId: OWNER_ID, departedAt: ADMITTED }] });

      expect((await assign()).status).toBe(200);
    });

    it("assigns when the OWNER's tenant row is deactivated but the team row was missed", async () => {
      seedOwners([{ userId: OWNER_ID, admittedAt: null, createdAt: ADMITTED }]);
      seedTenant({ rows: [{ userId: OWNER_ID, deactivatedAt: AFTER }] });

      expect((await assign()).status).toBe(200);
    });
  });

  it("assigns a target re-admitted after their tenant departure (not a leftover)", async () => {
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active], [TARGET_ID, { ...active, departedAt: ADMITTED }]]));
    tx.teamMember.findFirst.mockResolvedValue({ id: "tm-target", admittedAt: AFTER, createdAt: BEFORE });

    expect((await assign()).status).toBe(200);
    expect(tx.teamMember.update).toHaveBeenCalledWith({ where: { id: "tm-target" }, data: { role: TEAM_ROLE.OWNER } });
  });

  it("answers 409 TEAM_BUSY with Retry-After, changing nothing, when the team row lock wait times out", async () => {
    const { TeamRotationInProgressError } = await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock");
    mockWithBoundedLockWait.mockRejectedValue(new TeamRotationInProgressError());

    const res = await assign();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(tx.teamMember.update).not.toHaveBeenCalled();
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("answers 409 CONFLICT without Retry-After, changing nothing, when a tenant row lock wait times out", async () => {
    const { TenantMemberLockTimeoutError } = await vi.importActual<typeof import("@/lib/team/tenant-row-lock")>("@/lib/team/tenant-row-lock");
    mockLockTenantRows.mockRejectedValue(new TenantMemberLockTimeoutError());

    const res = await assign();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(tx.teamMember.update).not.toHaveBeenCalled();
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("refuses (403), changing nothing, when the actor was demoted to tenant MEMBER after the permission check", async () => {
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, { ...active, role: "MEMBER" }], [TARGET_ID, active]]));

    expect((await assign()).status).toBe(403);
    expect(tx.teamMember.update).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("refuses self-assignment by an actor who was tenant OWNER at the check but is ADMIN under the lock", async () => {
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.OWNER });
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, active]]));

    expect((await assign(ACTOR_ID)).status).toBe(403);
    expect(tx.teamMember.update).not.toHaveBeenCalled();
  });

  it("allows self-assignment by the tenant OWNER, recorded as such", async () => {
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.OWNER });
    mockLockTenantRows.mockResolvedValue(new Map([[ACTOR_ID, activeOwner]]));

    const res = await assign(ACTOR_ID);

    expect(res.status).toBe(200);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
      metadata: expect.objectContaining({ selfAssigned: true }),
    }));
  });
});
