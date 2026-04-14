import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAssertOrigin,
  mockTenantWebhookFindMany,
  mockTenantWebhookCount,
  mockTenantWebhookCreate,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
  mockEncryptServerData,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockAssertOrigin: vi.fn().mockReturnValue(null),
  mockTenantWebhookFindMany: vi.fn(),
  mockTenantWebhookCount: vi.fn(),
  mockTenantWebhookCreate: vi.fn(),
  mockGetCurrentMasterKeyVersion: vi.fn().mockReturnValue(1),
  mockGetMasterKeyByVersion: vi.fn(() => Buffer.alloc(32)),
  mockEncryptServerData: vi.fn().mockReturnValue({
    ciphertext: "encrypted",
    iv: "iv123456789012",
    authTag: "authtag1234567890123456789012",
  }),
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
    tenantWebhook: {
      findMany: mockTenantWebhookFindMany,
      count: mockTenantWebhookCount,
      create: mockTenantWebhookCreate,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/crypto-server", () => ({
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
  encryptServerData: mockEncryptServerData,
}));
// node:crypto randomBytes is used for secret generation — real implementation is fine in tests

import { GET, POST } from "@/app/api/tenant/webhooks/route";
import { TenantAuthError } from "@/lib/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

/**
 * Fields returned by Prisma after applying the `select` in handleGET.
 * Secret fields are intentionally absent — Prisma's select never fetches them.
 */
const makeWebhookSelectResult = (overrides: Record<string, unknown> = {}) => ({
  id: "wh-1",
  url: "https://example.com/hook",
  events: ["ADMIN_VAULT_RESET_INITIATE"],
  isActive: true,
  failCount: 0,
  lastDeliveredAt: null,
  lastFailedAt: null,
  lastError: null,
  createdAt: new Date(),
  ...overrides,
});

describe("GET /api/tenant/webhooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of webhooks", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookFindMany.mockResolvedValue([makeWebhookSelectResult()]);

    const req = createRequest("GET", "http://localhost/api/tenant/webhooks");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json.webhooks)).toBe(true);
    expect(json.webhooks).toHaveLength(1);
    expect(json.webhooks[0].id).toBe("wh-1");
  });

  it("excludes secret fields from response (Prisma select omits them)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // The route uses a Prisma select that never fetches secret fields.
    // The mock returns only what Prisma would actually select.
    mockTenantWebhookFindMany.mockResolvedValue([makeWebhookSelectResult()]);

    const req = createRequest("GET", "http://localhost/api/tenant/webhooks");
    const res = await GET(req);
    const { json } = await parseResponse(res);

    // Verify the Prisma query was called with a select that excludes secret fields
    expect(mockTenantWebhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          secretEncrypted: expect.anything(),
          secretIv: expect.anything(),
          secretAuthTag: expect.anything(),
          masterKeyVersion: expect.anything(),
        }),
      }),
    );

    // And verify the response itself does not expose these fields
    const webhook = json.webhooks[0];
    expect(webhook).not.toHaveProperty("secretEncrypted");
    expect(webhook).not.toHaveProperty("secretIv");
    expect(webhook).not.toHaveProperty("secretAuthTag");
    expect(webhook).not.toHaveProperty("masterKeyVersion");
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", "http://localhost/api/tenant/webhooks");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/webhooks");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});

describe("POST /api/tenant/webhooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates webhook successfully and returns secret", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookCount.mockResolvedValue(0);
    const created = {
      id: "wh-new",
      url: "https://example.com/hook",
      events: ["ADMIN_VAULT_RESET_INITIATE"],
      isActive: true,
      createdAt: new Date(),
      tenantId: "tenant-1",
      secretEncrypted: "encrypted",
      secretIv: "iv123456789012",
      secretAuthTag: "authtag1234567890123456789012",
      masterKeyVersion: 1,
      failCount: 0,
      lastDeliveredAt: null,
      lastFailedAt: null,
      lastError: null,
      updatedAt: new Date(),
    };
    mockTenantWebhookCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.webhook.id).toBe("wh-new");
    expect(typeof json.secret).toBe("string");
    expect(json.secret.length).toBeGreaterThan(0);
    // secret fields must not appear in the webhook sub-object
    expect(json.webhook).not.toHaveProperty("secretEncrypted");
    expect(json.webhook).not.toHaveProperty("secretIv");
    expect(json.webhook).not.toHaveProperty("secretAuthTag");
    expect(json.webhook).not.toHaveProperty("masterKeyVersion");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_WEBHOOK_CREATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("enforces 5-webhook-per-tenant limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockTenantWebhookCount.mockResolvedValue(5);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.details).toBeDefined();
  });

  it("rejects cross-scope events (e.g. ENTRY_CREATE)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ENTRY_CREATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("rejects self-referential events (e.g. TENANT_WEBHOOK_CREATE)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["TENANT_WEBHOOK_CREATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("rejects HTTP URLs (HTTPS only)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "http://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("rejects private IP addresses", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://localhost/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("CSRF: assertOrigin blocks request with missing/bad origin", async () => {
    mockAssertOrigin.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "INVALID_ORIGIN" }), { status: 403 }),
    );

    const req = createRequest("POST", "http://localhost/api/tenant/webhooks", {
      body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockAuth).not.toHaveBeenCalled();
  });
});
