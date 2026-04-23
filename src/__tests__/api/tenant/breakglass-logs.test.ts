import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockGrantFindFirst,
  mockMemberFindFirst,
  mockAuditLogCreate,
  mockAuditLogFindMany,
  mockWithTenantRls,
  mockExtractRequestMeta,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockGrantFindFirst: vi.fn(),
  mockMemberFindFirst: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockExtractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test-agent" }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
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
    personalLogAccessGrant: { findFirst: mockGrantFindFirst },
    tenantMember: { findFirst: mockMemberFindFirst },
    auditLog: {
      create: mockAuditLogCreate,
      findMany: mockAuditLogFindMany,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  extractRequestMeta: mockExtractRequestMeta,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: {
    AUDIT_LOG_VIEW: "tenant:auditLog:view",
  },
}));

import { GET } from "@/app/api/tenant/breakglass/[id]/logs/route";
import { MS_PER_HOUR } from "@/lib/constants/time";

const GRANT_ID = "grant-abc123";
const TARGET_USER_ID = "cmmtargetuserid00001";

function makeActiveGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    tenantId: "tenant1",
    requesterId: DEFAULT_SESSION.user.id,
    targetUserId: TARGET_USER_ID,
    revokedAt: null,
    expiresAt: new Date(Date.now() + MS_PER_HOUR), // 1 hour from now
    targetUser: {
      id: TARGET_USER_ID,
      name: "Target User",
      email: "target@example.com",
      image: null,
    },
    ...overrides,
  };
}

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    action: "AUTH_LOGIN",
    targetType: null,
    targetId: null,
    metadata: {},
    ip: "127.0.0.1",
    userAgent: "Mozilla",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    user: {
      id: TARGET_USER_ID,
      name: "Target User",
      email: "target@example.com",
      image: null,
    },
    ...overrides,
  };
}

describe("GET /api/tenant/breakglass/[id]/logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: successful audit create
    mockAuditLogCreate.mockResolvedValue({ id: "audit-1" });
    mockAuditLogFindMany.mockResolvedValue([]);
    mockMemberFindFirst.mockResolvedValue({ id: "member-1" });
  });

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${GRANT_ID}/logs`);
    const res = await GET(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 for non-existent grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockGrantFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${GRANT_ID}/logs`);
    const res = await GET(req, createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 for revoked grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockGrantFindFirst.mockResolvedValue(
      makeActiveGrant({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
    );

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${GRANT_ID}/logs`);
    const res = await GET(req, createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.details?.status).toBe("revoked");
  });

  it("returns 403 for expired grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockGrantFindFirst.mockResolvedValue(
      makeActiveGrant({ expiresAt: new Date(Date.now() - 1000) }), // expired 1s ago
    );

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${GRANT_ID}/logs`);
    const res = await GET(req, createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.details?.status).toBe("expired");
  });

  it("returns 403 when target member is deactivated", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockGrantFindFirst.mockResolvedValue(makeActiveGrant());
    mockMemberFindFirst.mockResolvedValue(null); // not found = deactivated

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${GRANT_ID}/logs`);
    const res = await GET(req, createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.details?.status).toBe("target_deactivated");
  });

  it("returns 503 when VIEW audit write fails (non-repudiation)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    // Use a unique grant ID to avoid dedup cache hits from previous tests
    const uniqueGrantId = `grant-503-${Date.now()}`;
    mockGrantFindFirst.mockResolvedValue(makeActiveGrant({ id: uniqueGrantId }));
    mockMemberFindFirst.mockResolvedValue({ id: "member-1" });
    mockAuditLogCreate.mockRejectedValue(new Error("DB error"));

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${uniqueGrantId}/logs`);
    const res = await GET(req, createParams({ id: uniqueGrantId }));
    const { status } = await parseResponse(res);
    expect(status).toBe(503);
  });

  it("returns 200 with items and grant info for active grant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    // Use a unique grant ID to avoid dedup cache
    const uniqueGrantId = `grant-200-${Date.now()}`;
    const grant = makeActiveGrant({ id: uniqueGrantId });
    mockGrantFindFirst.mockResolvedValue(grant);
    mockMemberFindFirst.mockResolvedValue({ id: "member-1" });
    mockAuditLogCreate.mockResolvedValue({ id: "audit-view-1" });
    mockAuditLogFindMany.mockResolvedValue([makeLog()]);

    const req = createRequest("GET", `http://localhost/api/tenant/breakglass/${uniqueGrantId}/logs`);
    const res = await GET(req, createParams({ id: uniqueGrantId }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.nextCursor).toBeNull();
    expect(json.grant).toMatchObject({
      grantId: uniqueGrantId,
      targetUser: expect.objectContaining({ id: TARGET_USER_ID }),
    });
    // Non-repudiation: VIEW audit was written
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PERSONAL_LOG_ACCESS_VIEW",
          targetId: TARGET_USER_ID,
        }),
      }),
    );
  });

  it("deduplicates VIEW audit: second call within 1hr does not create audit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    // Use a unique grant ID to get a fresh dedup cache slot
    const uniqueGrantId = `grant-dedup-${Date.now()}`;
    const grant = makeActiveGrant({ id: uniqueGrantId });
    mockGrantFindFirst.mockResolvedValue(grant);
    mockMemberFindFirst.mockResolvedValue({ id: "member-1" });
    mockAuditLogCreate.mockResolvedValue({ id: "audit-view-1" });
    mockAuditLogFindMany.mockResolvedValue([]);

    const makeReq = () =>
      createRequest("GET", `http://localhost/api/tenant/breakglass/${uniqueGrantId}/logs`);

    // First call — should write VIEW audit
    await GET(makeReq(), createParams({ id: uniqueGrantId }));
    const firstCallCount = mockAuditLogCreate.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Second call immediately after — dedup window active, no new audit
    await GET(makeReq(), createParams({ id: uniqueGrantId }));
    expect(mockAuditLogCreate.mock.calls.length).toBe(firstCallCount);
  });
});
