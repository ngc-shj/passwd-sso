import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse, createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockTenantMemberFindFirst,
  mockTenantMemberUpdate,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockTenantMemberUpdate: vi.fn(),
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
    tenantMember: {
      findFirst: mockTenantMemberFindFirst,
      update: mockTenantMemberUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: { MEMBER_MANAGE: "MEMBER_MANAGE" },
}));
vi.mock("@/lib/api-response", () => ({
  unauthorized: () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }),
  errorResponse: (msg: string, status: number, extra?: unknown) =>
    new Response(JSON.stringify({ error: msg, ...extra }), { status }),
  notFound: () => new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 }),
  forbidden: () => new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
}));

import { PUT } from "@/app/api/tenant/members/[userId]/route";

const OWNER_ACTOR = { tenantId: "tenant-xyz", role: "OWNER" };
const ADMIN_ACTOR = { tenantId: "tenant-xyz", role: "ADMIN" };
const TARGET_USER_ID = "target-member-user-id-001";
const MEMBER_ID = "member-record-id-001";

const makeMember = (overrides: Record<string, unknown> = {}) => ({
  id: MEMBER_ID,
  userId: TARGET_USER_ID,
  tenantId: "tenant-xyz",
  role: "ADMIN",
  scimManaged: false,
  deactivatedAt: null,
  user: {
    id: TARGET_USER_ID,
    name: "Target User",
    email: "target@example.com",
    image: null,
  },
  ...overrides,
});

const makeUpdatedMember = (role: string) => ({
  ...makeMember({ role }),
});

describe("PUT /api/tenant/members/[userId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    const res = await PUT(req, createParams({ userId: TARGET_USER_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when actor is not OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ADMIN_ACTOR);

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    const res = await PUT(req, createParams({ userId: TARGET_USER_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 when actor tries to change own role", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(OWNER_ACTOR);

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/members/${DEFAULT_SESSION.user.id}`,
      { body: { role: "ADMIN" } },
    );
    const res = await PUT(req, createParams({ userId: DEFAULT_SESSION.user.id }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 404 when target member is not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(OWNER_ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    const res = await PUT(req, createParams({ userId: TARGET_USER_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 409 when member is SCIM managed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(OWNER_ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue(makeMember({ scimManaged: true }));

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    const res = await PUT(req, createParams({ userId: TARGET_USER_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(409);
  });

  it("returns 200 on successful role change", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(OWNER_ACTOR);
    // First findFirst call: target member lookup
    mockTenantMemberFindFirst.mockResolvedValue(makeMember({ role: "MEMBER" }));
    mockTenantMemberUpdate.mockResolvedValue(makeUpdatedMember("ADMIN"));

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    const res = await PUT(req, createParams({ userId: TARGET_USER_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.role).toBe("ADMIN");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_ROLE_UPDATE",
        tenantId: "tenant-xyz",
      }),
    );
  });

  it("does not dispatch tenant webhook when target member is not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(OWNER_ACTOR);
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    await PUT(req, createParams({ userId: TARGET_USER_ID }));

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });

  it("does not dispatch tenant webhook when actor is not OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ADMIN_ACTOR);

    const req = createRequest("PUT", `http://localhost/api/tenant/members/${TARGET_USER_ID}`, {
      body: { role: "ADMIN" },
    });
    await PUT(req, createParams({ userId: TARGET_USER_ID }));

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });
});
