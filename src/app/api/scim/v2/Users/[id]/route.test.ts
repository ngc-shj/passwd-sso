import { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockTenantMember,
  mockTeamMember,
  mockScimExternalMapping,
  mockTeamMemberKey,
  mockTransaction,
  mockWithTenantRls,
  mockGuardMember,
  mockGuardMapping,
  mockRevokeUserAuthArtifactsInTx,
  mockTombstoneRevokedSessions,
  mockCommit,
  mockLogger,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTenantMember: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  mockTeamMember: { deleteMany: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  mockTeamMemberKey: { deleteMany: vi.fn() },
  mockTransaction: vi.fn(),
  // The route's tenant context is the outermost transaction: the service's
  // `$transaction` joins it in production, so its commit is here.
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => {
    const result = await fn(prisma);
    mockCommit();
    return result;
  }),
  // The reactivation guard's reads live on their OWN client: it resolves the
  // SCIM id and reads the active-membership set in one bypass, and handing it the
  // shared prisma mock would consume from the `mockResolvedValueOnce` sequences
  // the tenant-context cells depend on. `mockGuardMember` is the seam a cell uses
  // to make the guard fire.
  mockGuardMember: { findUnique: vi.fn(), findMany: vi.fn() },
  mockGuardMapping: { findFirst: vi.fn() },
  // SCIM DELETE's revocation, inside deactivateScimUser's transaction.
  mockRevokeUserAuthArtifactsInTx: vi.fn(),
  mockTombstoneRevokedSessions: vi.fn(),
  // Called by the tenant-context double once its callback resolved: the commit.
  mockCommit: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockRealignAfterActivation } = vi.hoisted(() => ({ mockRealignAfterActivation: vi.fn() }));

// Identity is read after the tenant context, through the same bypass seam as the guard.
const { mockGuardUser, mockWithBypassRls } = vi.hoisted(() => {
  const mockGuardUser = { findMany: vi.fn(), findUnique: vi.fn() };
  return {
    mockGuardUser,
    mockWithBypassRls: vi.fn((_prisma: unknown, fn: (tx: unknown) => unknown) =>
      fn({ tenantMember: mockGuardMember, scimExternalMapping: mockGuardMapping, user: mockGuardUser })),
  };
});

vi.mock("@/lib/auth/tokens/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null, acceptLanguage: null }),
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: null, userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: null, userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockTenantMember,
    teamMember: mockTeamMember,
    scimExternalMapping: mockScimExternalMapping,
    teamMemberKey: mockTeamMemberKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls, withBypassRls: mockWithBypassRls }));
// The tenant-row lock and the departure helpers have their own tests and the
// real-DB cells in team-tenant-departure.integration.test.ts. Here the helpers
// answer as the database's conditional UPDATE does, from the membership
// pre-read: a departure transitions an active member, a return an inactive one.
// A departure or return revokes what its transitioned ids hold, derived from its arguments.
const { mockDepartFromTenant, mockReturnToTenant, mockLockTenantRows } = vi.hoisted(() => ({
  mockDepartFromTenant: vi.fn(),
  mockReturnToTenant: vi.fn(),
  mockLockTenantRows: vi.fn(),
}));
vi.mock("@/lib/team/team-departure", () => ({
  departFromTenant: mockDepartFromTenant,
  returnToTenant: mockReturnToTenant,
}));
const { mockEndCreatorFootholds } = vi.hoisted(() => ({ mockEndCreatorFootholds: vi.fn() }));
vi.mock("@/lib/tenant/departure-footholds", () => ({ endCreatorFootholdsInTx: mockEndCreatorFootholds }));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
async function memberPreRead(): Promise<{ deactivatedAt: Date | null } | null> {
  const i = mockTenantMember.findUnique.mock.calls.findIndex(
    (call) => (call[0] as { select?: { role?: boolean } })?.select?.role,
  );
  return i < 0 ? null : await mockTenantMember.findUnique.mock.results[i].value;
}

vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  revokeUserAuthArtifactsInTx: mockRevokeUserAuthArtifactsInTx,
  tombstoneRevokedSessions: mockTombstoneRevokedSessions,
}));
vi.mock("@/lib/tenant/tenant-realignment", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  realignAfterActivation: mockRealignAfterActivation,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => mockLogger,
}));

import { GET, PUT, PATCH, DELETE } from "./route";
import { teamLockQuery } from "@/__tests__/helpers/team-rotation-lock-mock";

/** What a revocation of these users returns, as the database would derive it from them. */
function revokedFor(ids: readonly string[]) {
  return {
    counts: { sessions: ids.length * 2, extensionTokens: ids.length, apiKeys: 0 },
    sessionTokens: ids.flatMap((id) => [`digest-of-${id}-1`, `digest-of-${id}-2`]),
  };
}

beforeEach(() => {
  mockLockTenantRows.mockResolvedValue(new Map());
  mockDepartFromTenant.mockImplementation(async (_tx: unknown, _tenantId: string, ids: string[]) => {
    const userIds = (await memberPreRead())?.deactivatedAt == null ? ids : [];
    return { userIds, revocation: revokedFor(userIds) };
  });
  mockRevokeUserAuthArtifactsInTx.mockImplementation(async (_tx: unknown, userId: string) => revokedFor([userId]));
  mockTombstoneRevokedSessions.mockResolvedValue(0);
  mockReturnToTenant.mockImplementation(async (_tx: unknown, _tenantId: string, ids: string[]) => {
    const userIds = (await memberPreRead())?.deactivatedAt != null ? ids : [];
    return { userIds, revocation: revokedFor(userIds) };
  });
});
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

/**
 * Who owns `user-1` as the ownership read sees it: filed here and active nowhere
 * by default. The same bypass `user.findMany` also serves the display read, so
 * the query tells them apart.
 */
const ownership = { column: "tenant-1", active: [] as Array<{ tenantId: string }> };
function guardUserRows({ select }: { select?: { tenantMemberships?: unknown } }) {
  return Promise.resolve(
    select?.tenantMemberships
      ? [{ id: "user-1", tenantId: ownership.column, tenantMemberships: ownership.active }]
      : [{ id: "user-1", email: "u@example.com", name: "User", image: null }],
  );
}

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1", actorType: "HUMAN" as const },
};

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(options: { method?: string; body?: unknown } = {}) {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest("http://localhost/api/scim/v2/Users/user-1", init as ConstructorParameters<typeof NextRequest>[1]);
}

/**
 * The tombstone follows the commit of the transaction holding `transition`:
 * the first commit after that call, not merely some earlier one.
 */
function expectTombstoneAfterCommitFollowing(transition: { mock: { invocationCallOrder: number[] } }) {
  const transitionOrder = transition.mock.invocationCallOrder[0];
  expect(transitionOrder).toBeDefined();
  const commit = mockCommit.mock.invocationCallOrder.find((order) => order > transitionOrder!);
  expect(commit).toBeDefined();
  expect(commit!).toBeLessThan(mockTombstoneRevokedSessions.mock.invocationCallOrder[0]!);
}

describe("GET /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    ownership.column = "tenant-1";
    ownership.active = [];
    mockGuardUser.findMany.mockImplementation(guardUserRows);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("returns tenant user resource", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("u@example.com");
    expect(body.active).toBe(true);
  });

  it("builds the resource from identity read after the tenant context, not through the relation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: "moved@example.com", name: "Moved", image: null }]);

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).userName).toBe("moved@example.com");
    const snapshotRead = mockTenantMember.findUnique.mock.calls[1][0];
    expect(snapshotRead).not.toHaveProperty("include");
    expect(snapshotRead.select).toEqual({ userId: true, deactivatedAt: true });
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP,
    );
  });

  it("returns 404 when user cannot be resolved", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when resolved user has no email resource", async () => {
    mockGuardUser.findMany.mockResolvedValue([{ id: "user-1", email: null, name: "User", image: null }]);
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });

    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(404);
  });

  it("returns 401 when SCIM token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when GET is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await GET(makeReq(), makeParams("user-1"));
    expect(res.status).toBe(429);
  });
});

describe("PUT /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    ownership.column = "tenant-1";
    ownership.active = [];
    mockGuardUser.findMany.mockImplementation(guardUserRows);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("deactivates tenant member", async () => {
    // Filed under another tenant: ownership is asked only of a reactivation, and a
    // deactivation is the operation that can never take a user from anyone.
    ownership.column = "other-tenant";
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tm1" } }),
    );
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("refuses PUT reactivation of a member active in another tenant, with the one detail and an audit row", async () => {
    // The guard the CREATE path has always had and the reactivation arms did
    // not. Reachable by a holder of THIS tenant's SCIM token — a principal with
    // no authority in the tenant the user actually belongs to. Two active
    // memberships makes `resolveUserTenantIdFromClient` throw, and the proxy
    // auth gate calls it on every request, so the effect is that this tenant can
    // invalidate every session of a user who belongs to another.
    // As production has it: an active membership in another tenant makes that
    // tenant the owner (R7-T2). A fixture with one and not the other built a state
    // that cannot exist, and let the refusal's order go unpinned.
    ownership.active = [{ tenantId: "other-tenant" }];

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(409);
    // The detail a suspended user gets too (round-7 R7-S3).
    expect(JSON.stringify(await res!.json())).toContain("cannot be provisioned by this organization");
    // Positive: nothing was written. A 409 with the update already applied would
    // be the same status and the opposite outcome.
    expect(mockTenantMember.update).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATION_REFUSED",
        targetId: "user-1",
        metadata: { reason: "owned_by_another_tenant" },
      }),
    );
  });

  it("refuses PUT reactivation of a member another tenant owns, though they are active nowhere", async () => {
    // Round-6 R6-S2: the uniqueness guard clears this user — the tenant that owns
    // them suspended them — and uniqueness is not authority.
    ownership.column = "other-tenant";

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "u@example.com", active: true },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(409);
    expect(JSON.stringify(await res!.json())).toContain("cannot be provisioned by this organization");
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockTenantMember.update).not.toHaveBeenCalled();
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATION_REFUSED",
        targetId: "user-1",
        metadata: { reason: "owned_by_another_tenant" },
      }),
    );
  });

  it("allows PUT reactivation when the user's only active membership is this tenant", async () => {
    // The allow half. Without it the guard is indistinguishable from one that
    // refuses every reactivation.
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    ownership.active = [{ tenantId: "tenant-1" }];
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    // Wired here, not inherited: `vi.clearAllMocks()` clears calls, not
    // implementations, so a cell that relied on a sibling's `$transaction` stub
    // passed in file order and failed alone. Measured on both of these.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "SCIM_USER_REACTIVATION_REFUSED" }),
    );
  });

  it("answers 200 and logs when the realignment after a committed reactivation fails", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date() })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: null });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    mockRealignAfterActivation.mockRejectedValue(new Error("bypass unavailable"));

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      "scim.realign-failed",
    );
  });

  it("does not refuse a DEACTIVATING PUT even with an active membership elsewhere", async () => {
    // The boundary: the guard is on the TRANSITION, not on the state. A request
    // that deactivates cannot add a second active membership, and refusing it
    // would block the very operation that repairs the condition.
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: new Date() });
    ownership.active = [{ tenantId: "other-tenant" }];
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    // Wired here, not inherited: `vi.clearAllMocks()` clears calls, not
    // implementations, so a cell that relied on a sibling's `$transaction` stub
    // passed in file order and failed alone. Measured on both of these.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: false,
        },
      }) as never,
      { params: Promise.resolve({ id: "user-1" }) },
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalled();
  });

  it("returns 403 when deactivating OWNER via PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", deactivatedAt: null });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "owner@example.com",
          active: false,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(403);
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 409 when externalId conflicts with another user on PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue({
      tenantId: "tenant-1",
      externalId: "ext-1",
      internalId: "other-user",
      resourceType: "User",
    });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
          externalId: "ext-1",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.detail).toContain("externalId");
  });

  it("sets externalId mapping when provided on PUT", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    mockScimExternalMapping.create.mockResolvedValue({});

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
          externalId: "ext-new",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", internalId: "user-1", resourceType: "User" },
    });
    expect(mockScimExternalMapping.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", externalId: "ext-new", resourceType: "User", internalId: "user-1" },
    });
  });

  it("returns 400 for invalid JSON on PUT", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PUT",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PUT(req, makeParams("user-1"));
    expect(res!.status).toBe(400);
  });

  it("reactivates member and removes external mapping when externalId is omitted", async () => {
    const deactivatedAt = new Date("2024-01-01T00:00:00.000Z");

    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          active: true,
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockScimExternalMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        internalId: "user-1",
        resourceType: "User",
      },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }));
    // After the commit: this tenant's context cannot write a users row filed elsewhere.
    expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-1", "tenant-1", {
      source: "scim",
      actorUserId: "u1",
      actorType: "HUMAN",
    });
  });

  it("returns 400 for schema validation failures on PUT", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PUT target is missing", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
        },
      }),
      makeParams("missing"),
    );
    expect(res!.status).toBe(404);
  });

  it("returns 429 when PUT is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(429);
  });

  it("returns 409 for unique-constraint failures from mapping create", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError("dup", {
              code: "P2002",
              clientVersion: "test",
              meta: { modelName: "ScimExternalMapping" },
            }),
          ),
        },
      }),
    );
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "u@example.com",
          externalId: "ext-1",
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
  });

  it("deactivates through team-departure, in the transaction that locked the tenant row", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: new Date() });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: { findFirst: mockScimExternalMapping.findFirst, deleteMany: mockScimExternalMapping.deleteMany, create: mockScimExternalMapping.create },
      }),
    );
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });

    const res = await PUT(
      makeReq({ method: "PUT", body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "u@example.com", active: false } }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLockTenantRows).toHaveBeenCalledWith(expect.anything(), "tenant-1", ["user-1"], "update", expect.anything());
    expect(mockDepartFromTenant).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      ["user-1"],
      expect.objectContaining({ alreadyLocked: true, actor: expect.objectContaining({ userId: "u1", actorType: "HUMAN" }) }),
    );
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockDepartFromTenant.mock.invocationCallOrder[0]);
    expect(mockTenantMember.update.mock.calls[0][0].data).not.toHaveProperty("deactivatedAt");
  });

  it("answers 409 when the tenant row is held past the lock wait on PUT", async () => {
    const { TenantMemberLockTimeoutError } = await vi.importActual<typeof import("@/lib/team/tenant-row-lock")>("@/lib/team/tenant-row-lock");
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tenantMember: { update: mockTenantMember.update } }));
    mockLockTenantRows.mockRejectedValueOnce(new TenantMemberLockTimeoutError());

    const res = await PUT(
      makeReq({ method: "PUT", body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "u@example.com", active: false } }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
    expect(mockDepartFromTenant).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  /** A PUT of `active` against the member's pre-read state, its transaction running its callback. */
  async function putActive(active: boolean, wasDeactivated: boolean) {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: wasDeactivated ? new Date() : null })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: active ? null : new Date() });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const result = await fn({
        tenantMember: { update: mockTenantMember.update },
        scimExternalMapping: {
          findFirst: mockScimExternalMapping.findFirst,
          deleteMany: mockScimExternalMapping.deleteMany,
          create: mockScimExternalMapping.create,
        },
      });
      return result;
    });
    mockScimExternalMapping.deleteMany.mockResolvedValue({ count: 0 });
    return PUT(
      makeReq({
        method: "PUT",
        body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "u@example.com", active },
      }),
      makeParams("user-1"),
    );
  }

  it("tombstones what the PUT deactivation revoked, after the commit, and records the counts", async () => {
    const res = await putActive(false, false);

    expect(res!.status).toBe(200);
    expect(mockTombstoneRevokedSessions).toHaveBeenCalledWith(
      ["digest-of-user-1-1", "digest-of-user-1-2"],
      { reason: "scim_deprovision", operation: "SCIM user deprovisioning", userId: "user-1" },
    );
    expectTombstoneAfterCommitFollowing(mockDepartFromTenant);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_DEACTIVATE",
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0, cacheTombstoneFailures: 0 }),
      }),
    );
  });

  // The return revokes what the user still holds in the tenant (leftovers of a
  // departure that did not revoke), so a reactivation cannot revive them.
  it("tombstones what the PUT reactivation revoked, after the commit, and records the counts", async () => {
    const res = await putActive(true, true);

    expect(res!.status).toBe(200);
    expect(mockTombstoneRevokedSessions).toHaveBeenCalledWith(
      ["digest-of-user-1-1", "digest-of-user-1-2"],
      { reason: "scim_deprovision", operation: "SCIM user deprovisioning", userId: "user-1" },
    );
    expectTombstoneAfterCommitFollowing(mockReturnToTenant);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATE",
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0, cacheTombstoneFailures: 0 }),
      }),
    );
  });

  it("tombstones nothing and records no counts on a PUT active=true of a member already active", async () => {
    const res = await putActive(true, false);

    expect(res!.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_UPDATE" }));
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls[0][0].metadata).not.toHaveProperty("sessions");
  });

  it("tombstones nothing on a PUT active=false of a member already inactive (nothing transitioned)", async () => {
    const res = await putActive(false, true);

    expect(res!.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_UPDATE" }));
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });

  // The deactivation and its revocation are one transaction: a revocation
  // failure inside the departure rolls the deactivation back, so the IdP's
  // retry transitions and revokes again (plan C3).
  it("answers no 2xx, audits nothing and tombstones nothing when the revocation fails inside the PUT's transaction", async () => {
    mockDepartFromTenant.mockImplementationOnce(async () => {
      expect(mockTransaction).toHaveBeenCalled();
      throw new Error("revocation failed");
    });

    await expect(putActive(false, false)).rejects.toThrow("revocation failed");
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });

  it("answers 409 with the sign-in reason when the user's credential lock is held past the wait on PUT", async () => {
    const { UserAuthLockTimeoutError } = await vi.importActual<typeof import("@/lib/auth/session/user-auth-serialization")>("@/lib/auth/session/user-auth-serialization");
    mockDepartFromTenant.mockRejectedValueOnce(new UserAuthLockTimeoutError());

    const res = await putActive(false, false);

    expect(res!.status).toBe(409);
    expect((await res!.json()).detail).toBe("The user's sign-in state is being changed; retry later");
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    ownership.column = "tenant-1";
    ownership.active = [];
    mockGuardUser.findMany.mockImplementation(guardUserRows);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("returns 400 for unsupported patch operation", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: "active" }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(400);
  });

  it("returns 403 when deactivating OWNER via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER", deactivatedAt: null });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(403);
    expect(mockTenantMember.update).not.toHaveBeenCalled();
  });

  it("updates member state via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date(),
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm1" },
        data: expect.objectContaining({ scimManaged: true, provisioningSource: "SCIM" }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_DEACTIVATE" }));
  });

  it("returns 400 for invalid JSON on PATCH", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users/user-1", {
      method: "PATCH",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, makeParams("user-1"));
    expect(res!.status).toBe(400);
  });

  it("returns 404 when PATCH target is missing", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("missing"),
    );
    expect(res!.status).toBe(404);
  });

  it("refuses PATCH reactivation of a member active in another tenant, with the one detail and an audit row", async () => {
    // The PUT twin got three cells and this one got none — deleting the whole
    // PATCH guard block left the entire suite green (measured). Same twin-drift
    // shape the round itself was reviewing.
    // As production has it: an active membership in another tenant makes that
    // tenant the owner (R7-T2). A fixture with one and not the other built a state
    // that cannot exist, and let the refusal's order go unpinned.
    ownership.active = [{ tenantId: "other-tenant" }];

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
    expect(JSON.stringify(await res!.json())).toContain("cannot be provisioned by this organization");
    // Nothing was written. A 409 with the update already applied is the same
    // status and the opposite outcome.
    expect(mockTenantMember.update).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATION_REFUSED",
        targetId: "user-1",
        metadata: { reason: "owned_by_another_tenant" },
      }),
    );
  });

  it("refuses PATCH reactivation of a member another tenant owns, though they are active nowhere", async () => {
    ownership.column = "other-tenant";

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(409);
    expect(JSON.stringify(await res!.json())).toContain("cannot be provisioned by this organization");
    expect(mockTenantMember.update).not.toHaveBeenCalled();
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATION_REFUSED",
        targetId: "user-1",
        metadata: { reason: "owned_by_another_tenant" },
      }),
    );
  });

  it("does not refuse a name-only PATCH, which cannot reactivate", async () => {
    // The boundary PUT and PATCH do NOT share. `patchScimUser` touches
    // `deactivatedAt` only when `operations.active !== undefined`, so a
    // display-name PATCH performs no transition — gating it on `!== false`
    // (PUT's predicate) 409'd it. PUT's schema defaults `active` to true and
    // writes unconditionally, so `!== false` is correct there and wrong here.
    ownership.column = "other-tenant";
    ownership.active = [{ tenantId: "other-tenant" }];
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date("2024-01-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: new Date("2024-01-01T00:00:00.000Z"),
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "name.formatted", value: "Renamed" }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    // No transition, so nothing to realign.
    expect(mockRealignAfterActivation).not.toHaveBeenCalled();
  });

  it("reactivates member via PATCH", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: new Date("2024-01-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        userId: "user-1",
        deactivatedAt: null,
      });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        },
      }),
      makeParams("user-1"),
    );

    expect(res!.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_REACTIVATE" }));
    expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-1", "tenant-1", {
      source: "scim",
      actorUserId: "u1",
      actorType: "HUMAN",
    });
  });

  it("returns 400 for schema validation failures on PATCH", async () => {
    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] },
      }),
      makeParams("user-1"),
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
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      }),
      makeParams("user-1"),
    );
    expect(res!.status).toBe(429);
  });

  /** A PATCH of `active` against the member's pre-read state, its transaction running its callback. */
  async function patchActive(active: boolean, wasDeactivated: boolean) {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: wasDeactivated ? new Date() : null })
      .mockResolvedValueOnce({ userId: "user-1", deactivatedAt: active ? null : new Date() });
    mockTenantMember.update.mockResolvedValue({});
    mockScimExternalMapping.findFirst.mockResolvedValue(null);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const result = await fn({ tenantMember: { update: mockTenantMember.update } });
      return result;
    });
    return PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: active }],
        },
      }),
      makeParams("user-1"),
    );
  }

  it("tombstones what the PATCH deactivation revoked, after the commit, and records the counts", async () => {
    const res = await patchActive(false, false);

    expect(res!.status).toBe(200);
    expect(mockTombstoneRevokedSessions).toHaveBeenCalledWith(
      ["digest-of-user-1-1", "digest-of-user-1-2"],
      { reason: "scim_deprovision", operation: "SCIM user deprovisioning", userId: "user-1" },
    );
    expectTombstoneAfterCommitFollowing(mockDepartFromTenant);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_DEACTIVATE",
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0, cacheTombstoneFailures: 0 }),
      }),
    );
  });

  it("tombstones what the PATCH reactivation revoked, after the commit, and records the counts", async () => {
    const res = await patchActive(true, true);

    expect(res!.status).toBe(200);
    expect(mockTombstoneRevokedSessions).toHaveBeenCalledWith(
      ["digest-of-user-1-1", "digest-of-user-1-2"],
      { reason: "scim_deprovision", operation: "SCIM user deprovisioning", userId: "user-1" },
    );
    expectTombstoneAfterCommitFollowing(mockReturnToTenant);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_REACTIVATE",
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0, cacheTombstoneFailures: 0 }),
      }),
    );
  });

  it("tombstones nothing and records no counts on a PATCH active=true of a member already active", async () => {
    const res = await patchActive(true, false);

    expect(res!.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_UPDATE" }));
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls[0][0].metadata).not.toHaveProperty("sessions");
  });

  it("answers no 2xx, audits nothing and tombstones nothing when the revocation fails inside the PATCH's transaction", async () => {
    mockDepartFromTenant.mockImplementationOnce(async () => {
      expect(mockTransaction).toHaveBeenCalled();
      throw new Error("revocation failed");
    });

    await expect(patchActive(false, false)).rejects.toThrow("revocation failed");
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/scim/v2/Users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, NOT the `mockResolvedValueOnce` queue: a
    // cell that returns early leaves its unconsumed values to answer the next
    // cell's reads. Observed as five unrelated cells failing under a mutation
    // that should have killed one.
    mockTenantMember.findUnique.mockReset();
    mockScimExternalMapping.findFirst.mockReset();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue({ allowed: true });
    // Defaults for the reactivation guard, on its own client: the SCIM id
    // resolves to `user-1`, and nothing is active anywhere else. Cells that
    // exercise the guard override `mockGuardMember.findMany`.
    mockGuardMember.findUnique.mockResolvedValue({ userId: "user-1" });
    mockGuardMember.findMany.mockResolvedValue([]);
    mockGuardMapping.findFirst.mockResolvedValue(null);
    ownership.column = "tenant-1";
    ownership.active = [];
    mockGuardUser.findMany.mockImplementation(guardUserRows);
    mockGuardUser.findUnique.mockResolvedValue({ email: "u@example.com", name: "User", locale: null });
    mockRealignAfterActivation.mockResolvedValue(null);
  });

  it("removes tenant member and related records", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue(revokedFor(["user-1"]));

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(204);
    // Interactive: the team lock against key rotation runs first inside it
    // (pinned in scim-user-service.test.ts).
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("returns 403 when deleting OWNER via DELETE", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "OWNER" });

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when related resources block deletion", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "test",
      }),
    );

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(409);
  });

  it("returns 404 when deleting an unknown user", async () => {
    mockTenantMember.findUnique.mockResolvedValue(null);
    mockScimExternalMapping.findFirst.mockResolvedValue(null);

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("missing"));
    expect(res!.status).toBe(404);
  });

  it("returns 429 when DELETE is rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));
    expect(res!.status).toBe(429);
  });

  /** deactivateScimUser's transaction running its callback over the lock and delete statements. */
  function runDeleteTransaction() {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const result = await fn({
        $queryRaw: teamLockQuery((sql) => (sql.includes("FROM teams") ? [{ id: "team-1" }] : [{ team_id: "team-1" }])),
        $executeRaw: vi.fn().mockResolvedValue(0),
        teamMemberKey: { deleteMany: mockTeamMemberKey.deleteMany },
        scimExternalMapping: { deleteMany: mockScimExternalMapping.deleteMany },
        tenantMember: { delete: mockTenantMember.delete },
      });
      return result;
    });
  }

  it("revokes inside the deletion's transaction, then tombstones and records the counts", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    runDeleteTransaction();

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(res!.status).toBe(204);
    expect(mockRevokeUserAuthArtifactsInTx).toHaveBeenCalledWith(expect.anything(), "user-1", {
      tenantFilter: { tenantId: "tenant-1" },
      boundedLockWait: true,
    });
    expect(mockTombstoneRevokedSessions).toHaveBeenCalledWith(
      ["digest-of-user-1-1", "digest-of-user-1-2"],
      { reason: "scim_deprovision", operation: "SCIM user deprovisioning", userId: "user-1" },
    );
    expectTombstoneAfterCommitFollowing(mockRevokeUserAuthArtifactsInTx);
    expect(mockEndCreatorFootholds).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "tenant-1",
      ["user-1"],
      expect.objectContaining({ userId: SCIM_TOKEN_DATA.data.auditUserId, actorType: SCIM_TOKEN_DATA.data.actorType }),
    );
    expect(mockEndCreatorFootholds.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRevokeUserAuthArtifactsInTx.mock.invocationCallOrder[0]!,
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_DELETE",
        metadata: expect.objectContaining({ sessions: 2, extensionTokens: 1, apiKeys: 0, cacheTombstoneFailures: 0 }),
      }),
    );
  });

  // A retry finds the member still there (no 404), because the deletion
  // rolled back with the revocation (plan C3).
  it("answers no 2xx, audits nothing and tombstones nothing when the revocation fails inside the transaction", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    runDeleteTransaction();
    mockRevokeUserAuthArtifactsInTx.mockRejectedValueOnce(new Error("revocation failed"));

    await expect(DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"))).rejects.toThrow("revocation failed");
    expect(mockTenantMember.delete).toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });

  it("answers 409 with the sign-in reason when the user's credential lock is held past the wait on DELETE", async () => {
    const { UserAuthLockTimeoutError } = await vi.importActual<typeof import("@/lib/auth/session/user-auth-serialization")>("@/lib/auth/session/user-auth-serialization");
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    runDeleteTransaction();
    mockRevokeUserAuthArtifactsInTx.mockRejectedValueOnce(new UserAuthLockTimeoutError());

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(res!.status).toBe(409);
    expect((await res!.json()).detail).toBe("The user's sign-in state is being changed; retry later");
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockTombstoneRevokedSessions).not.toHaveBeenCalled();
  });

  it("records the email read after the tenant context, not through the membership's relation", async () => {
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue(revokedFor(["user-1"]));
    mockGuardUser.findUnique.mockResolvedValue({ email: "moved@example.com", name: "Moved", locale: null });

    await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(mockTenantMember.findUnique.mock.calls[1][0].select).toEqual({ id: true, role: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ email: "moved@example.com" }) }),
    );
  });

  it("still records the committed deletion when the email read fails", async () => {
    // The read runs after the deletion committed. Throwing out of it answered the
    // IdP with a 500 for a user that was gone and left SCIM_USER_DELETE unwritten
    // (round-5 F2).
    mockTenantMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockTransaction.mockResolvedValue(revokedFor(["user-1"]));
    mockGuardUser.findUnique.mockRejectedValue(new Error("bypass unavailable"));

    const res = await DELETE(makeReq({ method: "DELETE" }), makeParams("user-1"));

    expect(res!.status).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SCIM_USER_DELETE",
        metadata: expect.objectContaining({ email: null }),
      }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      "scim.delete-contact-read-failed",
    );
  });
});
