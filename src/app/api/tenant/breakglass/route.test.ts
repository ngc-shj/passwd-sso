import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockGrantFindMany,
  mockGrantFindFirst,
  mockGrantCreate,
  mockTenantMemberFindFirst,
  mockCreateNotification,
  mockDispatchTenantWebhook,
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
    mockLogAudit: vi.fn(),
    mockAssertOrigin: vi.fn().mockReturnValue(null),
    mockRateLimiterCheck: vi.fn(),
    mockGrantFindMany: vi.fn(),
    mockGrantFindFirst: vi.fn(),
    mockGrantCreate: vi.fn(),
    mockTenantMemberFindFirst: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockDispatchTenantWebhook: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    personalLogAccessGrant: {
      findMany: mockGrantFindMany,
      findFirst: mockGrantFindFirst,
      create: mockGrantCreate,
    },
    tenantMember: {
      findFirst: mockTenantMemberFindFirst,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test-agent" }),
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck })),
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { GET, POST } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR_USER_ID = "test-user-id";
const TARGET_USER_ID = "00000000-0000-4000-a000-000000000030"; // valid uuid v4
const GRANT_ID = "grant-abc-123";

const ACTOR = {
  id: "membership-1",
  tenantId: TENANT_ID,
  userId: ACTOR_USER_ID,
  role: "OWNER",
};

const TARGET_MEMBER = {
  id: "member-target",
  tenantId: TENANT_ID,
  userId: TARGET_USER_ID,
  deactivatedAt: null,
  user: {
    id: TARGET_USER_ID,
    name: "Target User",
    email: "target@example.com",
    image: null,
  },
};

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  tenantId: TENANT_ID,
  requesterId: ACTOR_USER_ID,
  targetUserId: TARGET_USER_ID,
  reason: "Security incident investigation",
  incidentRef: "INC-001",
  expiresAt: FUTURE,
  revokedAt: null,
  createdAt: NOW,
  requester: {
    id: ACTOR_USER_ID,
    name: "Test User",
    email: "user@example.com",
    image: null,
  },
  targetUser: {
    id: TARGET_USER_ID,
    name: "Target User",
    email: "target@example.com",
    image: null,
  },
  ...overrides,
});

describe("GET /api/tenant/breakglass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockGrantFindMany.mockResolvedValue([makeGrant()]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking AUDIT_LOG_VIEW permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected db error"));
    await expect(
      GET(createRequest("GET", "http://localhost/api/tenant/breakglass")),
    ).rejects.toThrow("unexpected db error");
  });

  it("returns list of grants with status derived correctly for active grant", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      id: GRANT_ID,
      tenantId: TENANT_ID,
      requesterId: ACTOR_USER_ID,
      targetUserId: TARGET_USER_ID,
      reason: "Security incident investigation",
      incidentRef: "INC-001",
      status: "active",
      requester: { id: ACTOR_USER_ID },
      targetUser: { id: TARGET_USER_ID },
    });
  });

  it("derives expired status when expiresAt is in the past", async () => {
    const pastDate = new Date(Date.now() - 1000);
    mockGrantFindMany.mockResolvedValue([makeGrant({ expiresAt: pastDate })]);
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items[0].status).toBe("expired");
  });

  it("derives revoked status when revokedAt is set", async () => {
    mockGrantFindMany.mockResolvedValue([makeGrant({ revokedAt: NOW })]);
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items[0].status).toBe("revoked");
  });

  it("returns empty items array when no grants exist", async () => {
    mockGrantFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items).toHaveLength(0);
  });

  it("calls requireTenantPermission with AUDIT_LOG_VIEW permission", async () => {
    await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:auditLog:view",
    );
  });

  it("passes tenantId to withTenantRls", async () => {
    await GET(createRequest("GET", "http://localhost/api/tenant/breakglass"));
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });
});

describe("POST /api/tenant/breakglass", () => {
  const validBody = {
    targetUserId: TARGET_USER_ID,
    reason: "Security incident investigation INC-001",
    incidentRef: "INC-001",
  };

  const createdGrant = {
    id: GRANT_ID,
    tenantId: TENANT_ID,
    requesterId: ACTOR_USER_ID,
    targetUserId: TARGET_USER_ID,
    reason: validBody.reason,
    incidentRef: "INC-001",
    expiresAt: FUTURE,
    revokedAt: null,
    createdAt: NOW,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    // withTenantRls: first call finds member, second returns no duplicate, third creates grant
    mockWithTenantRls.mockImplementation(async (_p: unknown, _t: unknown, fn: () => unknown) => fn());
    mockTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockGrantFindFirst.mockResolvedValue(null); // no duplicate
    mockGrantCreate.mockResolvedValue(createdGrant);
  });

  it("returns 403 when CSRF assertOrigin fails", async () => {
    mockAssertOrigin.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "INVALID_ORIGIN" }), { status: 403 }),
    );
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking BREAKGLASS_REQUEST permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("db crash"));
    await expect(
      POST(
        createRequest("POST", "http://localhost/api/tenant/breakglass", {
          body: validBody,
          headers: { origin: "http://localhost" },
        }),
      ),
    ).rejects.toThrow("db crash");
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/tenant/breakglass",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: "not-json{{{",
      } as ConstructorParameters<typeof import("next/server").NextRequest>[1],
    );
    const res = await POST(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when targetUserId is missing", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: { reason: "Some reason for investigation", incidentRef: "INC-001" },
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("returns 400 when reason is too short", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: { targetUserId: TARGET_USER_ID, reason: "x" },
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("returns 400 when requester tries to access own logs", async () => {
    // Use valid UUID for session to pass Zod schema, then trigger self-access guard
    const selfUuid = "00000000-0000-4000-a000-000000000099";
    mockAuth.mockResolvedValue({ user: { id: selfUuid } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: { targetUserId: selfUuid, reason: "Trying to access own logs here", incidentRef: "INC-001" },
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details.properties.targetUserId.errors).toContain(
      "Cannot request access to your own logs",
    );
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 3600000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 403 when target user is not a tenant member", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 409 when an active grant already exists for the same target", async () => {
    mockGrantFindFirst.mockResolvedValue({ id: "existing-grant" });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 201 with grant data on success", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json).toMatchObject({
      id: GRANT_ID,
      tenantId: TENANT_ID,
      requesterId: ACTOR_USER_ID,
      targetUserId: TARGET_USER_ID,
      reason: validBody.reason,
      incidentRef: "INC-001",
      status: "active",
    });
  });

  it("calls requireTenantPermission with BREAKGLASS_REQUEST permission", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:breakglass:request",
    );
  });

  it("fires audit log on success", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PERSONAL_LOG_ACCESS_REQUEST",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
      }),
    );
  });

  it("fires notification to target user on success", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: validBody,
        headers: { origin: "http://localhost" },
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_USER_ID,
        tenantId: TENANT_ID,
        type: "PERSONAL_LOG_ACCESSED",
      }),
    );
  });

  it("omits incidentRef from grant when not provided", async () => {
    const noRef = { targetUserId: TARGET_USER_ID, reason: "Urgent security incident response" };
    mockGrantCreate.mockResolvedValue({ ...createdGrant, incidentRef: null });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/breakglass", {
        body: noRef,
        headers: { origin: "http://localhost" },
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.incidentRef).toBeNull();
  });
});
