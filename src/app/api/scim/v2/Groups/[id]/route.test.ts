import { describe, it, expect, vi, beforeEach } from "vitest";
import { teamLockQuery } from "@/__tests__/helpers/team-rotation-lock-mock";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockLogAuditBulkInTx,
  mockScimGroupMapping,
  mockTeamMember,
  mockTenantMember,
  mockTransaction,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockLogAuditBulkInTx: vi.fn(),
  mockScimGroupMapping: { findUnique: vi.fn() },
  mockTeamMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
  },
  mockTenantMember: { findUnique: vi.fn(), findMany: vi.fn() },
  mockTransaction: vi.fn(),
  // replaceScimGroup/patchScimGroup now take a Prisma.TransactionClient
  // directly (no more flatten branch) — route through the mocked prisma's
  // $transaction so each describe's beforeEach can hand the write path a
  // raw-capable tx ($queryRaw/$executeRaw/teamMemberKey), same as production.
  mockWithTenantRls: vi.fn(async (prismaArg: { $transaction?: (fn: (tx: unknown) => unknown) => unknown }, _tenantId: string, fn: (tx: unknown) => unknown) =>
    prismaArg.$transaction ? prismaArg.$transaction(fn) : fn(prismaArg)),
}));

vi.mock("@/lib/auth/tokens/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkInTx: mockLogAuditBulkInTx,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: null, userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimGroupMapping: mockScimGroupMapping,
    teamMember: mockTeamMember,
    tenantMember: mockTenantMember,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
// The tenant-row lock has its own tests and real-DB cells; here it answers
// from the `tenantMember.findMany` fixture of the client it is handed (the
// cells' "active member of the tenant"). A plain function, so resets keep it.
const { tenantLockFailure } = vi.hoisted(() => ({ tenantLockFailure: { error: null as Error | null } }));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: async (
    tx: { tenantMember: { findMany: (args: unknown) => Promise<{ userId: string }[] | undefined> } },
    tenantId: string,
    userIds: string[],
  ) => {
    if (tenantLockFailure.error) throw tenantLockFailure.error;
    if (userIds.length === 0) return new Map();
    const active = new Set(
      ((await tx.tenantMember.findMany({ where: { tenantId, userId: { in: userIds }, deactivatedAt: null }, select: { userId: true } })) ?? [])
        .map((m) => m.userId),
    );
    return new Map(userIds.map((id) => [id, { hasRow: active.has(id), deactivatedAt: null, departedAt: null }]));
  },
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1", actorType: "HUMAN" as const },
};

const mapping = {
  id: "m1",
  externalGroupId: "grp-1",
  role: "ADMIN",
  teamId: "team-1",
  team: { slug: "core" },
};

// F2/S-F3: a PATCH/PUT member value is now validated as a uuid at the
// boundary (src/lib/scim/patch-parser.ts, src/lib/scim/validations.ts) —
// these fixtures must be real uuid-shaped strings, not the old "user-1"
// style labels, or the request itself 400s before the mock ever sees it.
const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";
const USER_9 = "99999999-9999-4999-8999-999999999999";
// Not a uuid format problem — a uuid-shaped id the tenant lookup finds no row for.
const NONEXISTENT_USER = "00000000-0000-4000-8000-000000000099";

/** A distinct, valid-shaped id per (category, index) for the A7e fixture. */
function fixtureUserId(category: number, i: number): string {
  const idx = i.toString(16).padStart(4, "0");
  return `a000000${category}-0000-4000-8000-${idx}00000000`;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(options: { method?: string; body?: unknown } = {}) {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest("http://localhost/api/scim/v2/Groups/grp-1", init as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // GET's read path needs no raw lock calls — the mocked prisma's own
    // scimGroupMapping/teamMember are enough.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ scimGroupMapping: mockScimGroupMapping, teamMember: mockTeamMember, tenantMember: mockTenantMember }),
    );
  });

  it("returns 404 when mapping not found", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);
    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(404);
  });

  it("returns mapped group resource", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("grp-1");
    expect(body.displayName).toBe("core:ADMIN");
  });

  it("returns 429 when group lookups are rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(429);
  });

  it("returns 401 when SCIM token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(401);
  });

  it("filters out members without email from group resource", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.findMany.mockResolvedValue([
      { userId: "user-1", user: { id: "user-1", email: null } },
      { userId: "user-2", user: { id: "user-2", email: "u2@example.com" } },
    ]);

    const res = await GET(makeReq(), makeParams("grp-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({ value: "user-2", display: "u2@example.com" }),
    ]);
  });

  it("lists a pending member and still excludes a cross-tenant guest (A13)", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.findMany.mockResolvedValue([
      { userId: "user-pending", user: { id: "user-pending", email: "pending@example.com" } },
    ]);

    const res = await GET(makeReq(), makeParams("grp-1"));
    expect(res.status).toBe(200);
    const [{ where }] = mockTeamMember.findMany.mock.calls[0];
    // scimGroupResponseMemberWhere: active OR departed OR pending, AND an
    // active tenant membership — the guest-exclusion guard the DB answers.
    expect(where.OR).toEqual([
      { deactivatedAt: null },
      { deactivatedByTenant: true },
      { scimApprovalPending: true },
    ]);
    expect(where.user).toEqual({
      tenantMemberships: { some: { tenantId: "tenant-1", deactivatedAt: null } },
    });
  });
});

describe("PATCH /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps a previously set mockResolvedValue/mockImplementation
    // alive — A7e's fixture-sized findMany/createMany answers would otherwise
    // leak into whichever cell runs next in file order (T6). Reset them so
    // every cell that reaches these mocks must set up its own answer.
    mockTeamMember.findMany.mockReset();
    mockTeamMember.createMany.mockReset();
    mockTenantMember.findMany.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.updateManyAndReturn.mockResolvedValue([]);
    mockTeamMember.deleteMany.mockResolvedValue({ count: 0 });
    // Default transaction: pass tx with batch-capable mocks
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        // The team lock against key rotation (pinned in scim-group-service.test.ts).
        $queryRaw: vi.fn(teamLockQuery([{ id: mapping.teamId }])),
        $executeRaw: vi.fn(),
        teamMember: mockTeamMember,
        tenantMember: mockTenantMember,
        teamMemberKey: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        scimGroupMapping: mockScimGroupMapping,
      }),
    );
  });

  it("answers 409, writing no membership, when an added user's tenant row is held past the lock wait", async () => {
    const { TenantMemberLockTimeoutError } = await vi.importActual<typeof import("@/lib/team/tenant-row-lock")>("@/lib/team/tenant-row-lock");
    tenantLockFailure.error = new TenantMemberLockTimeoutError();
    try {
      const res = await PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
          },
        }),
        makeParams("grp-1"),
      );

      expect(res!.status).toBe(409);
      expect(mockTeamMember.createMany).not.toHaveBeenCalled();
      expect(mockTeamMember.updateMany).not.toHaveBeenCalled();
    } finally {
      tenantLockFailure.error = null;
    }
  });

  it("raises a pending member's role and audits TEAM_MEMBER_SCIM_PENDING", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "MEMBER", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true }])
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValue([{ userId: USER_1 }]);
    mockTeamMember.updateManyAndReturn.mockResolvedValue([{ id: "tm1", userId: USER_1 }]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLogAuditBulkInTx).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      [
        expect.objectContaining({
          scope: "TEAM",
          teamId: "team-1",
          action: "TEAM_MEMBER_SCIM_PENDING",
          targetId: USER_1,
          metadata: expect.objectContaining({ scimTokenId: "t1", role: "ADMIN", previousRole: "MEMBER" }),
        }),
      ],
    );
  });

  it("is a no-op (200) when removing a missing member (idempotent on IdP retry)", async () => {
    // Remove op: findMany returns empty (user has no row in the team)
    mockTeamMember.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // loadGroupMembers

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: `members[value eq "${USER_9}"]` }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockTeamMember.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("returns 403 when patch would modify an owner", async () => {
    // findMany returns an existing OWNER member
    mockTeamMember.findMany.mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "OWNER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false }]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(403);
  });

  it("creates a pending team member when adding a tenant user who is not yet in the team", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // tx.teamMember.findMany (no existing team member)
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValueOnce([{ userId: USER_1 }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          teamId: "team-1",
          userId: USER_1,
          tenantId: "tenant-1",
          role: "ADMIN",
          scimManaged: true,
          scimApprovalPending: true,
          deactivatedAt: expect.any(Date),
          keyDistributed: false,
        },
      ],
    });
    expect(mockLogAuditBulkInTx).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      [expect.objectContaining({ action: "TEAM_MEMBER_SCIM_PENDING", targetId: USER_1 })],
    );
  });

  it("withdraws a pending member when removing the mapped role", async () => {
    const member = [{ id: "tm1", userId: USER_1, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true }];
    mockTeamMember.findMany
      .mockResolvedValueOnce(member) // locked re-read in applyRemoveOperations
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTeamMember.deleteMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: `members[value eq "${USER_1}"]` }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["tm1"] }, teamId: "team-1", role: "ADMIN", scimApprovalPending: true },
    });
  });

  it("returns 400 when adding a user not in the tenant", async () => {
    // User not in team and not in tenant: tenantMember.findMany returns empty
    mockTeamMember.findMany.mockResolvedValueOnce([]);
    mockTenantMember.findMany.mockResolvedValueOnce([]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: NONEXISTENT_USER }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.detail).toContain("not an active member of this tenant");
  });

  // C/F2/S-F3 (review round 2, F-N3/T-N3/T-N4): a malformed member value is
  // a parse-time rejection (patch-parser.ts), distinct from the 400 above
  // (a well-formed uuid that is not an active tenant member).
  it("returns 400 with scimType invalidValue for a non-uuid member value", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: "not-a-uuid" }] }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.scimType).toBe("invalidValue");
  });

  it("returns 400 for invalid JSON on PATCH", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Groups/grp-1", {
      method: "PATCH",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, makeParams("grp-1"));
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PATCH target is missing", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
        },
      }),
      makeParams("missing"),
    );

    expect(res!.status).toBe(404);
  });

  it("returns 400 for schema validation failures on PATCH", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 429 when PATCH is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
        },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("rethrows unexpected transaction errors on PATCH", async () => {
    mockTransaction.mockRejectedValue(new Error("boom"));

    await expect(
      PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [{ op: "add", path: "members", value: [{ value: USER_1 }] }],
          },
        }),
        makeParams("grp-1"),
      ),
    ).rejects.toThrow("boom");
  });

  describe("A7e: statement counts are independent of N", () => {
    // One member per transition group, each with a distinct previous role so
    // the CAS writes do not collapse into one updateManyAndReturn call:
    // becamePending (create), becamePending (reactivate), pendingRoleRaised,
    // activeRaiseHeld, activeRoleChanged, pendingWithdrawn, activeRemoved,
    // departedUnmarked. The group is the MEMBER mapping, so an active row can
    // sit above it (ADMIN, a demotion) as well as below it (VIEWER, a hold).
    const memberMapping = { ...mapping, role: "MEMBER" };

    function buildFixture(usersPerGroup: number) {
      const addUserIds: string[] = [];
      const removeUserIds: string[] = [];
      const existingMemberships: { id: string; userId: string; role: string; deactivatedAt: Date | null; deactivatedByTenant: boolean; scimApprovalPending: boolean }[] = [];
      const removeMemberships: typeof existingMemberships = [];
      // id -> userId, since a fixture userId is no longer derivable from its
      // member id by stripping an "m-" prefix (F2/S-F3 — userId must be a
      // real uuid now).
      const userIdByMemberId = new Map<string, string>();

      for (let i = 0; i < usersPerGroup; i++) {
        // becamePending via create: no row at all.
        addUserIds.push(fixtureUserId(1, i));
        // becamePending via reactivate: a deactivated, non-pending row.
        const reactivateId = fixtureUserId(2, i);
        addUserIds.push(reactivateId);
        existingMemberships.push({ id: `m-reactivate-${i}`, userId: reactivateId, role: "MEMBER", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: false });
        userIdByMemberId.set(`m-reactivate-${i}`, reactivateId);
        // pendingRoleRaised: a pending row at a lower role (VIEWER < MEMBER).
        const raiseId = fixtureUserId(3, i);
        addUserIds.push(raiseId);
        existingMemberships.push({ id: `m-raise-${i}`, userId: raiseId, role: "VIEWER", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true });
        userIdByMemberId.set(`m-raise-${i}`, raiseId);
        // activeRaiseHeld: an active row at a lower role (VIEWER < MEMBER).
        const holdId = fixtureUserId(8, i);
        addUserIds.push(holdId);
        existingMemberships.push({ id: `m-hold-${i}`, userId: holdId, role: "VIEWER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false });
        userIdByMemberId.set(`m-hold-${i}`, holdId);
        // activeRoleChanged: an active row at a higher role (ADMIN > MEMBER).
        const roleChangeId = fixtureUserId(4, i);
        addUserIds.push(roleChangeId);
        existingMemberships.push({ id: `m-role-${i}`, userId: roleChangeId, role: "ADMIN", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false });
        userIdByMemberId.set(`m-role-${i}`, roleChangeId);
        // pendingWithdrawn: a pending row removed.
        const withdrawId = fixtureUserId(5, i);
        removeUserIds.push(withdrawId);
        removeMemberships.push({ id: `m-withdraw-${i}`, userId: withdrawId, role: "MEMBER", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true });
        userIdByMemberId.set(`m-withdraw-${i}`, withdrawId);
        // activeRemoved: an active row removed.
        const removeId = fixtureUserId(6, i);
        removeUserIds.push(removeId);
        removeMemberships.push({ id: `m-remove-${i}`, userId: removeId, role: "MEMBER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false });
        userIdByMemberId.set(`m-remove-${i}`, removeId);
        // departedUnmarked: a departure-marked row removed.
        const departedId = fixtureUserId(7, i);
        removeUserIds.push(departedId);
        removeMemberships.push({ id: `m-departed-${i}`, userId: departedId, role: "MEMBER", deactivatedAt: new Date(), deactivatedByTenant: true, scimApprovalPending: false });
        userIdByMemberId.set(`m-departed-${i}`, departedId);
      }
      return { addUserIds, removeUserIds, existingMemberships, removeMemberships, userIdByMemberId };
    }

    it.each([
      { usersPerGroup: 2, totalRows: 16 },
      { usersPerGroup: 10, totalRows: 80 },
    ])("gives the same call-shape counts at N = $totalRows", async ({ usersPerGroup, totalRows }) => {
      const { addUserIds, removeUserIds, existingMemberships, removeMemberships, userIdByMemberId } = buildFixture(usersPerGroup);
      // (T6) The fixture builder is the source of truth for "how many rows";
      // pin it against the N the it.each table names so a miscounted group
      // in buildFixture fails loudly here instead of only showing up as a
      // wrong auditRows total below.
      expect(addUserIds.length + removeUserIds.length).toBe(totalRows);

      mockScimGroupMapping.findUnique.mockResolvedValue(memberMapping);
      mockTeamMember.findMany
        .mockResolvedValueOnce(existingMemberships) // applyAddOperations' membership read
        .mockResolvedValueOnce(removeMemberships) // applyRemoveOperations' locked re-read
        .mockResolvedValueOnce([]); // loadGroupMembers after tx

      // Every add candidate is active in the tenant: the mocked lockTenantRows
      // reads tenantMember.findMany for ALL add ids, so the fixture must
      // answer "active" for every one of them.
      mockTenantMember.findMany.mockResolvedValue(addUserIds.map((userId) => ({ userId })));

      mockTeamMember.createMany.mockResolvedValue({ count: usersPerGroup });
      mockTeamMember.deleteMany.mockResolvedValue({ count: usersPerGroup });
      const keyDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          $queryRaw: vi.fn(teamLockQuery([{ id: mapping.teamId }])),
          $executeRaw: vi.fn(),
          teamMember: mockTeamMember,
          tenantMember: mockTenantMember,
          teamMemberKey: { deleteMany: keyDeleteMany },
          scimGroupMapping: mockScimGroupMapping,
        }),
      );
      mockTeamMember.updateManyAndReturn.mockImplementation(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id: string) => ({ id, userId: userIdByMemberId.get(id) })),
      );

      const res = await PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [
              ...addUserIds.map((userId) => ({ op: "add", path: "members", value: [{ value: userId }] })),
              ...removeUserIds.map((userId) => ({ op: "remove", path: `members[value eq "${userId}"]` })),
            ],
          },
        }),
        makeParams("grp-1"),
      );

      expect(res!.status).toBe(200);
      // One createMany for the whole "create" group, whatever N.
      expect(mockTeamMember.createMany).toHaveBeenCalledTimes(1);
      expect(mockTeamMember.create).not.toHaveBeenCalled();
      // One teamMember write per (kind, write shape, previous role): reactivate,
      // pending raise, raise hold, demotion, remove, departed-unmark
      // (updateManyAndReturn each) and withdraw (deleteMany), independent of
      // usersPerGroup.
      expect(mockTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockTeamMember.updateManyAndReturn).toHaveBeenCalledTimes(6);
      expect(mockTeamMember.deleteMany).toHaveBeenCalledTimes(1);
      // Key deletes: one after the reactivate CAS, one after the hold CAS.
      expect(keyDeleteMany).toHaveBeenCalledTimes(2);
      // One bulk audit call per action present (PENDING, WITHDRAW, REMOVE,
      // ROLE_UPDATE), together carrying one row per transition.
      expect(mockLogAuditBulkInTx).toHaveBeenCalledTimes(4);
      const auditRows = mockLogAuditBulkInTx.mock.calls.reduce(
        (sum: number, call: unknown[]) => sum + (call[2] as unknown[]).length,
        0,
      );
      expect(auditRows).toBe(8 * usersPerGroup);

      type AuditRow = { action: string; targetId: string; metadata: Record<string, unknown> };
      const rowsOf = (action: string): AuditRow[] =>
        mockLogAuditBulkInTx.mock.calls
          .flatMap((call: unknown[]) => call[2] as AuditRow[])
          .filter((row: AuditRow) => row.action === action);
      const holdIds = new Set([...Array(usersPerGroup).keys()].map((i) => fixtureUserId(8, i)));
      const pendingRows = rowsOf("TEAM_MEMBER_SCIM_PENDING");
      // create + reactivate + pending raise + hold.
      expect(pendingRows).toHaveLength(4 * usersPerGroup);
      for (const row of pendingRows) {
        if (holdIds.has(row.targetId)) {
          expect(row.metadata).toEqual({ scimTokenId: "t1", role: "MEMBER", previousRole: "VIEWER", previouslyActive: true });
        } else {
          expect(row.metadata).not.toHaveProperty("previouslyActive");
        }
      }
      // ROLE_UPDATE carries only the demotions.
      const roleUpdateRows = rowsOf("TEAM_MEMBER_SCIM_ROLE_UPDATE");
      expect(roleUpdateRows).toHaveLength(usersPerGroup);
      for (const row of roleUpdateRows) {
        expect(row.metadata).toEqual({ scimTokenId: "t1", role: "MEMBER", previousRole: "ADMIN" });
      }
    });
  });

  describe("withdraw shortfall (silent-loss red-proof)", () => {
    it("PATCH: a withdraw shortfall rolls back with 409, no WITHDRAW audit", async () => {
      const pending = [
        { id: "m-1", userId: USER_1, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
        { id: "m-2", userId: USER_2, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
      ];
      mockTeamMember.findMany.mockResolvedValueOnce(pending);
      // findMany found 2 rows; deleteMany only removes 1 (an unlocked writer
      // raced it) — the shortfall must roll the whole PATCH back.
      mockTeamMember.deleteMany.mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [
              { op: "remove", path: `members[value eq "${USER_1}"]` },
              { op: "remove", path: `members[value eq "${USER_2}"]` },
            ],
          },
        }),
        makeParams("grp-1"),
      );

      expect(res!.status).toBe(409);
      const body = await res!.json();
      expect(body.detail).toContain("membership changed");
      expect(mockLogAuditBulkInTx).not.toHaveBeenCalled();
    });

    it("positive control: equal counts commit 200 with one WITHDRAW audit covering both rows", async () => {
      const pending = [
        { id: "m-1", userId: USER_1, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
        { id: "m-2", userId: USER_2, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
      ];
      mockTeamMember.findMany
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce([]); // loadGroupMembers
      mockTeamMember.deleteMany.mockResolvedValue({ count: 2 });

      const res = await PATCH(
        makeReq({
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [
              { op: "remove", path: `members[value eq "${USER_1}"]` },
              { op: "remove", path: `members[value eq "${USER_2}"]` },
            ],
          },
        }),
        makeParams("grp-1"),
      );

      expect(res!.status).toBe(200);
      expect(mockLogAuditBulkInTx).toHaveBeenCalledWith(
        expect.anything(),
        "tenant-1",
        [
          expect.objectContaining({ action: "TEAM_MEMBER_SCIM_PENDING_WITHDRAW", targetId: USER_1 }),
          expect.objectContaining({ action: "TEAM_MEMBER_SCIM_PENDING_WITHDRAW", targetId: USER_2 }),
        ],
      );
    });
  });
});

describe("PUT /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Same reset as the PATCH describe above (T6): clearAllMocks keeps a
    // previously set mockResolvedValue/mockImplementation alive, which would
    // otherwise leak a fixture-sized answer into whichever cell runs next.
    mockTeamMember.findMany.mockReset();
    mockTeamMember.createMany.mockReset();
    mockTenantMember.findMany.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    mockScimGroupMapping.findUnique.mockResolvedValue(mapping);
    mockTeamMember.updateManyAndReturn.mockResolvedValue([]);
    mockTeamMember.deleteMany.mockResolvedValue({ count: 0 });
    // Default transaction: pass tx with batch-capable mocks
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        // The team lock against key rotation (pinned in scim-group-service.test.ts).
        $queryRaw: vi.fn(teamLockQuery([{ id: mapping.teamId }])),
        $executeRaw: vi.fn(),
        teamMember: mockTeamMember,
        tenantMember: mockTenantMember,
        teamMemberKey: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        scimGroupMapping: mockScimGroupMapping,
      }),
    );
  });

  it("replaces role members", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ userId: USER_1 }]) // unlocked pre-read
      .mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "ADMIN" }]) // locked re-read (current)
      .mockResolvedValueOnce([]) // applyAddOperations' membership read for user-2
      .mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "ADMIN", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false }]) // applyRemoveOperations' locked re-read for user-1
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValue([{ userId: USER_2 }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });
    mockTeamMember.updateManyAndReturn.mockResolvedValue([{ id: "tm1", userId: USER_1 }]);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: USER_2 }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
  });

  it("creates a pending team member when user exists in tenant but not in team", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read
      .mockResolvedValueOnce([]) // locked re-read (current)
      .mockResolvedValueOnce([]) // applyAddOperations' membership read
      .mockResolvedValueOnce([{ id: "tm-created", userId: USER_2, user: { id: USER_2, email: "u2@example.com" } }]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValueOnce([{ userId: USER_2 }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: USER_2 }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          teamId: "team-1",
          userId: USER_2,
          tenantId: "tenant-1",
          role: "ADMIN",
          scimManaged: true,
          scimApprovalPending: true,
          deactivatedAt: expect.any(Date),
          keyDistributed: false,
        },
      ],
    });
  });

  // C/F2/S-F3 (review round 2, F-N3/T-N3/T-N4): the same id given in both its
  // lowercase and uppercase form collapses to one createMany row — the body
  // schema (validations.ts) lowercases each value, and the service's own Set
  // dedup takes it from there.
  it("creates one row for the same id given in both its lowercase and uppercase form", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read
      .mockResolvedValueOnce([]) // locked re-read (current)
      .mockResolvedValueOnce([]) // applyAddOperations' membership read
      .mockResolvedValueOnce([]); // loadGroupMembers after tx
    mockTenantMember.findMany.mockResolvedValue([{ userId: USER_1 }]);
    mockTeamMember.createMany.mockResolvedValue({ count: 1 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: USER_1 }, { value: USER_1.toUpperCase() }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.createMany).toHaveBeenCalledTimes(1);
    expect(mockTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: USER_1 }),
      ],
    });
  });

  it("returns 400 for a non-uuid member value on PUT", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: "not-a-uuid" }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    expect(mockTeamMember.createMany).not.toHaveBeenCalled();
  });

  it("returns 400 when displayName does not match the mapped role", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:VIEWER",
          members: [{ value: USER_2 }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
  });

  it("returns 400 when requested member is not active in the tenant", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read
      .mockResolvedValueOnce([]) // locked re-read
      .mockResolvedValueOnce([]); // applyAddOperations' membership read
    mockTenantMember.findMany.mockResolvedValueOnce([]);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [{ value: USER_2 }],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.detail).toContain("not an active member of this tenant");
  });

  it("returns 403 when PUT targets an owner-mapped group", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue({ ...mapping, role: "OWNER" });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:OWNER",
          members: [],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(403);
  });

  it("returns 404 when PUT target is missing", async () => {
    mockScimGroupMapping.findUnique.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [],
        },
      }),
      makeParams("missing"),
    );

    expect(res!.status).toBe(404);
  });

  it("returns 400 for schema validation failures on PUT", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"] },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 429 when PUT is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [],
        },
      }),
      makeParams("grp-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("is a no-op (200, 200 again) when removing a withdrawn-shortfall-free pending member twice via retry", async () => {
    // A4: PUT omitting a pending user withdraws it; a repeated PUT listing it
    // is a no-op. Here: current member set has the pending row; PUT lists no
    // members, so the row is withdrawn via the remove path.
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ userId: USER_1 }]) // unlocked pre-read — user-1 must be in the locked set
      .mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "ADMIN" }]) // locked re-read
      .mockResolvedValueOnce([{ id: "tm1", userId: USER_1, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true }]) // applyRemoveOperations' locked re-read
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTeamMember.deleteMany.mockResolvedValue({ count: 1 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "core:ADMIN",
          members: [],
        },
      }),
      makeParams("grp-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTeamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["tm1"] }, teamId: "team-1", role: "ADMIN", scimApprovalPending: true },
    });
  });

  describe("withdraw shortfall (silent-loss red-proof)", () => {
    it("PUT: a withdraw shortfall rolls back with 409, no WITHDRAW audit", async () => {
      const pending = [
        { id: "m-1", userId: USER_1, role: "ADMIN" },
      ];
      mockTeamMember.findMany
        .mockResolvedValueOnce([{ userId: USER_1 }]) // unlocked pre-read
        .mockResolvedValueOnce(pending) // locked re-read (current members)
        .mockResolvedValueOnce([
          { id: "m-1", userId: USER_1, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
        ]); // applyRemoveOperations' locked re-read
      mockTeamMember.deleteMany.mockResolvedValue({ count: 0 });

      const res = await PUT(
        makeReq({
          method: "PUT",
          body: {
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
            displayName: "core:ADMIN",
            members: [],
          },
        }),
        makeParams("grp-1"),
      );

      expect(res!.status).toBe(409);
      expect(mockLogAuditBulkInTx).not.toHaveBeenCalled();
    });
  });
});

describe("DELETE /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns 405", async () => {
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(405);
  });

  it("returns 401 when token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when DELETE is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("grp-1"));
    expect(res.status).toBe(429);
  });
});
