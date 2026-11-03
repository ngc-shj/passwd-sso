import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockRequireRecent,
  mockLimiterCheck,
  mockCreateRateLimiter,
  mockLockTenantRows,
  mockLockTeamsAgainstRotation,
  mockLogAuditInTx,
  mockPrismaTeamMember,
  mockWithTeamTenantRls,
  TeamAuthError,
  tx,
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
    mockRequireTeamPermission: vi.fn(),
    mockRequireRecent: vi.fn(),
    mockLimiterCheck: vi.fn(),
    // Recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn(),
    mockLockTenantRows: vi.fn(),
    mockLockTeamsAgainstRotation: vi.fn(),
    mockLogAuditInTx: vi.fn(),
    mockPrismaTeamMember: { findUnique: vi.fn() },
    // The admission transaction runs as fn(tenantId, tx); the pre-read as fn().
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
      fn("tenant-1", tx)),
    TeamAuthError: _TeamAuthError,
    tx: { teamMember: { findFirst: vi.fn(), deleteMany: vi.fn() } },
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: { teamMember: mockPrismaTeamMember } }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role → permission table: the route re-checks the actor under the lock.
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({ requireRecentCurrentAuthMethod: mockRequireRecent }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter.mockImplementation((_opts: unknown) => ({ check: mockLimiterCheck })),
}));
vi.mock("@/lib/tenant-context", () => ({ withTeamTenantRls: mockWithTeamTenantRls }));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTeamsAgainstRotation: mockLockTeamsAgainstRotation,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));

import { POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

// Module-scope snapshot (route.ts `rejectLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const rejectLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rejectLimiter = mockCreateRateLimiter.mock.results[0]!.value as { check: typeof mockLimiterCheck };

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_USER_ID = "44444444-4444-4444-8444-444444444444";

function reject(memberId: string = MEMBER_ID) {
  return POST(
    createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members/${memberId}/reject`),
    createParams({ teamId: TEAM_ID, memberId }),
  );
}

describe("POST /api/teams/[teamId]/members/[memberId]/reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_ID } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockRequireRecent.mockResolvedValue(null);
    mockLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaTeamMember.findUnique.mockResolvedValue({ teamId: TEAM_ID, userId: TARGET_USER_ID });
    mockLockTenantRows.mockResolvedValue(new Map([
      [ACTOR_ID, { hasRow: true, deactivatedAt: null, departedAt: null }],
      [TARGET_USER_ID, { hasRow: true, deactivatedAt: null, departedAt: null }],
    ]));
    mockLockTeamsAgainstRotation.mockResolvedValue(undefined);
    // Both in-tx findFirst reads share the same `{ role: true }` select shape
    // (unlike approve's, which disambiguates by `keyDistributed`), so the
    // default here distinguishes by CALL ORDER: 1st = the actor, 2nd = the
    // locked target. `mockResolvedValueOnce` in a test always takes priority
    // over this fallback, call for call, regardless of which one it overrides.
    let findFirstCall = 0;
    tx.teamMember.findFirst.mockReset().mockImplementation(async () => {
      findFirstCall += 1;
      return findFirstCall === 1 ? { role: TEAM_ROLE.ADMIN } : { role: TEAM_ROLE.MEMBER };
    });
    tx.teamMember.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => reject(),
      limiter: rejectLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [tx.teamMember.deleteMany, mockLogAuditInTx],
      limiterFactory: rejectLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await reject()).status).toBe(401);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  // Same fixture either way requireTeamPermission answers 404 — a pending
  // member calling on their own row (no active team row), or a tenant ADMIN
  // outside the team: the route does not distinguish them, it just propagates.
  it("propagates requireTeamPermission's 404, changing nothing", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    expect((await reject()).status).toBe(404);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecent.mockResolvedValue(Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));
    const res = await reject();
    expect(res.status).toBe(403);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed memberId (not a uuid)", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members/not-a-uuid/reject`),
      createParams({ teamId: TEAM_ID, memberId: "not-a-uuid" }),
    );
    expect(res.status).toBe(404);
    expect(mockPrismaTeamMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the pre-read target is absent", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    expect((await reject()).status).toBe(404);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 404 when the pre-read target belongs to a different team", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({ teamId: "other-team", userId: TARGET_USER_ID });
    expect((await reject()).status).toBe(404);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("rejects: deletes the pending row, audits in the transaction", async () => {
    const res = await reject();

    expect(res.status).toBe(200);
    expect(tx.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: MEMBER_ID, teamId: TEAM_ID, scimApprovalPending: true },
    });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
      scope: "TEAM",
      action: "TEAM_MEMBER_SCIM_REJECT",
      teamId: TEAM_ID,
      targetId: TARGET_USER_ID,
      metadata: { memberId: MEMBER_ID, role: TEAM_ROLE.MEMBER },
    }));
  });

  it("succeeds (200) for an active team ADMIN without the key — reject needs no key", async () => {
    // No keyDistributed field at all on the actor read (reject's select omits it).
    tx.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.ADMIN });

    expect((await reject()).status).toBe(200);
  });

  it("locks both tenant rows, then the team, before reading the actor", async () => {
    await reject();

    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "tenant-1", [ACTOR_ID, TARGET_USER_ID], "share", expect.anything());
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]);
    expect(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]).toBeLessThan(tx.teamMember.findFirst.mock.invocationCallOrder[0]);
  });

  it("returns 403, changing nothing, when the actor left or was demoted since the permission check", async () => {
    tx.teamMember.findFirst.mockResolvedValueOnce(null);

    const res = await reject();

    expect(res.status).toBe(403);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 403 when the actor was demoted to VIEWER", async () => {
    tx.teamMember.findFirst.mockResolvedValueOnce({ role: TEAM_ROLE.VIEWER });

    const res = await reject();

    expect(res.status).toBe(403);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is no longer pending under the lock (findFirst re-read)", async () => {
    tx.teamMember.findFirst
      .mockResolvedValueOnce({ role: TEAM_ROLE.ADMIN }) // actor
      .mockResolvedValueOnce(null); // locked target, no longer pending

    const res = await reject();

    expect(res.status).toBe(404);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the delete CAS matches no row (race with the findFirst re-read)", async () => {
    tx.teamMember.deleteMany.mockResolvedValue({ count: 0 });

    const res = await reject();

    expect(res.status).toBe(404);
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 409 when a rotation holds the team past the lock wait", async () => {
    const { TeamRotationLockError } = await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock");
    mockLockTeamsAgainstRotation.mockRejectedValue(new TeamRotationLockError(1));

    const res = await reject();

    expect(res.status).toBe(409);
    expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
  });
});
