import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { teamLockQuery, lockQueryCalls } from "@/__tests__/helpers/team-rotation-lock-mock";

const { mockAuth, mockPrismaTeamMember, mockPrismaUser,
  mockPrismaTeamMemberKey, mockTeamLockQuery, mockTransaction, mockWithTeamTenantRls,
  mockWithBypassRls, mockRequireTeamPermission, mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaTeamMemberKey: { upsert: vi.fn() },
  // The in-tx team key-version read (SELECT ... FROM teams ... FOR SHARE).
  mockTeamLockQuery: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockRequireTeamPermission: vi.fn().mockResolvedValue(undefined),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

// Build a tx proxy that delegates to the same mocks
const txProxy = {
  teamMember: mockPrismaTeamMember,
  teamMemberKey: mockPrismaTeamMemberKey,
  $queryRaw: mockTeamLockQuery,
  // setLockTimeout before the FOR SHARE.
  $executeRaw: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    user: mockPrismaUser,
    teamMemberKey: mockPrismaTeamMemberKey,
    $transaction: mockTransaction,
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

const URL = "http://localhost/api/teams/team-1/members/member-1/confirm-key";

const validBody = {
  encryptedTeamKey: "encrypted-team-key-data",
  teamKeyIv: "a".repeat(24),
  teamKeyAuthTag: "b".repeat(32),
  ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
  hkdfSalt: "c".repeat(64),
  keyVersion: 1,
};

describe("POST /api/teams/[teamId]/members/[memberId]/confirm-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ team_key_version: 1, tenant_id: "tenant-1" }]));
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 1 });
    // Interactive transaction: call the callback with tx proxy
    mockTransaction.mockImplementation(async (fn: (tx: typeof txProxy) => unknown) => fn(txProxy));
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
    expect(mockTransaction).not.toHaveBeenCalled();
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
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce(null); // target member

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when target user has no ECDH public key", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
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
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });

    const res = await POST(
      createRequest("POST", URL, { body: { encryptedTeamKey: "data" } }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("distributes key successfully", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null }); // re-check inside tx

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when target member belongs to a different team (Q-1 IDOR)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // admin (findFirst)
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
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: true, deactivatedAt: null }); // already distributed

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
    // Transaction should NOT be called since pre-check caught it
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON (Q-3)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
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
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null }); // re-check passes
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ team_key_version: 2, tenant_id: "tenant-1" }])); // team rotated to v2

    const res = await POST(
      createRequest("POST", URL, { body: validBody }), // keyVersion: 1 (stale)
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("reads the team version FOR SHARE before the member row, and distributes at the current version", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(200);
    const [lock] = lockQueryCalls(mockTeamLockQuery);
    expect(lock.sql).toMatch(/FROM teams WHERE id = \?::uuid FOR SHARE/);
    expect(lock.values).toEqual(["team-1"]);
    // The second findUnique is the in-tx member re-check.
    expect(lock.order).toBeLessThan(
      mockPrismaTeamMember.findUnique.mock.invocationCallOrder[1],
    );
    expect(mockPrismaTeamMemberKey.upsert).toHaveBeenCalledOnce();
  });

  it("returns 409 without distributing when a rotation holds the team past the lock timeout", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    // Only the pre-check read: the lock is the transaction's first statement,
    // so the in-tx member re-check never runs.
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    // lock_not_available, nested the way the pg driver adapter reports it.
    mockTeamLockQuery.mockImplementation(teamLockQuery(() => {
      throw Object.assign(new Error("canceling statement due to lock timeout"), {
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      });
    }));

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("marks the member distributed only while still active and undistributed", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null });

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

  it("refuses, distributing nothing, a member who departed the team's tenant", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) =>
      sql.includes("FROM tenant_members") ? [{ departed: true }] : [{ team_key_version: 1, tenant_id: "tenant-1" }],
    ));

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(404);
    const departure = lockQueryCalls(mockTeamLockQuery).find((c) => c.sql.includes("FROM tenant_members"));
    // Read in the team's tenant, for the target, and locked against a concurrent deactivation.
    expect(departure?.sql).toMatch(/FOR SHARE/);
    expect(departure?.values).toEqual(["tenant-1", "target-user"]);
    expect(mockPrismaTeamMemberKey.upsert).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the member was deactivated after the in-transaction check", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null });
    // The guarded write matches nothing: the row changed since the read.
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 409 when key already distributed (TOCTOU race)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" }); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check (passes)
      .mockResolvedValueOnce({ keyDistributed: true, deactivatedAt: null }); // re-check inside tx (race: another admin distributed first)

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
  });

  it("uses bypass user lookup so a cross-tenant guest can receive a key", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", teamId: "team-1" });
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", teamId: "team-1", userId: "guest-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null });
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
