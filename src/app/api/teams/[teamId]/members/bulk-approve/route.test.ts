import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockRequireRecent,
  mockLimiterCheck,
  mockCreateRateLimiter,
  mockApproveScimPending,
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
  const _tx = { marker: "tx" };
  return {
    mockAuth: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    mockRequireRecent: vi.fn(),
    mockLimiterCheck: vi.fn(),
    // Recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn(),
    mockApproveScimPending: vi.fn(),
    mockPrismaTeamMember: { findMany: vi.fn() },
    // The admission transaction runs as fn(tenantId, tx) with an options
    // argument; the pre-read as fn() without one.
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown, _options?: { timeout: number }) =>
      fn("tenant-1", _tx)),
    TeamAuthError: _TeamAuthError,
    tx: _tx,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: { teamMember: mockPrismaTeamMember } }));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({ requireRecentCurrentAuthMethod: mockRequireRecent }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter.mockImplementation((_opts: unknown) => ({ check: mockLimiterCheck })),
}));
vi.mock("@/lib/tenant-context", () => ({ withTeamTenantRls: mockWithTeamTenantRls }));
// The adjudicator has its own tests (scim-admission.test.ts); the route's
// contract is what it hands the module and how it maps the answer.
vi.mock("@/lib/team/scim-admission", () => ({ approveScimPending: mockApproveScimPending }));
vi.mock("@/lib/audit/audit", () => ({
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));

import { POST } from "./route";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { SCIM_APPROVE_OUTCOME, SCIM_BULK_ADMISSION_MAX } from "@/lib/constants/team/scim-admission";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";

// Module-scope snapshot (route.ts `bulkApproveLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const limiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const bulkApproveLimiter = mockCreateRateLimiter.mock.results[0]!.value as { check: typeof mockLimiterCheck };

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const USER_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const USER_C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

const URL = `http://localhost:3000/api/teams/${TEAM_ID}/members/bulk-approve`;

function bulkApprove(body: unknown = { members: [{ memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER }] }) {
  return POST(createRequest("POST", URL, { body }), createParams({ teamId: TEAM_ID }));
}

/** The admission transaction is the withTeamTenantRls call that passes options. */
function transactionEntered() {
  return mockWithTeamTenantRls.mock.calls.some((call) => call[2] !== undefined);
}

function expectNothingAttempted() {
  expect(mockPrismaTeamMember.findMany).not.toHaveBeenCalled();
  expect(mockApproveScimPending).not.toHaveBeenCalled();
  expect(transactionEntered()).toBe(false);
}

describe("POST /api/teams/[teamId]/members/bulk-approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_ID } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockRequireRecent.mockResolvedValue(null);
    mockLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaTeamMember.findMany.mockResolvedValue([{ id: MEMBER_A, userId: USER_A }]);
    mockApproveScimPending.mockImplementation(async (_tx, _tenantId, _ctx, targets: { memberId: string }[]) =>
      new Map(targets.map((t) => [t.memberId, SCIM_APPROVE_OUTCOME.APPROVED])));
  });

  it("fails closed (503, nothing attempted) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => bulkApprove(),
      limiter: bulkApproveLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockApproveScimPending, mockPrismaTeamMember.findMany],
      limiterFactory: limiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
    expect(transactionEntered()).toBe(false);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await bulkApprove()).status).toBe(401);
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
    expectNothingAttempted();
  });

  it("propagates requireTeamPermission's 404, attempting nothing", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    expect((await bulkApprove()).status).toBe(404);
    expect(mockRequireRecent).not.toHaveBeenCalled();
    expectNothingAttempted();
  });

  it("returns the step-up error, attempting nothing", async () => {
    mockRequireRecent.mockResolvedValue(Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));
    const res = await bulkApprove();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockLimiterCheck).not.toHaveBeenCalled();
    expectNothingAttempted();
  });

  it("returns the step-up error, not 400, for an invalid body", async () => {
    mockRequireRecent.mockResolvedValue(Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));
    const res = await bulkApprove({ members: [] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SESSION_STEP_UP_REQUIRED");
    expectNothingAttempted();
  });

  it("returns 429 for a valid body without reaching the pre-read", async () => {
    mockLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await bulkApprove()).status).toBe(429);
    expectNothingAttempted();
  });

  it.each([
    ["an empty list", { members: [] }],
    ["more than SCIM_BULK_ADMISSION_MAX entries", {
      members: Array.from({ length: SCIM_BULK_ADMISSION_MAX + 1 }, (_, i) => ({
        memberId: `00000000-0000-4000-a000-${(i + 1).toString(16).padStart(12, "0")}`,
        expectedRole: TEAM_ROLE.MEMBER,
      })),
    }],
    ["a duplicate id", { members: [
      { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
      { memberId: MEMBER_A, expectedRole: TEAM_ROLE.ADMIN },
    ] }],
    ["a duplicate id differing only in case", { members: [
      { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
      { memberId: MEMBER_A.toUpperCase(), expectedRole: TEAM_ROLE.MEMBER },
    ] }],
    ["an OWNER expectedRole", { members: [{ memberId: MEMBER_A, expectedRole: TEAM_ROLE.OWNER }] }],
    ["an unknown expectedRole", { members: [{ memberId: MEMBER_A, expectedRole: "GOD" }] }],
    ["a non-uuid memberId", { members: [{ memberId: "nope", expectedRole: TEAM_ROLE.MEMBER }] }],
    ["an unknown body key", { members: [{ memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER }], extra: true }],
    ["an unknown entry key", { members: [{ memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER, extra: true }] }],
  ])("returns 400 for %s, attempting nothing", async (_label, body) => {
    expect((await bulkApprove(body)).status).toBe(400);
    expectNothingAttempted();
  });

  it("pre-reads only this team's pending rows by the requested ids", async () => {
    await bulkApprove({ members: [{ memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER }] });
    expect(mockPrismaTeamMember.findMany).toHaveBeenCalledWith({
      where: { id: { in: [MEMBER_A] }, teamId: TEAM_ID, scimApprovalPending: true },
      select: { id: true, userId: true },
    });
  });

  it("gives each target its own expectedRole and answers in request order when the pre-read order differs", async () => {
    // Request order A, B, C with roles MEMBER, ADMIN, MEMBER; the pre-read
    // returns C, A, B.
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: MEMBER_C, userId: USER_C },
      { id: MEMBER_A, userId: USER_A },
      { id: MEMBER_B, userId: USER_B },
    ]);
    mockApproveScimPending.mockResolvedValue(new Map([
      [MEMBER_A, SCIM_APPROVE_OUTCOME.APPROVED],
      [MEMBER_B, SCIM_APPROVE_OUTCOME.ROLE_CHANGED],
      [MEMBER_C, SCIM_APPROVE_OUTCOME.TENANT_INACTIVE],
    ]));

    const res = await bulkApprove({
      members: [
        { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
        { memberId: MEMBER_B, expectedRole: TEAM_ROLE.ADMIN },
        { memberId: MEMBER_C, expectedRole: TEAM_ROLE.VIEWER },
      ],
    });

    expect(res.status).toBe(200);
    const targets = mockApproveScimPending.mock.calls[0][3] as { memberId: string; userId: string; expectedRole: string }[];
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(expect.arrayContaining([
      { memberId: MEMBER_A, userId: USER_A, expectedRole: TEAM_ROLE.MEMBER },
      { memberId: MEMBER_B, userId: USER_B, expectedRole: TEAM_ROLE.ADMIN },
      { memberId: MEMBER_C, userId: USER_C, expectedRole: TEAM_ROLE.VIEWER },
    ]));
    expect((await res.json()).results).toEqual([
      { memberId: MEMBER_A, outcome: "approved" },
      { memberId: MEMBER_B, outcome: "role_changed" },
      { memberId: MEMBER_C, outcome: "tenant_inactive" },
    ]);
  });

  it("answers not_found for ids the pre-read did not return, keeping request order", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([{ id: MEMBER_B, userId: USER_B }]);

    const res = await bulkApprove({
      members: [
        { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
        { memberId: MEMBER_B, expectedRole: TEAM_ROLE.MEMBER },
        { memberId: MEMBER_C, expectedRole: TEAM_ROLE.MEMBER },
      ],
    });

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { memberId: MEMBER_A, outcome: "not_found" },
      { memberId: MEMBER_B, outcome: "approved" },
      { memberId: MEMBER_C, outcome: "not_found" },
    ]);
    expect(mockApproveScimPending.mock.calls[0][3]).toEqual([
      { memberId: MEMBER_B, userId: USER_B, expectedRole: TEAM_ROLE.MEMBER },
    ]);
  });

  it("answers 200 with every id not_found and opens no transaction when the pre-read is empty", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);

    const res = await bulkApprove({
      members: [
        { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
        { memberId: MEMBER_B, expectedRole: TEAM_ROLE.ADMIN },
      ],
    });

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { memberId: MEMBER_A, outcome: "not_found" },
      { memberId: MEMBER_B, outcome: "not_found" },
    ]);
    expect(mockApproveScimPending).not.toHaveBeenCalled();
    expect(transactionEntered()).toBe(false);
  });

  it("returns lowercased memberIds when the request used upper case", async () => {
    const res = await bulkApprove({ members: [{ memberId: MEMBER_A.toUpperCase(), expectedRole: TEAM_ROLE.MEMBER }] });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ memberId: MEMBER_A, outcome: "approved" }]);
    expect(mockPrismaTeamMember.findMany.mock.calls[0][0].where.id).toEqual({ in: [MEMBER_A] });
  });

  it("returns 403 when the module refuses the approver", async () => {
    mockApproveScimPending.mockResolvedValue(null);
    const res = await bulkApprove();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("FORBIDDEN");
  });

  it("returns 409 TEAM_BUSY when a lock cannot be taken in budget", async () => {
    mockApproveScimPending.mockRejectedValue(new TeamRotationInProgressError());
    const res = await bulkApprove();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
  });

  it("rethrows a non-lock error from the transaction", async () => {
    mockApproveScimPending.mockRejectedValue(new Error("boom"));
    await expect(bulkApprove()).rejects.toThrow("boom");
  });

  it("runs the module in the team's tenant transaction with the actor, request meta and a batchId", async () => {
    await bulkApprove();

    expect(mockApproveScimPending).toHaveBeenCalledTimes(1);
    const [txArg, tenantId, ctx] = mockApproveScimPending.mock.calls[0];
    expect(txArg).toBe(tx);
    expect(tenantId).toBe("tenant-1");
    expect(ctx).toEqual({
      teamId: TEAM_ID,
      actorUserId: ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      batchId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(transactionEntered()).toBe(true);
    expect(mockRequireTeamPermission).toHaveBeenCalledWith(ACTOR_ID, TEAM_ID, TEAM_PERMISSION.MEMBER_INVITE, expect.anything());
    const txCall = mockWithTeamTenantRls.mock.calls.find((call) => call[2] !== undefined)!;
    expect(txCall[2]).toEqual({ timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS });
    expect(mockLimiterCheck).toHaveBeenCalledWith(`rl:team_member_bulk_approve:${ACTOR_ID}`);
    expect(limiterFactorySnapshot.replay().mock.calls[0][0]).toMatchObject({ max: 10 });
  });

  it("passes one batchId per request, differing between requests", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: MEMBER_A, userId: USER_A },
      { id: MEMBER_B, userId: USER_B },
    ]);
    const body = {
      members: [
        { memberId: MEMBER_A, expectedRole: TEAM_ROLE.MEMBER },
        { memberId: MEMBER_B, expectedRole: TEAM_ROLE.MEMBER },
      ],
    };

    await bulkApprove(body);
    await bulkApprove(body);

    // One module call per request carries the batchId for all of its targets.
    expect(mockApproveScimPending).toHaveBeenCalledTimes(2);
    expect(mockApproveScimPending.mock.calls[0][3]).toHaveLength(2);
    const [first, second] = mockApproveScimPending.mock.calls.map((call) => call[2].batchId);
    expect(first).not.toBe(second);
  });
});
