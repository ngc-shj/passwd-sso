import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockServiceAccountFindUnique,
  mockServiceAccountUpdate,
  mockServiceAccountTokenUpdateMany,
  mockPrismaArrayTransaction,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockServiceAccountUpdate: vi.fn(),
  mockServiceAccountTokenUpdateMany: vi.fn(),
  mockPrismaArrayTransaction: vi.fn().mockResolvedValue([{ count: 1 }, {}]),
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
    serviceAccount: {
      findUnique: mockServiceAccountFindUnique,
      update: mockServiceAccountUpdate,
    },
    serviceAccountToken: {
      updateMany: mockServiceAccountTokenUpdateMany,
    },
    $transaction: mockPrismaArrayTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { GET, PUT, DELETE } from "@/app/api/tenant/service-accounts/[id]/route";
import { TenantAuthError } from "@/lib/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const SA_ID = "sa-00000001";

const makeSA = (overrides: Record<string, unknown> = {}) => ({
  id: SA_ID,
  name: "ci-bot",
  description: "CI pipeline bot",
  identityType: "SERVICE_ACCOUNT",
  isActive: true,
  teamId: null,
  tenantId: "tenant-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: { id: DEFAULT_SESSION.user.id, name: "Test User", email: "user@example.com" },
  _count: { tokens: 2 },
  ...overrides,
});

describe("GET /api/tenant/service-accounts/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns single service account", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(makeSA());

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe(SA_ID);
    expect(json.name).toBe("ci-bot");
  });

  it("returns 404 when service account not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 404 when service account belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(makeSA({ tenantId: "other-tenant" }));

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});

describe("PUT /api/tenant/service-accounts/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates a service account successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // findUnique for existence check
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    const updated = makeSA({ name: "ci-bot-v2", description: "Updated bot" });
    mockServiceAccountUpdate.mockResolvedValue(updated);

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
      { body: { name: "ci-bot-v2", description: "Updated bot" } },
    );
    const res = await PUT(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.name).toBe("ci-bot-v2");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_UPDATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 404 when service account not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
      { body: { name: "ci-bot-v2" } },
    );
    const res = await PUT(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 409 on name conflict (P2002)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });

    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    mockServiceAccountUpdate.mockRejectedValue(p2002);

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
      { body: { name: "duplicate-name" } },
    );
    const res = await PUT(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_NAME_CONFLICT");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
      { body: { name: "ci-bot-v2" } },
    );
    const res = await PUT(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest(
      "PUT",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
      { body: { name: "ci-bot-v2" } },
    );
    const res = await PUT(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});

describe("DELETE /api/tenant/service-accounts/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("soft-deletes a service account and revokes its tokens", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockPrismaArrayTransaction.mockResolvedValue([{ count: 2 }, {}]);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_DELETE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 404 when service account not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});
