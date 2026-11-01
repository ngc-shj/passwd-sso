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
    teamMember: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
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
    tx.teamMember.count.mockResolvedValue(0);
    tx.teamMember.findFirst.mockResolvedValue({ id: "tm-target" });
    tx.teamMember.findMany.mockResolvedValue([{ userId: "departed-owner" }]);
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

  it("locks both tenant rows, then the team FOR NO KEY UPDATE, before re-checking ownership", async () => {
    await assign();

    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "tenant-1", [ACTOR_ID, TARGET_ID], "share", expect.anything());
    expect((tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?")).toMatch(/FROM teams WHERE id = \?::uuid FOR NO KEY UPDATE/);
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.teamMember.count.mock.invocationCallOrder[0]);
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
      tx.teamMember.count.mockResolvedValue(1);

      expect((await assign()).status).toBe(409);
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
