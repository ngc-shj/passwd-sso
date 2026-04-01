import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse, createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockAssertOrigin,
  mockCreateNotification,
  mockTenantMemberFindFirst,
  mockPersonalLogAccessGrantFindFirst,
  mockPersonalLogAccessGrantCreate,
  mockPersonalLogAccessGrantFindMany,
  mockPersonalLogAccessGrantUpdateMany,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAssertOrigin: vi.fn().mockReturnValue(null),
  mockCreateNotification: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockPersonalLogAccessGrantFindFirst: vi.fn(),
  mockPersonalLogAccessGrantCreate: vi.fn(),
  mockPersonalLogAccessGrantFindMany: vi.fn(),
  mockPersonalLogAccessGrantUpdateMany: vi.fn(),
  mockDispatchTenantWebhook: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockTenantMemberFindFirst },
    personalLogAccessGrant: {
      findFirst: mockPersonalLogAccessGrantFindFirst,
      create: mockPersonalLogAccessGrantCreate,
      findMany: mockPersonalLogAccessGrantFindMany,
      updateMany: mockPersonalLogAccessGrantUpdateMany,
    },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: {
    BREAKGLASS_REQUEST: "BREAKGLASS_REQUEST",
    AUDIT_LOG_VIEW: "AUDIT_LOG_VIEW",
  },
}));
vi.mock("@/lib/constants/notification", () => ({
  NOTIFICATION_TYPE: {
    PERSONAL_LOG_ACCESSED: "PERSONAL_LOG_ACCESSED",
  },
}));

import { POST, GET } from "@/app/api/tenant/breakglass/route";
import { DELETE } from "@/app/api/tenant/breakglass/[id]/route";
import { TenantAuthError } from "@/lib/tenant-auth";
import { GRANT_STATUS } from "@/lib/constants/breakglass";

const ACTOR = { tenantId: "tenant1", role: "ADMIN" };
const TARGET_USER_ID = "00000000-0000-4000-a000-000000000001";
const GRANT_ID = "grant-id-123";

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  tenantId: "tenant1",
  requesterId: DEFAULT_SESSION.user.id,
  targetUserId: TARGET_USER_ID,
  reason: "Investigating incident ABC-123 per security policy",
  incidentRef: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  revokedAt: null,
  createdAt: new Date(),
  ...overrides,
});

const makeMember = () => ({
  userId: TARGET_USER_ID,
  tenantId: "tenant1",
  deactivatedAt: null,
  user: { id: TARGET_USER_ID, name: "Target User", email: "target@example.com", image: null },
});

describe("POST /api/tenant/breakglass", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 without BREAKGLASS_REQUEST permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 when targetUserId equals session userId (self-access)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: DEFAULT_SESSION.user.id, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 when reason is less than 10 characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "short" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 409 when duplicate active grant exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue(makeMember());
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue({ id: "existing-grant" });
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(409);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 3600000 });
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 201 with valid input and creates grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue(makeMember());
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(null);
    const grant = makeGrant();
    mockPersonalLogAccessGrantCreate.mockResolvedValue(grant);

    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe(GRANT_ID);
    expect(json.status).toBe(GRANT_STATUS.ACTIVE);
    expect(json.targetUserId).toBe(TARGET_USER_ID);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining("PERSONAL_LOG_ACCESS"),
        tenantId: "tenant1",
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET_USER_ID }),
    );
  });

  it("returns 403 when target user is deactivated (not an active member)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // findFirst returns null = no active member found (deactivatedAt is filtered)
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "Valid reason for incident" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("does not dispatch tenant webhook when request fails validation", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // Reason too short — fails schema validation
    const req = createRequest("POST", "http://localhost/api/tenant/breakglass", {
      body: { targetUserId: TARGET_USER_ID, reason: "short" },
    });
    await POST(req);

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });
});

describe("GET /api/tenant/breakglass", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/breakglass");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 200 with items array", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const grant = makeGrant();
    mockPersonalLogAccessGrantFindMany.mockResolvedValue([
      {
        ...grant,
        requester: { id: DEFAULT_SESSION.user.id, name: "Test User", email: "user@example.com", image: null },
        targetUser: { id: TARGET_USER_ID, name: "Target User", email: "target@example.com", image: null },
      },
    ]);
    const req = createRequest("GET", "http://localhost/api/tenant/breakglass");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe(GRANT_ID);
  });

  it("computes status as active for non-expired, non-revoked grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const activeGrant = makeGrant({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
    });
    mockPersonalLogAccessGrantFindMany.mockResolvedValue([
      { ...activeGrant, requester: null, targetUser: null },
    ]);
    const req = createRequest("GET", "http://localhost/api/tenant/breakglass");
    const res = await GET(req);
    const { json } = await parseResponse(res);
    expect(json.items[0].status).toBe(GRANT_STATUS.ACTIVE);
  });

  it("computes status as expired for past-expiresAt grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const expiredGrant = makeGrant({
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      revokedAt: null,
    });
    mockPersonalLogAccessGrantFindMany.mockResolvedValue([
      { ...expiredGrant, requester: null, targetUser: null },
    ]);
    const req = createRequest("GET", "http://localhost/api/tenant/breakglass");
    const res = await GET(req);
    const { json } = await parseResponse(res);
    expect(json.items[0].status).toBe(GRANT_STATUS.EXPIRED);
  });

  it("computes status as revoked for grant with revokedAt set", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const revokedGrant = makeGrant({
      revokedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    mockPersonalLogAccessGrantFindMany.mockResolvedValue([
      { ...revokedGrant, requester: null, targetUser: null },
    ]);
    const req = createRequest("GET", "http://localhost/api/tenant/breakglass");
    const res = await GET(req);
    const { json } = await parseResponse(res);
    expect(json.items[0].status).toBe(GRANT_STATUS.REVOKED);
  });
});

describe("DELETE /api/tenant/breakglass/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 for non-existent grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(null);
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when not requester and not OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1", role: "MEMBER" });
    // Grant belongs to a different requester
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(
      makeGrant({ requesterId: "other-user-id" }),
    );
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 409 when grant is already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(
      makeGrant({ revokedAt: new Date(Date.now() - 10000) }),
    );
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(409);
  });

  it("returns 200 and sets revokedAt when requester revokes own grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(makeGrant());
    mockPersonalLogAccessGrantUpdateMany.mockResolvedValue({ count: 1 });
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockPersonalLogAccessGrantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: GRANT_ID, revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining("PERSONAL_LOG_ACCESS"),
        tenantId: "tenant1",
      }),
    );
  });

  it("returns 200 when OWNER revokes a grant they did not create", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1", role: "OWNER" });
    // Grant belongs to different requester
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(
      makeGrant({ requesterId: "other-user-id" }),
    );
    mockPersonalLogAccessGrantUpdateMany.mockResolvedValue({ count: 1 });
    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    const res = await DELETE(req, createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("does not dispatch tenant webhook when grant is already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPersonalLogAccessGrantFindFirst.mockResolvedValue(
      makeGrant({ revokedAt: new Date(Date.now() - 10000) }),
    );

    const req = createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`);
    await DELETE(req, createParams({ id: GRANT_ID }));

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });
});
