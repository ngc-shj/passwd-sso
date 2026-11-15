import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { teamLockQuery } from "@/__tests__/helpers/team-rotation-lock-mock";

const { mockAuth, mockTx, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockLogAuditInTx, mockTeamLockQuery } = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  const mockTeamLockQuery = vi.fn();
  const mockTx = {
    $queryRaw: mockTeamLockQuery,
    $executeRaw: vi.fn(),
    teamMember: { findFirst: vi.fn() },
    teamInvitation: { findFirst: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
  };
  return {
    mockAuth: vi.fn(),
    mockTx,
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
      fn("tenant-1", mockTx)),
    mockLogAuditInTx: vi.fn(),
    mockTeamLockQuery,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth");
  return {
    requireTeamPermission: mockRequireTeamPermission,
    // The real role reads and permission table: the route re-checks the actor under its locks.
    activeTeamAdmission: actual.activeTeamAdmission,
    hasTeamPermission: actual.hasTeamPermission,
    TeamAuthError,
  };
});
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  teamAuditBase: vi.fn((_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId })),
}));

import { DELETE } from "./route";
import { AUDIT_TARGET_TYPE, TEAM_ROLE } from "@/lib/constants";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

const TEAM_ID = "team-123";
const INV_ID = "inv-456";
const ACTOR_ID = "test-user-id";
const ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");

const cancel = () =>
  DELETE(
    createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
    createParams({ teamId: TEAM_ID, invId: INV_ID }),
  );

/** Answer the actor's tenant row and departure record to the real lockTenantRows. */
function actorTenantState(deactivatedAt: Date | null, departedAt: Date | null = null, hasRow = true) {
  mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
    if (sql.includes("FROM tenant_members")) {
      return hasRow ? [{ user_id: ACTOR_ID, role: "MEMBER", deactivated_at: deactivatedAt }] : [];
    }
    if (sql.includes("FROM tenant_member_departures")) {
      return departedAt ? [{ user_id: ACTOR_ID, departed_at: departedAt }] : [];
    }
    return [{ id: TEAM_ID }];
  }));
}

describe("DELETE /api/teams/[teamId]/invitations/[invId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_ID } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    actorTenantState(null);
    mockTx.$executeRaw.mockResolvedValue(1);
    mockTx.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.ADMIN, admittedAt: ADMITTED_AT, createdAt: ADMITTED_AT });
    mockTx.teamInvitation.findFirst.mockResolvedValue({ email: "invitee@example.com", role: TEAM_ROLE.MEMBER });
    mockTx.teamInvitation.deleteMany.mockResolvedValue({ count: 1 });
    mockLogAuditInTx.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await cancel();
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await cancel();
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(cancel()).rejects.toThrow("unexpected");
  });

  it("returns 404 when invitation not found", async () => {
    mockTx.teamInvitation.findFirst.mockResolvedValue(null);
    const res = await cancel();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("looks the invitation up scoped to this team, so another team's invitation is not found", async () => {
    await cancel();
    expect(mockTx.teamInvitation.findFirst).toHaveBeenCalledWith({
      where: { id: INV_ID, teamId: TEAM_ID },
      select: { email: true, role: true },
    });
  });

  it("returns 404 and writes no audit row when the delete matches no row", async () => {
    mockTx.teamInvitation.deleteMany.mockResolvedValue({ count: 0 });
    const res = await cancel();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("deletes the invitation with exactly { id, teamId } and audits it in the transaction", async () => {
    const res = await cancel();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTx.teamInvitation.deleteMany).toHaveBeenCalledWith({ where: { id: INV_ID, teamId: TEAM_ID } });
    expect(mockTx.teamInvitation.delete).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(mockTx, "tenant-1", expect.objectContaining({
      scope: "TEAM",
      userId: ACTOR_ID,
      teamId: TEAM_ID,
      action: "TEAM_MEMBER_INVITE_CANCEL",
      targetType: AUDIT_TARGET_TYPE.TEAM_INVITATION,
      targetId: INV_ID,
      metadata: { email: "invitee@example.com", role: TEAM_ROLE.MEMBER },
    }));
  });

  it("runs in one transaction with the membership timeout", async () => {
    await cancel();
    expect(mockWithTeamTenantRls).toHaveBeenCalledTimes(1);
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith(TEAM_ID, expect.any(Function), { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS });
  });

  it("re-reads the actor's authority after the tenant-row and team locks", async () => {
    await cancel();
    const lockOrders = mockTeamLockQuery.mock.invocationCallOrder;
    expect(lockOrders.length).toBeGreaterThan(0);
    expect(Math.max(...lockOrders)).toBeLessThan(mockTx.teamMember.findFirst.mock.invocationCallOrder[0]);
    expect(mockTx.teamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, userId: ACTOR_ID, deactivatedAt: null },
      select: { role: true, admittedAt: true, createdAt: true },
    });
  });

  it("answers 403, deleting nothing, when the actor left the team since the permission check", async () => {
    mockTx.teamMember.findFirst.mockResolvedValue(null);
    const res = await cancel();
    expect(res.status).toBe(403);
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("answers 403, deleting nothing, when the actor was demoted below MEMBER_INVITE", async () => {
    mockTx.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.MEMBER, admittedAt: ADMITTED_AT, createdAt: ADMITTED_AT });
    const res = await cancel();
    expect(res.status).toBe(403);
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  describe("an acting admin who left the tenant, judged against their admission to the team", () => {
    const after = (ms: number) => new Date(ADMITTED_AT.getTime() + ms);

    it.each([
      ["a deactivated tenant row after admission", () => actorTenantState(after(1))],
      ["a departure record after admission", () => actorTenantState(null, after(1))],
      ["a departure at exactly the admission instant", () => actorTenantState(null, after(0))],
    ])("refuses (403) %s, deleting nothing and writing no audit", async (_label, setup) => {
      setup();
      const res = await cancel();
      expect(res.status).toBe(403);
      expect(mockTx.teamInvitation.findFirst).not.toHaveBeenCalled();
      expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it.each([
      ["a guest (no tenant row)", () => actorTenantState(null, null, false)],
      ["an active member", () => actorTenantState(null)],
      ["a member re-admitted after the departure", () => actorTenantState(after(-1000))],
      ["a re-provisioned member (older departure record)", () => actorTenantState(null, after(-1000))],
    ])("cancels for %s", async (_label, setup) => {
      setup();
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(mockTx.teamInvitation.deleteMany).toHaveBeenCalledWith({ where: { id: INV_ID, teamId: TEAM_ID } });
      expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    });
  });

  it("answers 409 CONFLICT without Retry-After when the actor's tenant row is held past the lock wait", async () => {
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM tenant_members")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));
    const res = await cancel();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("answers 409 TEAM_BUSY with Retry-After when the team row lock wait times out", async () => {
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));
    const res = await cancel();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockTx.teamInvitation.deleteMany).not.toHaveBeenCalled();
  });

  it("rethrows an unrelated error from the transaction", async () => {
    mockTx.teamInvitation.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(cancel()).rejects.toThrow("db down");
  });
});
