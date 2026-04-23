import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockGrantFindFirst,
  mockTenantMemberFindFirst,
  mockAuditLogCreate,
  mockAuditLogFindMany,
  mockUserFindMany,
  TenantAuthError,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn(async (_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockGrantFindFirst: vi.fn(),
    mockTenantMemberFindFirst: vi.fn(),
    mockAuditLogCreate: vi.fn(),
    mockAuditLogFindMany: vi.fn(),
    mockUserFindMany: vi.fn().mockResolvedValue([]),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    personalLogAccessGrant: {
      findFirst: mockGrantFindFirst,
    },
    tenantMember: {
      findFirst: mockTenantMemberFindFirst,
    },
    auditLog: {
      create: mockAuditLogCreate,
      findMany: mockAuditLogFindMany,
    },
    user: {
      findMany: mockUserFindMany,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      $executeRaw: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test-agent" }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "./route";
import { MS_PER_DAY } from "@/lib/constants/time";

const TENANT_ID = "tenant-1";
const ACTOR_USER_ID = "test-user-id";
const TARGET_USER_ID = "user-target-99";

const ACTOR = {
  id: "membership-1",
  tenantId: TENANT_ID,
  userId: ACTOR_USER_ID,
  role: "OWNER",
};

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + MS_PER_DAY);
const PAST = new Date(NOW.getTime() - MS_PER_DAY);

// Each test that reaches the VIEW audit path needs a unique grantId to bypass
// the in-memory per-process dedup cache (viewAuditCache) in the route module.
let grantIdCounter = 0;
function nextGrantId(): string {
  return `grant-unique-${++grantIdCounter}`;
}

const makeGrant = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  tenantId: TENANT_ID,
  requesterId: ACTOR_USER_ID,
  targetUserId: TARGET_USER_ID,
  reason: "Security incident investigation",
  incidentRef: "INC-001",
  expiresAt: FUTURE,
  revokedAt: null,
  createdAt: NOW,
  targetUser: {
    id: TARGET_USER_ID,
    name: "Target User",
    email: "target@example.com",
    image: null,
  },
  ...overrides,
});

const makeLog = (overrides: Record<string, unknown> = {}) => ({
  id: "log-1",
  userId: TARGET_USER_ID,
  action: "ENTRY_CREATE",
  targetType: "PasswordEntry",
  targetId: "entry-1",
  metadata: {},
  ip: "10.0.0.1",
  userAgent: "Mozilla/5.0",
  createdAt: NOW,
  ...overrides,
});

// Fixed grant IDs for tests that never reach the VIEW audit path (fail before it)
const FIXED_GRANT_ID = "grant-fixed-auth-check";

const makeReq = (grantId: string, searchParams: Record<string, string> = {}) =>
  createRequest("GET", `http://localhost/api/tenant/breakglass/${grantId}/logs`, {
    searchParams,
  });

describe("GET /api/tenant/breakglass/[id]/logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue({ id: "member-target" });
    mockAuditLogCreate.mockResolvedValue({ id: "audit-view-1" });
    mockAuditLogFindMany.mockResolvedValue([makeLog()]);
    mockUserFindMany.mockResolvedValue([
      { id: TARGET_USER_ID, name: "Target User", email: "target@example.com", image: null },
    ]);
  });

  // Tests that fail before reaching the VIEW audit path use a fixed grantId
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeReq(FIXED_GRANT_ID), createParams({ id: FIXED_GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking AUDIT_LOG_VIEW permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await GET(makeReq(FIXED_GRANT_ID), createParams({ id: FIXED_GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("db crash"));
    await expect(
      GET(makeReq(FIXED_GRANT_ID), createParams({ id: FIXED_GRANT_ID })),
    ).rejects.toThrow("db crash");
  });

  it("returns 404 when grant does not exist or does not belong to caller", async () => {
    mockGrantFindFirst.mockResolvedValue(null);
    const res = await GET(makeReq(FIXED_GRANT_ID), createParams({ id: FIXED_GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when grant is revoked", async () => {
    const grantId = FIXED_GRANT_ID + "-revoked";
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId, { revokedAt: PAST }));
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(json.details.status).toBe("revoked");
  });

  it("returns 403 when grant has expired", async () => {
    const grantId = FIXED_GRANT_ID + "-expired";
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId, { expiresAt: PAST }));
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(json.details.status).toBe("expired");
  });

  // Tests that reach the VIEW audit path need unique grantIds each run
  it("returns 403 when target user is deactivated (not an active tenant member)", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(json.details.status).toBe("target_deactivated");
  });

  it("returns 503 when audit log VIEW creation fails (non-repudiation requirement)", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    mockAuditLogCreate.mockRejectedValue(new Error("db write error"));
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 200 with log items and grant metadata on success", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      id: "log-1",
      action: "ENTRY_CREATE",
      targetType: "PasswordEntry",
      targetId: "entry-1",
      user: { id: TARGET_USER_ID },
    });
    expect(json.grant).toMatchObject({
      grantId,
      targetUser: { id: TARGET_USER_ID },
    });
    expect(json.nextCursor).toBeNull();
  });

  it("returns nextCursor when there are more results than limit", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    // Simulate 51 items returned when limit=50 (take: limit+1 = 51)
    const logs = Array.from({ length: 51 }, (_, i) => makeLog({ id: `log-${i + 1}` }));
    mockAuditLogFindMany.mockResolvedValue(logs);
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items).toHaveLength(50);
    expect(json.nextCursor).toBe("log-50");
  });

  it("calls requireTenantPermission with AUDIT_LOG_VIEW permission", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    await GET(makeReq(grantId), createParams({ id: grantId }));
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:auditLog:view",
    );
  });

  it("records a VIEW audit log when accessing for the first time", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    await GET(makeReq(grantId), createParams({ id: grantId }));
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PERSONAL_LOG_ACCESS_VIEW",
          userId: ACTOR_USER_ID,
          tenantId: TENANT_ID,
          targetType: "User",
          targetId: TARGET_USER_ID,
        }),
      }),
    );
  });

  it("returns 400 for an invalid action filter", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    const res = await GET(
      makeReq(grantId, { actions: "NOT_A_REAL_ACTION" }),
      createParams({ id: grantId }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("applies cursor pagination when cursor param is provided", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    mockAuditLogFindMany.mockResolvedValue([makeLog({ id: "log-next" })]);
    const res = await GET(
      makeReq(grantId, { cursor: "550e8400-e29b-41d4-a716-446655440000", limit: "10" }),
      createParams({ id: grantId }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items[0].id).toBe("log-next");
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "550e8400-e29b-41d4-a716-446655440000" },
        skip: 1,
      }),
    );
  });

  it("returns empty items when no logs exist", async () => {
    const grantId = nextGrantId();
    mockGrantFindFirst.mockResolvedValue(makeGrant(grantId));
    mockAuditLogFindMany.mockResolvedValue([]);
    const res = await GET(makeReq(grantId), createParams({ id: grantId }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items).toHaveLength(0);
    expect(json.nextCursor).toBeNull();
  });
});
