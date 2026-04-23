import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAccessRequestFindUnique,
  mockAccessRequestUpdateMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockAccessRequestFindUnique: vi.fn(),
  mockAccessRequestUpdateMany: vi.fn(),
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
    accessRequest: {
      findUnique: mockAccessRequestFindUnique,
      updateMany: mockAccessRequestUpdateMany,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { POST } from "@/app/api/tenant/access-requests/[id]/deny/route";
import { TenantAuthError } from "@/lib/auth/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const REQUEST_ID = "req-00000001";
const SA_ID = "00000000-0000-4000-a000-000000000001";

const makeAccessRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  tenantId: "tenant-1",
  serviceAccountId: SA_ID,
  ...overrides,
});

describe("POST /api/tenant/access-requests/[id]/deny", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies pending request and returns success", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockAccessRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: REQUEST_ID, status: "PENDING" }),
        data: expect.objectContaining({ status: "DENIED" }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_REQUEST_DENY",
        tenantId: "tenant-1",
      }),
    );
  });

  it("sets approvedById and approvedAt on deny", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    await POST(req, createParams({ id: REQUEST_ID }));

    expect(mockAccessRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DENIED",
          approvedById: DEFAULT_SESSION.user.id,
          approvedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("returns 409 when request is already processed (optimistic lock)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 0 }); // already processed

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 404 when access request does not exist", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 404 when request belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ tenantId: "other-tenant" }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});
