import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// The transaction the admission decision runs in (route.ts, withTeamTenantRls).
const acceptTx = {
  teamInvitation: { updateMany: vi.fn(), update: vi.fn() },
  teamMember: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
  teamMemberKey: { deleteMany: vi.fn() },
};
const { mockLockTenantRows, mockLockTeamsAgainstRotation, mockLogAuditInTx } = vi.hoisted(() => ({
  mockLockTenantRows: vi.fn(),
  mockLockTeamsAgainstRotation: vi.fn(),
  mockLogAuditInTx: vi.fn(),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTeamsAgainstRotation: mockLockTeamsAgainstRotation,
}));

const { mockAuth, mockPrismaTeamInvitation, mockPrismaTeamMember, mockPrismaUser, mockTransaction, mockRateLimiter, mockCreateRateLimiter, mockWithUserTenantRls, mockWithTeamTenantRls, mockWithBypassRls, teamTenantRlsCallbackPromises } = vi.hoisted(() => {
  const mockRateLimiter = { check: vi.fn() };
  // Every withTeamTenantRls call's callback promise, in call order (T1): the
  // admission transaction is always the last one on a path that reaches it,
  // so a race cell can assert on its settlement independently of how POST's
  // own try/catch turns that settlement into a response — a regression that
  // swallowed the throw and returned a refusal value instead would still
  // produce the same response, but would resolve here instead of reject.
  const teamTenantRlsCallbackPromises: Promise<unknown>[] = [];
  return {
  mockAuth: vi.fn(),
  mockPrismaTeamInvitation: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  mockPrismaTeamMember: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockTransaction: vi.fn(),
  mockRateLimiter,
  // Recording factory — assertRedisFailClosed's factory-attribution step
  // reads mockCreateRateLimiter.mock.{calls,results}.
  mockCreateRateLimiter: vi.fn((_opts: unknown) => mockRateLimiter),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  // The accept transaction runs as fn(tenantId, tx); the pre-checks as fn().
  mockWithTeamTenantRls: vi.fn((_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) => {
    const callbackResult = Promise.resolve().then(() => fn("tenant-1", acceptTx));
    teamTenantRlsCallbackPromises.push(callbackResult);
    return callbackResult;
  }),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  teamTenantRlsCallbackPromises,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: mockPrismaTeamInvitation,
    teamMember: mockPrismaTeamMember,
    user: mockPrismaUser,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";
import { TEAM_ROLE, INVITATION_STATUS, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

// Module-scope snapshot (route.ts:16 `const acceptLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const acceptLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const acceptLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiter.check;
};

const futureDate = new Date("2099-01-01T00:00:00Z");

const issuedAt = new Date("2026-06-01T00:00:00.000Z");

// When the inviter's membership of the team began: before the invitation.
const inviterAdmittedAt = new Date("2026-05-01T00:00:00.000Z");

const validInvitation = {
  id: "inv-1",
  teamId: "team-1",
  invitedById: "inviter-id",
  createdAt: issuedAt,
  email: "user@test.com",
  role: TEAM_ROLE.MEMBER,
  token: "valid-token",
  status: INVITATION_STATUS.PENDING,
  expiresAt: futureDate,
  team: { id: "team-1", name: "My Team", slug: "my-team", tenantId: "tenant-1" },
};

/** lockTenantRows' answer: the invitee and inviter with their rows' state. */
function lockedRows(rows: Record<string, { deactivatedAt?: Date | null; departedAt?: Date | null; hasRow?: boolean }> = {}) {
  const ids = ["test-user-id", "inviter-id"];
  return new Map(
    ids.map((id) => [id, { hasRow: rows[id]?.hasRow ?? true, deactivatedAt: rows[id]?.deactivatedAt ?? null, departedAt: rows[id]?.departedAt ?? null }]),
  );
}

describe("POST /api/teams/invitations/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "user@test.com" } });
    mockPrismaTeamInvitation.updateMany.mockResolvedValue({ count: 1 });
    // The accept path runs prisma.$transaction(async (tx) => …); execute the
    // callback with a tx whose invitation CAS wins by default so the real
    // claim → upsert logic is exercised (not bypassed).
    mockTransaction.mockImplementation(async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)({
            teamInvitation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            teamMember: { upsert: vi.fn().mockResolvedValue({}) },
          })
        : [{}, {}],
    );
    mockRateLimiter.check.mockResolvedValue({ allowed: true });
    acceptTx.teamInvitation.updateMany.mockReset().mockResolvedValue({ count: 1 });
    acceptTx.teamInvitation.update.mockReset().mockResolvedValue({});
    acceptTx.teamMember.findUnique.mockReset().mockResolvedValue(null);
    // The inviter, re-read under the team lock: an active ADMIN.
    acceptTx.teamMember.findFirst.mockReset().mockResolvedValue({ role: TEAM_ROLE.ADMIN, admittedAt: inviterAdmittedAt, createdAt: inviterAdmittedAt });
    mockLogAuditInTx.mockReset().mockResolvedValue(undefined);
    acceptTx.teamMember.upsert.mockReset().mockResolvedValue({});
    acceptTx.teamMemberKey.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    mockLockTenantRows.mockReset().mockResolvedValue(lockedRows());
    mockLockTeamsAgainstRotation.mockReset().mockResolvedValue(undefined);
    teamTenantRlsCallbackPromises.length = 0;
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
          body: { token: "valid-token" },
        })),
      limiter: acceptLimiter,
      expectation: { envelope: "canonical" },
      // The route reaches teamInvitation.updateMany / teamMember.upsert only
      // inside prisma.$transaction — asserting the transaction itself never
      // ran is the correct "no mutation" proxy for the tx-scoped mocks
      // (route.ts wires fresh vi.fn() per-call inside mockTransaction's
      // implementation, so the top-level teamMember mock is never touched
      // by the real transaction path either).
      assertNoMutation: [mockTransaction, mockPrismaTeamInvitation.updateMany],
      limiterFactory: acceptLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "abc" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when token missing", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when token is invalid", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "invalid" },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when invitation already used", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      status: INVITATION_STATUS.ACCEPTED,
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 410 when invitation expired", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      expiresAt: new Date("2020-01-01"),
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 403 when email doesn't match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "other@test.com" } });
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(403);
  });

  it("handles already-member case gracefully, claiming and answering inside the locked transaction", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({ id: "existing-member", deactivatedAt: null });
    acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: null });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(true);
    // ACCEPTED is written only by the locked claim, never by an unlocked write.
    expect(mockPrismaTeamInvitation.updateMany).not.toHaveBeenCalled();
    expect(acceptTx.teamInvitation.updateMany).toHaveBeenCalledOnce();
    expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("reaches the locked path for an active SCIM-managed member, answering alreadyMember there", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "scim-member", deactivatedAt: null, scimManaged: true, deactivatedByTenant: false, scimApprovalPending: false,
    });
    acceptTx.teamMember.findUnique.mockResolvedValue({
      deactivatedAt: null, scimManaged: true, deactivatedByTenant: false, scimApprovalPending: false,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyMember).toBe(true);
    expect(acceptTx.teamInvitation.updateMany).toHaveBeenCalledOnce();
    expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("answers 410 INVITATION_EXPIRED to an already-active member when the inviter departed since their admission", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({ id: "existing-member", deactivatedAt: null });
    acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: null });
    mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { deactivatedAt: new Date(inviterAdmittedAt.getTime() + 1) } }));

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("INVITATION_EXPIRED");
    expect(acceptTx.teamInvitation.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: INVITATION_STATUS.EXPIRED } });
  });

  it("returns 409 SCIM_APPROVAL_PENDING for a pending member (pre-check)", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "pending-member",
      deactivatedAt: new Date("2024-01-01"),
      scimManaged: true,
      scimApprovalPending: true,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_APPROVAL_PENDING");
  });

  it("returns 409 for deactivated scimManaged member", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "deactivated-member",
      deactivatedAt: new Date("2024-01-01"),
      scimManaged: true,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_MANAGED_MEMBER");
  });

  it("re-activates deactivated non-scimManaged member", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "deactivated-member",
      deactivatedAt: new Date("2024-01-01"),
      scimManaged: false,
    });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(false);
    expect(acceptTx.teamMember.upsert).toHaveBeenCalledTimes(1);
  });

  it("accepts invitation and creates membership", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key-jwk" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(false);
    expect(json.role).toBe(TEAM_ROLE.MEMBER);
    expect(json.team.name).toBe("My Team");
    expect(acceptTx.teamMember.upsert).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledOnce();
    expect(mockLogAuditInTx).toHaveBeenCalledWith(acceptTx, "tenant-1", expect.objectContaining({
      scope: "TEAM",
      action: "TEAM_MEMBER_INVITE_ACCEPT",
      userId: "test-user-id",
      teamId: "team-1",
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: "test-user-id",
      metadata: { invitationId: "inv-1", role: TEAM_ROLE.MEMBER, readmitted: false },
    }));
    // Audited before the keys are cleared, in the admission's own transaction.
    expect(mockLogAuditInTx.mock.invocationCallOrder[0]).toBeLessThan(acceptTx.teamMemberKey.deleteMany.mock.invocationCallOrder[0]);
  });

  it("returns 410 when the accept CAS loses a concurrent race", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    // Status+expiry CAS matches 0 rows: another accept won concurrently (or the
    // invitation expired between the pre-check and the write).
    acceptTx.teamInvitation.updateMany.mockResolvedValue({ count: 0 });
    const upsert = acceptTx.teamMember.upsert;

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
    // Membership must NOT be created when the claim is lost.
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns needsKeyDistribution for team accept", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key-jwk" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.needsKeyDistribution).toBe(true);
    expect(json.vaultSetupRequired).toBe(false);
  });

  it("returns vaultSetupRequired when user lacks ECDH key", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: null });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.needsKeyDistribution).toBe(true);
    expect(json.vaultSetupRequired).toBe(true);
  });

  it("uses correct RLS context for each operation", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));

    // Invitation lookup: bypass RLS (invitee not yet in team's tenant)
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.TEAM_INVITATION_ACCEPT,
    );
    // Team data operations: team tenant RLS
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith("team-1", expect.any(Function), expect.anything());
    // User data: user tenant RLS
    expect(mockWithUserTenantRls).toHaveBeenCalledWith("test-user-id", expect.any(Function));
  });
  describe("admission after a tenant departure", () => {
    beforeEach(() => {
      mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
      mockPrismaTeamMember.findUnique.mockResolvedValue(null);
      mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    });
    const accept = () =>
      POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", { body: { token: "valid-token" } }));

    it("refuses an invitation issued before the invitee left, and commits it EXPIRED", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "test-user-id": { deactivatedAt: new Date(issuedAt.getTime() + 1) } }));

      const res = await accept();

      expect(res.status).toBe(410);
      expect((await res.json()).error).toBe("INVITATION_EXPIRED");
      expect(acceptTx.teamInvitation.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: INVITATION_STATUS.EXPIRED } });
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("refuses an invitation issued at the instant of the departure", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "test-user-id": { deactivatedAt: issuedAt } }));

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("admits on an invitation issued after the departure", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "test-user-id": { deactivatedAt: new Date(issuedAt.getTime() - 1) } }));

      expect((await accept()).status).toBe(200);
      expect(acceptTx.teamMember.upsert).toHaveBeenCalledOnce();
    });

    it("refuses, and commits EXPIRED, when the inviter is no longer a member entitled to invite", async () => {
      acceptTx.teamMember.findFirst.mockResolvedValue(null);

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamInvitation.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: INVITATION_STATUS.EXPIRED } });
      expect(acceptTx.teamMember.findFirst).toHaveBeenCalledWith({
        where: { teamId: "team-1", userId: "inviter-id", deactivatedAt: null },
        select: { role: true, admittedAt: true, createdAt: true },
      });
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("refuses an invitation from an ADMIN inviter whose tenant row departed after their admission, though the invitation postdates it", async () => {
      // Invitation (issuedAt) postdates the departure, so departedSince alone admits.
      const departure = new Date(inviterAdmittedAt.getTime() + 1);
      mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { deactivatedAt: departure } }));

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamInvitation.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: INVITATION_STATUS.EXPIRED } });
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it("admits from an inviter who was re-admitted after their departure", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { deactivatedAt: new Date(inviterAdmittedAt.getTime() - 1000) } }));
      expect((await accept()).status).toBe(200);
    });

    it("admits from an inviter re-provisioned active whose old departure record predates their membership", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { departedAt: new Date(inviterAdmittedAt.getTime() - 1000) } }));
      expect((await accept()).status).toBe(200);
    });

    it("admits on an invitation from a guest ADMIN, who has no tenant row here", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { hasRow: false } }));
      acceptTx.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.ADMIN, admittedAt: inviterAdmittedAt, createdAt: inviterAdmittedAt });

      expect((await accept()).status).toBe(200);
      expect(acceptTx.teamMember.upsert).toHaveBeenCalledOnce();
    });

    it("refuses an invitation from an inviter demoted to VIEWER", async () => {
      acceptTx.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.VIEWER });

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("refuses an invitation issued before the inviter left", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "inviter-id": { deactivatedAt: new Date(issuedAt.getTime() + 1) } }));

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("refuses a pre-deletion invitation to a user whose membership a SCIM DELETE removed and who has a new row", async () => {
      mockLockTenantRows.mockResolvedValue(lockedRows({ "test-user-id": { departedAt: new Date(issuedAt.getTime() + 1) } }));

      expect((await accept()).status).toBe(410);
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });

    it("locks both tenant rows, then the team, before claiming the invitation", async () => {
      await accept();

      expect(mockLockTenantRows).toHaveBeenCalledWith(acceptTx, "tenant-1", ["test-user-id", "inviter-id"], "share", expect.anything());
      const [tenantLock] = mockLockTenantRows.mock.invocationCallOrder;
      const [teamLock] = mockLockTeamsAgainstRotation.mock.invocationCallOrder;
      const [claim] = acceptTx.teamInvitation.updateMany.mock.invocationCallOrder;
      expect(tenantLock).toBeLessThan(teamLock);
      expect(teamLock).toBeLessThan(claim);
    });

    it("re-admits with the departure marker cleared and the old member keys deleted", async () => {
      mockPrismaTeamMember.findUnique.mockResolvedValue({ deactivatedAt: new Date("2026-05-01"), scimManaged: true, deactivatedByTenant: true });
      acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: new Date("2026-05-01"), scimManaged: true, deactivatedByTenant: true });

      expect((await accept()).status).toBe(200);
      expect(acceptTx.teamMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({ deactivatedAt: null, deactivatedByTenant: false, keyDistributed: false, scimManaged: false }),
      }));
      expect(acceptTx.teamMemberKey.deleteMany).toHaveBeenCalledWith({ where: { teamId: "team-1", userId: "test-user-id" } });
      expect(mockLogAuditInTx).toHaveBeenCalledWith(acceptTx, "tenant-1", expect.objectContaining({
        action: "TEAM_MEMBER_INVITE_ACCEPT",
        metadata: { invitationId: "inv-1", role: TEAM_ROLE.MEMBER, readmitted: true },
      }));
      // (T1) An admission commits: the transaction callback resolved, it did
      // not reject and get its refusal response fabricated some other way.
      await expect(teamTenantRlsCallbackPromises.at(-1)).resolves.not.toBeUndefined();
    });

    it("keeps the keys of a membership that became active since the pre-check", async () => {
      acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: null });

      const res = await accept();

      expect(res.status).toBe(200);
      expect((await res.json()).alreadyMember).toBe(true);
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
      expect(acceptTx.teamMemberKey.deleteMany).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
      // (T1) ALREADY_MEMBER is a returned outcome, not a thrown refusal: the
      // claim commits along with the rest of the transaction.
      await expect(teamTenantRlsCallbackPromises.at(-1)).resolves.not.toBeUndefined();
    });

    it("throws inside the locked transaction when SCIM admits the invitee pending after the pre-check, so the claim rolls back instead of admitting (A14)", async () => {
      acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: new Date("2026-06-02"), scimApprovalPending: true });

      const res = await accept();

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SCIM_APPROVAL_PENDING");
      // The claim ran (and would roll back with the rest of the transaction on
      // a thrown error against the real database); the membership must not.
      expect(acceptTx.teamInvitation.updateMany).toHaveBeenCalled();
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
      // (T1) The 409 must come from the transaction callback itself REJECTING
      // (so the real database rolls the claim back too) — not from the route
      // catching something inside the callback and returning a refusal value,
      // which would commit the claim it just made.
      await expect(teamTenantRlsCallbackPromises.at(-1)).rejects.toThrow();
    });

    it("throws inside the locked transaction when a SCIM group removal unmarked the departed row after the pre-check", async () => {
      mockPrismaTeamMember.findUnique.mockResolvedValue({ deactivatedAt: new Date("2026-05-01"), scimManaged: true, deactivatedByTenant: true });
      acceptTx.teamMember.findUnique.mockResolvedValue({ deactivatedAt: new Date("2026-05-01"), scimManaged: true, deactivatedByTenant: false });

      const res = await accept();

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SCIM_MANAGED_MEMBER");
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
      expect(acceptTx.teamMemberKey.deleteMany).not.toHaveBeenCalled();
      // (T1) Same requirement as the SCIM_APPROVAL_PENDING race above.
      await expect(teamTenantRlsCallbackPromises.at(-1)).rejects.toThrow();
    });

    it("answers 409 CONFLICT without Retry-After when a tenant row is held past the lock wait", async () => {
      const { TenantMemberLockTimeoutError } = await vi.importActual<typeof import("@/lib/team/tenant-row-lock")>("@/lib/team/tenant-row-lock");
      mockLockTenantRows.mockRejectedValue(new TenantMemberLockTimeoutError());

      const res = await accept();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("CONFLICT");
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(acceptTx.teamInvitation.updateMany).not.toHaveBeenCalled();
    });

    it("answers 409 TEAM_BUSY with Retry-After when a team row is held past the lock wait", async () => {
      const { TeamRotationInProgressError } = await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock");
      mockLockTeamsAgainstRotation.mockRejectedValue(new TeamRotationInProgressError());

      const res = await accept();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("TEAM_BUSY");
      expect(res.headers.get("Retry-After")).toBe("3");
      expect(acceptTx.teamInvitation.updateMany).not.toHaveBeenCalled();
      expect(acceptTx.teamMember.upsert).not.toHaveBeenCalled();
    });
  });
});
