import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth, mockRequireTenantPermission, mockUserFindUnique, mockTenantUpdate,
  mockWithBypassRls, mockLogAudit, mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTenantUpdate: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
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
    user: { findUnique: mockUserFindUnique },
    tenant: { update: mockTenantUpdate },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: Function) => handler,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: { MEMBER_MANAGE: "MEMBER_MANAGE" },
}));

import { GET, PATCH } from "@/app/api/tenant/policy/route";
import { TenantAuthError } from "@/lib/tenant-auth";

describe("GET /api/tenant/policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns maxConcurrentSessions from tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUserFindUnique.mockResolvedValue({ tenant: { maxConcurrentSessions: 5, sessionIdleTimeoutMinutes: null, vaultAutoLockMinutes: null } });

    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBe(5);
  });

  it("returns null when no limit set", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUserFindUnique.mockResolvedValue({ tenant: { maxConcurrentSessions: null, sessionIdleTimeoutMinutes: null, vaultAutoLockMinutes: null } });

    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBeNull();
  });
});

describe("PATCH /api/tenant/policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", { body: {} });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", { body: {} });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 400 for invalid maxConcurrentSessions (non-integer)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 2.5 },
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 for maxConcurrentSessions < 1", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 0 },
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("successfully updates maxConcurrentSessions", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantUpdate.mockResolvedValue({});

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 3 },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBe(3);

    expect(mockTenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant1" },
        data: { maxConcurrentSessions: 3 },
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "POLICY_UPDATE",
        metadata: expect.objectContaining({ maxConcurrentSessions: 3 }),
      }),
    );
  });

  it("accepts null to remove limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantUpdate.mockResolvedValue({});

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: null },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBeNull();
  });
});
