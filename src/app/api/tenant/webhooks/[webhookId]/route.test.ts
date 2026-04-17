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
  mockTenantWebhookFindFirst,
  mockTenantWebhookDelete,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockTenantWebhookFindFirst: vi.fn(),
  mockTenantWebhookDelete: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
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
    tenantWebhook: {
      findFirst: mockTenantWebhookFindFirst,
      delete: mockTenantWebhookDelete,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { DELETE } from "@/app/api/tenant/webhooks/[webhookId]/route";
import { TenantAuthError } from "@/lib/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const WEBHOOK_ID = "wh-1";

const makeWebhook = (overrides: Record<string, unknown> = {}) => ({
  id: WEBHOOK_ID,
  url: "https://example.com/hook",
  tenantId: "tenant-1",
  ...overrides,
});

describe("DELETE /api/tenant/webhooks/[webhookId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes webhook successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookFindFirst.mockResolvedValue(makeWebhook());
    mockTenantWebhookDelete.mockResolvedValue(makeWebhook());

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/${WEBHOOK_ID}`);
    const res = await DELETE(req, createParams({ webhookId: WEBHOOK_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTenantWebhookDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: WEBHOOK_ID }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_WEBHOOK_DELETE",
        tenantId: "tenant-1",
        scope: "TENANT",
      }),
    );
  });

  it("returns 404 for non-existent webhook", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/nonexistent`);
    const res = await DELETE(req, createParams({ webhookId: "nonexistent" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/${WEBHOOK_ID}`);
    const res = await DELETE(req, createParams({ webhookId: WEBHOOK_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/${WEBHOOK_ID}`);
    const res = await DELETE(req, createParams({ webhookId: WEBHOOK_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("rethrows unexpected Prisma errors from delete", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookFindFirst.mockResolvedValue(makeWebhook());
    mockTenantWebhookDelete.mockRejectedValue(new Error("DB connection lost"));

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/${WEBHOOK_ID}`);

    await expect(
      DELETE(req, createParams({ webhookId: WEBHOOK_ID })),
    ).rejects.toThrow("DB connection lost");
  });

  it("rethrows unexpected Prisma errors from findFirst", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookFindFirst.mockRejectedValue(new Error("DB read timeout"));

    const req = createRequest("DELETE", `http://localhost/api/tenant/webhooks/${WEBHOOK_ID}`);

    await expect(
      DELETE(req, createParams({ webhookId: WEBHOOK_ID })),
    ).rejects.toThrow("DB read timeout");
  });
});
