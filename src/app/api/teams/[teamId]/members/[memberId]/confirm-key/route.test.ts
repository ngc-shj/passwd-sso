import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { teamLockQuery, lockQueryCalls } from "@/__tests__/helpers/team-rotation-lock-mock";

const { mockAuth, mockPrismaTeamMember, mockPrismaUser,
  mockPrismaTeamMemberKey, mockTeamLockQuery, mockWithTeamTenantRls,
  mockWithBypassRls, mockRequireTeamPermission, mockRequireRecentSession, mockLogAuditInTx,
  mockTenantMemberFindMany, mockTenantMemberDepartureFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaTeamMemberKey: { upsert: vi.fn() },
  // The in-tx team key-version read (SELECT ... FROM teams ... FOR SHARE).
  mockTeamLockQuery: vi.fn(),
  // The distribution runs as fn(tenantId, tx) (tx = txProxy below); the pre-checks as fn().
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown, _opts?: unknown) => fn("tenant-1", txProxy)),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockRequireTeamPermission: vi.fn().mockResolvedValue(undefined),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
  mockLogAuditInTx: vi.fn(),
  // The recipient's tenant row and departure record, read unlocked (readTenantRows).
  mockTenantMemberFindMany: vi.fn(),
  mockTenantMemberDepartureFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role reads and permission table: routes re-check the actor under their locks.
  activeTeamAdmission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamAdmission,
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));

// Build a tx proxy that delegates to the same mocks
const txProxy = {
  teamMember: mockPrismaTeamMember,
  teamMemberKey: mockPrismaTeamMemberKey,
  tenantMember: { findMany: mockTenantMemberFindMany },
  tenantMemberDeparture: { findMany: mockTenantMemberDepartureFindMany },
  $queryRaw: mockTeamLockQuery,
  // setLockTimeout before the FOR SHARE.
  $executeRaw: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    user: mockPrismaUser,
    teamMemberKey: mockPrismaTeamMemberKey,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/team/team-policy", () => ({
  withTeamIpRestriction: vi.fn().mockResolvedValue(undefined),
  PolicyViolationError: class PolicyViolationError extends Error {
    constructor(message: string) { super(message); this.name = "PolicyViolationError"; }
  },
  getTeamPolicy: vi.fn().mockResolvedValue({ teamAllowedCidrs: [], inheritTenantCidrs: false }),
}));

import { POST } from "./route";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

const URL = "http://localhost/api/teams/team-1/members/member-1/confirm-key";

const validBody = {
  encryptedTeamKey: "encrypted-team-key-data",
  teamKeyIv: "a".repeat(24),
  teamKeyAuthTag: "b".repeat(32),
  ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
  hkdfSalt: "c".repeat(64),
  keyVersion: 1,
};

const ACTOR_ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");
/** The distributing member's row as activeTeamAdmission reads it. */
const actorRow = (role = "OWNER") => ({ role, admittedAt: ACTOR_ADMITTED_AT, createdAt: ACTOR_ADMITTED_AT });
const TARGET_ADMITTED_AT = new Date("2026-04-01T00:00:00.000Z");
/** The recipient's row as the in-transaction re-read (after the tenant-row lock) reads it. */
const lockedTarget = (over: Record<string, unknown> = {}) => ({
  teamId: "team-1",
  userId: "target-user",
  keyDistributed: false,
  deactivatedAt: null,
  admittedAt: TARGET_ADMITTED_AT,
  createdAt: TARGET_ADMITTED_AT,
  ...over,
});

describe("POST /api/teams/[teamId]/members/[memberId]/confirm-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The distributing member's role, re-read under the team lock
    // (requireTeamPermission is mocked, so this is the only findFirst).
    mockPrismaTeamMember.findFirst.mockReset().mockResolvedValue(actorRow());
    mockPrismaTeamMember.findUnique.mockReset();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ team_key_version: 1, tenant_id: "tenant-1" }]));
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 1 });
    mockTenantMemberFindMany.mockResolvedValue([]);
    mockTenantMemberDepartureFindMany.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when admin is not a member", async () => {
    const authErr = Object.assign(new Error("NOT_FOUND"), { name: "TeamAuthError", status: 404 });
    mockRequireTeamPermission.mockRejectedValueOnce(authErr);
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockWithTeamTenantRls).not.toHaveBeenCalledWith("team-1", expect.any(Function), expect.anything());
    // Step-up fires before existence lookup
    expect(mockPrismaTeamMember.findUnique).not.toHaveBeenCalled();
  });

  it("binds the step-up gate to the acting admin, not the member being confirmed", async () => {
    // The gate binds freshness to the user whose session row it reads, so it
    // must get the actor `auth()` resolved — never the target id in scope.
    await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(mockRequireRecentSession).toHaveBeenCalledTimes(1);
    expect(mockRequireRecentSession).toHaveBeenCalledWith(expect.anything(), "admin-user");
  });

  it("returns 404 when target member not found", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce(null); // target member

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when target user has no ECDH public key", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    mockPrismaUser.findUnique.mockResolvedValueOnce({ ecdhPublicKey: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_READY");
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });

    const res = await POST(
      createRequest("POST", URL, { body: { encryptedTeamKey: "data" } }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("distributes key successfully", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check
      .mockResolvedValueOnce(lockedTarget()); // re-check inside tx

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith("team-1", expect.any(Function), { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS });
    // TEAM_MEMBER_KEY_DISTRIBUTE, in the same transaction as the CAS (C4).
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      txProxy,
      "tenant-1",
      expect.objectContaining({
        scope: "TEAM",
        action: "TEAM_MEMBER_KEY_DISTRIBUTE",
        teamId: "team-1",
        targetId: "target-user",
        metadata: expect.objectContaining({ memberId: "member-1", keyVersion: 1 }),
      }),
    );
  });

  it("refuses (403) without writing a key when the distributing member left or was demoted since the check", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(null); // activeTeamAdmission, under the team lock
    // The pre-check only: the refusal comes before the in-transaction member read.
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("refuses (403) without writing a key when the distributing member was demoted to VIEWER", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow("VIEWER"));
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "admin-user", deactivatedAt: null },
      select: { role: true, admittedAt: true, createdAt: true },
    });
    const versionLock = lockQueryCalls(mockTeamLockQuery).find((c) => c.sql.includes("FROM teams"))!;
    expect(versionLock.order).toBeLessThan(mockPrismaTeamMember.findFirst.mock.invocationCallOrder[0]);
  });

  describe("a distributing member who left the tenant, judged against their admission to the team", () => {
    const after = (ms: number) => new Date(ACTOR_ADMITTED_AT.getTime() + ms);
    /** Answer the actor's tenant row and departure record to the real lockTenantRows. */
    const actorTenantState = (deactivatedAt: Date | null, departedAt: Date | null = null, hasRow = true) =>
      mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
        if (sql.includes("FROM tenant_members")) {
          return hasRow ? [{ user_id: "admin-user", role: "MEMBER", deactivated_at: deactivatedAt }] : [];
        }
        if (sql.includes("FROM tenant_member_departures")) {
          return departedAt ? [{ user_id: "admin-user", departed_at: departedAt }] : [];
        }
        return [{ team_key_version: 1, tenant_id: "tenant-1" }];
      }));
    const distribute = async () => {
      mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
      mockPrismaTeamMember.findUnique
        .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
        .mockResolvedValueOnce(lockedTarget());
      return POST(
        createRequest("POST", URL, { body: validBody }),
        { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
      );
    };

    it("refuses (403) an OWNER whose tenant row departed after their admission, writing no key", async () => {
      actorTenantState(after(1));

      expect((await distribute()).status).toBe(403);
      expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
      expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it("allows a guest, an active, a re-admitted and a re-provisioned distributor", async () => {
      for (const setup of [
        () => actorTenantState(null, null, false),
        () => actorTenantState(null),
        () => actorTenantState(after(-1000)),
        () => actorTenantState(null, after(-1000)),
      ]) {
        setup();
        expect((await distribute()).status).toBe(200);
      }
    });

    it("locks only the distributor's tenant row, before the team row, and reads the recipient's unlocked after it", async () => {
      actorTenantState(null);

      await distribute();

      const calls = lockQueryCalls(mockTeamLockQuery);
      const tenantRow = calls.find((c) => c.sql.includes("FROM tenant_members"))!;
      const teamRow = calls.find((c) => c.sql.includes("FROM teams"))!;
      expect(tenantRow.values).toEqual(["tenant-1", ["admin-user"]]);
      expect(tenantRow.order).toBeLessThan(teamRow.order);
      expect(mockTenantMemberFindMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", userId: { in: ["target-user"] } },
        select: { userId: true, role: true, deactivatedAt: true },
      });
      expect(teamRow.order).toBeLessThan(mockTenantMemberFindMany.mock.invocationCallOrder[0]);
    });

    it("answers 409 CONFLICT without Retry-After when the distributor's tenant row is held past the lock wait", async () => {
      mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
        if (sql.includes("FROM tenant_members")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
        return [{ team_key_version: 1, tenant_id: "tenant-1" }];
      }));

      const res = await distribute();

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("CONFLICT");
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    });
  });

  describe("a recipient who left the tenant, judged against their admission to the team", () => {
    const at = (ms: number) => new Date(TARGET_ADMITTED_AT.getTime() + ms);
    /** Answer the recipient's unlocked tenant row and departure record (the distributor is a guest). */
    const targetTenantState = (deactivatedAt: Date | null, departedAt: Date | null = null, hasRow = true) => {
      mockTenantMemberFindMany.mockResolvedValue(
        hasRow ? [{ userId: "target-user", role: "MEMBER", deactivatedAt }] : [],
      );
      mockTenantMemberDepartureFindMany.mockResolvedValue(
        departedAt ? [{ userId: "target-user", departedAt }] : [],
      );
    };
    const distribute = async (locked = lockedTarget()) => {
      mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
      mockPrismaTeamMember.findUnique
        .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
        .mockResolvedValueOnce(locked);
      return POST(
        createRequest("POST", URL, { body: validBody }),
        { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
      );
    };
    const expectNothingWritten = () => {
      expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
      expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    };

    it("refuses (404 MEMBER_NOT_FOUND) a recipient whose tenant row was deactivated after their admission, writing no key", async () => {
      targetTenantState(at(1));

      const res = await distribute();

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("MEMBER_NOT_FOUND");
      expectNothingWritten();
    });

    it("refuses a recipient whose departure record (row deleted) postdates their admission", async () => {
      targetTenantState(null, at(1), false);

      expect((await distribute()).status).toBe(404);
      expectNothingWritten();
    });

    it("refuses a recipient whose departure equals their admission", async () => {
      targetTenantState(at(0));

      expect((await distribute()).status).toBe(404);
      expectNothingWritten();
    });

    it("refuses when the locked row is no longer the pre-checked user's", async () => {
      targetTenantState(null);

      expect((await distribute(lockedTarget({ userId: "other-user" }))).status).toBe(404);
      expectNothingWritten();
    });

    it("distributes to a guest, an active, a re-admitted and a re-provisioned recipient", async () => {
      for (const [setup, locked] of [
        [() => targetTenantState(null, null, false), lockedTarget()],
        [() => targetTenantState(null), lockedTarget()],
        // created before the departure, re-admitted after it: admitted_at decides.
        [() => targetTenantState(at(-1000)), lockedTarget({ createdAt: at(-5000) })],
        [() => targetTenantState(null, at(-1000)), lockedTarget()],
      ] as const) {
        setup();
        expect((await distribute(locked)).status).toBe(200);
      }
      expect(mockPrismaTeamMemberKey.upsert).toHaveBeenCalledTimes(4);
    });
  });

  it("returns 404 when target member belongs to a different team (Q-1 IDOR)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ teamId: "team-OTHER", userId: "target-user", keyDistributed: false, deactivatedAt: null }); // target belongs to different team

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 409 when key already distributed (pre-check, Q-2)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: true, deactivatedAt: null }); // already distributed

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
    // Transaction should NOT be called since pre-check caught it
    expect(mockWithTeamTenantRls).not.toHaveBeenCalledWith("team-1", expect.any(Function), expect.anything());
  });

  it("returns 400 on malformed JSON (Q-3)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest(URL, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(
      req,
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 409 when keyVersion does not match team's current version (F-16)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // admin (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce(lockedTarget()); // re-check passes
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ team_key_version: 2, tenant_id: "tenant-1" }])); // team rotated to v2

    const res = await POST(
      createRequest("POST", URL, { body: validBody }), // keyVersion: 1 (stale)
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("reads the team version FOR SHARE before the member row, and distributes at the current version", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce(lockedTarget());

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(200);
    const lock = lockQueryCalls(mockTeamLockQuery).find((c) => c.sql.includes("FROM teams"))!;
    expect(lock.sql).toMatch(/FROM teams WHERE id = \?::uuid FOR SHARE/);
    expect(lock.values).toEqual(["team-1"]);
    // The second findUnique is the in-tx member re-check.
    expect(lock.order).toBeLessThan(
      mockPrismaTeamMember.findUnique.mock.invocationCallOrder[1],
    );
    expect(mockPrismaTeamMemberKey.upsert).toHaveBeenCalledOnce();
  });

  it("returns 409 TEAM_BUSY without distributing when a rotation holds the team past the lock timeout", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    // Only the pre-check read: the lock is the transaction's first statement,
    // so the in-tx member re-check never runs.
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    // lock_not_available, nested the way the pg driver adapter reports it.
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (!sql.includes("FROM teams")) return [];
      throw Object.assign(new Error("canceling statement due to lock timeout"), {
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      });
    }));

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
    // In-flight rotation (C4): no TEAM_MEMBER_KEY_DISTRIBUTE.
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("marks the member distributed only while still active and undistributed", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce(lockedTarget());

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockPrismaTeamMember.updateMany).toHaveBeenCalledWith({
      where: { id: "member-1", teamId: "team-1", deactivatedAt: null, keyDistributed: false },
      data: { keyDistributed: true },
    });
  });

  it("returns 404 when the member was deactivated after the in-transaction check", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce(lockedTarget());
    // The guarded write matches nothing: the row changed since the read.
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("MEMBER_NOT_FOUND");
    // CAS count 0 (C4): no TEAM_MEMBER_KEY_DISTRIBUTE.
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("returns 409 when key already distributed (TOCTOU race)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow()); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check (passes)
      .mockResolvedValueOnce(lockedTarget({ keyDistributed: true })); // re-check inside tx (race: another admin distributed first)

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
    // Already distributed (C4): no TEAM_MEMBER_KEY_DISTRIBUTE.
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("uses bypass user lookup so a cross-tenant guest can receive a key", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(actorRow());
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "guest-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce(lockedTarget({ userId: "guest-user" }));
    mockPrismaUser.findUnique.mockResolvedValueOnce({ ecdhPublicKey: "guest-pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
      where: { id: "guest-user" },
      select: { ecdhPublicKey: true },
    });
  });
});
