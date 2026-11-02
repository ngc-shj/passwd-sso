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
    tx: { teamMember: { findFirst: vi.fn(), updateMany: vi.fn() } },
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: { teamMember: mockPrismaTeamMember } }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role → permission table: the route re-checks the approver under the lock.
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

// Module-scope snapshot (route.ts `approveLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const approveLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const approveLimiter = mockCreateRateLimiter.mock.results[0]!.value as { check: typeof mockLimiterCheck };

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const APPROVER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_USER_ID = "44444444-4444-4444-8444-444444444444";

/** Disambiguates the two in-tx findFirst reads by their select shape. */
function findFirstBySelect(approverResult: unknown, targetResult: unknown) {
  return vi.fn(async (args: { select?: { keyDistributed?: boolean } }) =>
    args?.select?.keyDistributed ? approverResult : targetResult);
}

function approve(body: Record<string, unknown> = { expectedRole: TEAM_ROLE.MEMBER }, memberId: string = MEMBER_ID) {
  return POST(
    createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members/${memberId}/approve`, { body }),
    createParams({ teamId: TEAM_ID, memberId }),
  );
}

describe("POST /api/teams/[teamId]/members/[memberId]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: APPROVER_ID } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockRequireRecent.mockResolvedValue(null);
    mockLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaTeamMember.findUnique.mockResolvedValue({ teamId: TEAM_ID, userId: TARGET_USER_ID });
    mockLockTenantRows.mockResolvedValue(new Map([
      [APPROVER_ID, { hasRow: true, deactivatedAt: null, departedAt: null }],
      [TARGET_USER_ID, { hasRow: true, deactivatedAt: null, departedAt: null }],
    ]));
    mockLockTeamsAgainstRotation.mockResolvedValue(undefined);
    tx.teamMember.findFirst.mockReset().mockImplementation(
      findFirstBySelect({ role: TEAM_ROLE.ADMIN, keyDistributed: true }, { role: TEAM_ROLE.MEMBER }),
    );
    tx.teamMember.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => approve(),
      limiter: approveLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [tx.teamMember.updateMany, mockLogAuditInTx],
      limiterFactory: approveLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await approve()).status).toBe(401);
  });

  it("returns 404 for a pending member calling approve on their own row (no active team row)", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    expect((await approve()).status).toBe(404);
  });

  it("returns 404 for a tenant ADMIN outside the team", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    expect((await approve()).status).toBe(404);
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecent.mockResolvedValue(Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));
    const res = await approve();
    expect(res.status).toBe(403);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed memberId (not a uuid)", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members/not-a-uuid/approve`, {
        body: { expectedRole: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID, memberId: "not-a-uuid" }),
    );
    expect(res.status).toBe(404);
    expect(mockPrismaTeamMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body (expectedRole: OWNER)", async () => {
    const res = await approve({ expectedRole: TEAM_ROLE.OWNER });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the pre-read target is absent", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    expect((await approve()).status).toBe(404);
  });

  it("returns 404 when the pre-read target belongs to a different team", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({ teamId: "other-team", userId: TARGET_USER_ID });
    expect((await approve()).status).toBe(404);
  });

  it("approves: CAS to active, audits in the transaction", async () => {
    const res = await approve();

    expect(res.status).toBe(200);
    expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
      where: { id: MEMBER_ID, teamId: TEAM_ID, role: TEAM_ROLE.MEMBER, scimApprovalPending: true, deactivatedAt: { not: null } },
      data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
    });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({
      scope: "TEAM",
      action: "TEAM_MEMBER_SCIM_APPROVE",
      teamId: TEAM_ID,
      targetId: TARGET_USER_ID,
      metadata: { memberId: MEMBER_ID, role: TEAM_ROLE.MEMBER },
    }));
  });

  it("locks both tenant rows, then the team, before reading the approver", async () => {
    await approve();

    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "tenant-1", [APPROVER_ID, TARGET_USER_ID], "share", expect.anything());
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]);
    expect(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]).toBeLessThan(tx.teamMember.findFirst.mock.invocationCallOrder[0]);
  });

  it("returns 403, changing nothing, when the approver left or was demoted since the permission check", async () => {
    tx.teamMember.findFirst.mockImplementation(findFirstBySelect(null, { role: TEAM_ROLE.MEMBER }));

    const res = await approve();

    expect(res.status).toBe(403);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 403, changing nothing, for an active team ADMIN without the key", async () => {
    tx.teamMember.findFirst.mockImplementation(
      findFirstBySelect({ role: TEAM_ROLE.ADMIN, keyDistributed: false }, { role: TEAM_ROLE.MEMBER }),
    );

    const res = await approve();

    expect(res.status).toBe(403);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is no longer pending under the lock (a concurrent approve/reject or SCIM withdraw)", async () => {
    tx.teamMember.findFirst.mockImplementation(
      findFirstBySelect({ role: TEAM_ROLE.ADMIN, keyDistributed: true }, null),
    );

    const res = await approve();

    expect(res.status).toBe(404);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 SCIM_APPROVAL_ROLE_CHANGED when the pending row's role no longer matches expectedRole", async () => {
    tx.teamMember.findFirst.mockImplementation(
      findFirstBySelect({ role: TEAM_ROLE.ADMIN, keyDistributed: true }, { role: TEAM_ROLE.ADMIN }),
    );

    const res = await approve({ expectedRole: TEAM_ROLE.MEMBER });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("SCIM_APPROVAL_ROLE_CHANGED");
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the target's tenant row is inactive (A6)", async () => {
    mockLockTenantRows.mockResolvedValue(new Map([
      [APPROVER_ID, { hasRow: true, deactivatedAt: null, departedAt: null }],
      [TARGET_USER_ID, { hasRow: true, deactivatedAt: new Date(), departedAt: null }],
    ]));

    const res = await approve();

    expect(res.status).toBe(409);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the CAS matches no row", async () => {
    tx.teamMember.updateMany.mockResolvedValue({ count: 0 });

    const res = await approve();

    expect(res.status).toBe(409);
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 409 when a rotation holds the team past the lock wait", async () => {
    const { TeamRotationLockError } = await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock");
    mockLockTeamsAgainstRotation.mockRejectedValue(new TeamRotationLockError(1));

    const res = await approve();

    expect(res.status).toBe(409);
    expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  });
});
