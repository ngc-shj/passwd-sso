import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrismaTeamWebhook,
  mockPrismaTenantWebhook,
  mockWithBypassRls,
  mockLogAudit,
  mockGetMasterKeyByVersion,
  mockDecryptServerData,
  mockFetch,
} = vi.hoisted(() => ({
  mockPrismaTeamWebhook: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaTenantWebhook: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown) => fn(),
  ),
  mockLogAudit: vi.fn(),
  mockGetMasterKeyByVersion: vi.fn(() => Buffer.alloc(32)),
  mockDecryptServerData: vi.fn(() => "test-hmac-secret"),
  mockFetch: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamWebhook: mockPrismaTeamWebhook,
    tenantWebhook: mockPrismaTenantWebhook,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
  return {
    ...actual,
    logAudit: mockLogAudit,
  };
});
vi.mock("@/lib/audit-logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-logger")>("@/lib/audit-logger");
  return {
    ...actual,
  };
});
vi.mock("@/lib/crypto-server", () => ({
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
  decryptServerData: mockDecryptServerData,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Replace global fetch
vi.stubGlobal("fetch", mockFetch);

import { dispatchWebhook, dispatchTenantWebhook } from "./webhook-dispatcher";
import { createHmac } from "node:crypto";

const WEBHOOK = {
  id: "wh-1",
  teamId: "team-1",
  tenantId: "tenant-1",
  url: "https://example.com/hook",
  secretEncrypted: "encrypted",
  secretIv: "iv123456789012",
  secretAuthTag: "authtag1234567890123456789012",
  masterKeyVersion: 1,
  events: ["ENTRY_CREATE"],
  isActive: true,
  lastError: null,
  failCount: 0,
  lastDeliveredAt: null,
  lastFailedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const EVENT = {
  type: "ENTRY_CREATE",
  teamId: "team-1",
  timestamp: new Date().toISOString(),
  data: { entryId: "entry-1" },
};

const TENANT_WEBHOOK = {
  id: "twh-1",
  tenantId: "tenant-1",
  url: "https://example.com/tenant-hook",
  secretEncrypted: "encrypted",
  secretIv: "iv123456789012",
  secretAuthTag: "authtag1234567890123456789012",
  masterKeyVersion: 1,
  events: ["ADMIN_VAULT_RESET_INITIATE"],
  isActive: true,
  lastError: null,
  failCount: 0,
  lastDeliveredAt: null,
  lastFailedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TENANT_EVENT = {
  type: "ADMIN_VAULT_RESET_INITIATE",
  tenantId: "tenant-1",
  timestamp: new Date().toISOString(),
  data: { targetUserId: "user-1" },
};

describe("dispatchWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers successfully and updates lastDeliveredAt", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Signature"]).toMatch(/^sha256=/);

    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failCount: 0,
          lastError: null,
        }),
      }),
    );
  });

  it("computes correct HMAC signature", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    const payload = JSON.stringify(EVENT);
    const expectedHmac = createHmac("sha256", "test-hmac-secret")
      .update(payload, "utf8")
      .digest("hex");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Signature"]).toBe(`sha256=${expectedHmac}`);
  });

  it("retries and updates failCount on persistent failure", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhook(EVENT);

    // Advance through all retries: 1s + 5s + 25s + buffer
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failCount: 1,
        }),
      }),
    );
  });

  it("logs WEBHOOK_DELIVERY_FAILED audit event on failure", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBHOOK_DELIVERY_FAILED",
        teamId: "team-1",
      }),
    );
  });

  it("skips when no matching webhooks found", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deactivates webhook when failCount reaches 10", async () => {
    const highFailWebhook = { ...WEBHOOK, failCount: 9 };
    mockPrismaTeamWebhook.findMany.mockResolvedValue([highFailWebhook]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failCount: 10,
          isActive: false,
        }),
      }),
    );
  });

  it("delivers to multiple webhooks independently", async () => {
    const webhook2 = { ...WEBHOOK, id: "wh-2", url: "https://other.com/hook" };
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK, webhook2]);
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wh-1" },
        data: expect.objectContaining({ failCount: 0 }),
      }),
    );
    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wh-2" },
        data: expect.objectContaining({ failCount: 1 }),
      }),
    );
  });

  it("never throws even on errors", async () => {
    mockPrismaTeamWebhook.findMany.mockRejectedValue(new Error("DB error"));

    // Should not throw
    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("dispatchTenantWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers successfully and updates lastDeliveredAt, resets failCount", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/tenant-hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Signature"]).toMatch(/^sha256=/);

    expect(mockPrismaTenantWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "twh-1" },
        data: expect.objectContaining({
          failCount: 0,
          lastError: null,
        }),
      }),
    );
  });

  it("computes correct HMAC signature", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(100);

    // Payload is the sanitized event (PII keys stripped from data)
    const sanitizedEvent = {
      ...TENANT_EVENT,
      data: { targetUserId: "user-1" }, // sanitizeWebhookData is a no-op for opaque IDs
    };
    const payload = JSON.stringify(sanitizedEvent);
    const expectedHmac = createHmac("sha256", "test-hmac-secret")
      .update(payload, "utf8")
      .digest("hex");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Signature"]).toBe(`sha256=${expectedHmac}`);
  });

  it("sends User-Agent header in fetch calls", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(100);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["User-Agent"]).toBe("passwd-sso-webhook/1.0");
  });

  it("retries on failure and increments failCount", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchTenantWebhook(TENANT_EVENT);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockPrismaTenantWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failCount: 1,
        }),
      }),
    );
  });

  it("logs TENANT_WEBHOOK_DELIVERY_FAILED audit event with scope TENANT and tenantId, without teamId", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const call = mockLogAudit.mock.calls[0];
    expect(call[0]).toMatchObject({
      action: "TENANT_WEBHOOK_DELIVERY_FAILED",
      scope: "TENANT",
      tenantId: "tenant-1",
    });
    expect(call[0]).not.toHaveProperty("teamId");
  });

  it("no-op when no matching webhooks found", async () => {
    mockPrismaTenantWebhook.findMany.mockResolvedValue([]);

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPrismaTenantWebhook.update).not.toHaveBeenCalled();
  });

  it("auto-disables webhook when failCount reaches 10", async () => {
    const highFailWebhook = { ...TENANT_WEBHOOK, failCount: 9 };
    mockPrismaTenantWebhook.findMany.mockResolvedValue([highFailWebhook]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockPrismaTenantWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failCount: 10,
          isActive: false,
        }),
      }),
    );
  });

  it("delivers to multiple webhooks independently", async () => {
    const webhook2 = {
      ...TENANT_WEBHOOK,
      id: "twh-2",
      url: "https://other.com/tenant-hook",
    };
    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK, webhook2]);
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: false, status: 500 });

    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(mockPrismaTenantWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "twh-1" },
        data: expect.objectContaining({ failCount: 0 }),
      }),
    );
    expect(mockPrismaTenantWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "twh-2" },
        data: expect.objectContaining({ failCount: 1 }),
      }),
    );
  });

  it("never throws even on outer errors", async () => {
    mockPrismaTenantWebhook.findMany.mockRejectedValue(new Error("DB error"));

    // Should not throw
    dispatchTenantWebhook(TENANT_EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("strips PII keys from payload data via WEBHOOK_METADATA_BLOCKLIST", async () => {
    const eventWithPii = {
      ...TENANT_EVENT,
      data: {
        targetUserId: "user-1",
        email: "admin@example.com",
        reason: "Security incident",
        incidentRef: "INC-123",
        displayName: "Admin User",
        // crypto-level keys (from METADATA_BLOCKLIST)
        secret: "should-be-stripped",
        token: "should-be-stripped",
        // safe key that should remain
        webhookId: "twh-1",
      },
    };

    mockPrismaTenantWebhook.findMany.mockResolvedValue([TENANT_WEBHOOK]);
    mockFetch.mockResolvedValue({ ok: true });

    dispatchTenantWebhook(eventWithPii);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    const sentPayload = JSON.parse(opts.body as string);

    // PII keys must be absent
    expect(sentPayload.data).not.toHaveProperty("email");
    expect(sentPayload.data).not.toHaveProperty("reason");
    expect(sentPayload.data).not.toHaveProperty("incidentRef");
    expect(sentPayload.data).not.toHaveProperty("displayName");
    // crypto keys must also be absent
    expect(sentPayload.data).not.toHaveProperty("secret");
    expect(sentPayload.data).not.toHaveProperty("token");
    // non-PII key must be present
    expect(sentPayload.data).toHaveProperty("webhookId", "twh-1");
  });
});
