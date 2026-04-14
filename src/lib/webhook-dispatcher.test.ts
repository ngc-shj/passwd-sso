import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrismaTeamWebhook,
  mockPrismaTenantWebhook,
  mockWithBypassRls,
  mockLogAudit,
  mockGetMasterKeyByVersion,
  mockDecryptServerData,
  mockFetch,
  mockResolve4,
  mockResolve6,
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
  mockResolve4: vi.fn(async () => ["93.184.216.34"]),
  mockResolve6: vi.fn(async () => []),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamWebhook: mockPrismaTeamWebhook,
    tenantWebhook: mockPrismaTenantWebhook,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
  return {
    ...actual,
    logAuditAsync: mockLogAudit,
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

vi.mock("node:dns/promises", () => ({
  resolve4: mockResolve4,
  resolve6: mockResolve6,
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
    // Advance through all retries in steps to allow microtasks to settle
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // Use vi.waitFor to poll for the assertion, avoiding flaky real-timer sleeps
    await vi.waitFor(() => {
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "WEBHOOK_DELIVERY_FAILED",
          teamId: "team-1",
        }),
      );
    });
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

  it("dispatches multiple webhooks in parallel — all fetch calls initiated before any resolve", async () => {
    // Track the order in which fetch calls are initiated vs resolved
    const callOrder: string[] = [];
    const resolvers: Array<() => void> = [];

    const makeWebhook = (id: string) => ({ ...WEBHOOK, id, url: `https://example.com/hook-${id}` });
    const webhooks = ["wh-a", "wh-b", "wh-c"].map(makeWebhook);
    mockPrismaTeamWebhook.findMany.mockResolvedValue(webhooks);

    mockFetch.mockImplementation((url: string) => {
      callOrder.push(`call:${url}`);
      return new Promise<{ ok: boolean }>((resolve) => {
        resolvers.push(() => {
          callOrder.push(`resolve:${url}`);
          resolve({ ok: true });
        });
      });
    });

    dispatchWebhook(EVENT);
    // Let the async logic start (findMany resolves, fetch calls are made)
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // All 3 fetches should have been called before any resolve
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Confirm: all calls happened before any resolver ran
    const callCount = callOrder.filter((e) => e.startsWith("call:")).length;
    const resolveCount = callOrder.filter((e) => e.startsWith("resolve:")).length;
    expect(callCount).toBe(3);
    expect(resolveCount).toBe(0); // no resolves yet — they are pending in parallel

    // Resolve all and let everything settle
    resolvers.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(100);
  });

  it("respects concurrency limit of 5 — 10 webhooks processed in two chunks", async () => {
    // Each fetch is a Promise that we control manually.
    // We hold the first chunk's resolvers until we can confirm only 5 calls were made,
    // then release them so the second chunk can start.
    const firstChunkResolvers: Array<() => void> = [];
    let fetchCallCount = 0;

    const makeWebhook = (i: number) => ({
      ...WEBHOOK,
      id: `wh-${i}`,
      url: `https://example.com/hook-${i}`,
    });
    const webhooks = Array.from({ length: 10 }, (_, i) => makeWebhook(i));
    mockPrismaTeamWebhook.findMany.mockResolvedValue(webhooks);

    mockFetch.mockImplementation(() => {
      fetchCallCount += 1;
      const current = fetchCallCount;
      if (current <= 5) {
        // First chunk: return a manually-controlled promise
        return new Promise<{ ok: boolean }>((resolve) => {
          firstChunkResolvers.push(() => resolve({ ok: true }));
        });
      }
      // Second chunk: resolve immediately
      return Promise.resolve({ ok: true });
    });

    dispatchWebhook(EVENT);
    // Allow the async IIFE and findMany to resolve, then fetch calls to be initiated
    await vi.advanceTimersByTimeAsync(0);
    // Flush microtasks: findMany resolved → dispatchToWebhooks starts → first chunk fetches called
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // At this point only the first chunk (5) should have been called
    expect(fetchCallCount).toBe(5);
    expect(firstChunkResolvers).toHaveLength(5);

    // Release first chunk; second chunk should now start
    firstChunkResolvers.forEach((r) => r());
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Now all 10 should be done
    expect(fetchCallCount).toBe(10);
  });

  it("individual webhook failure does not affect others (Promise.allSettled behavior)", async () => {
    const makeWebhook = (id: string) => ({ ...WEBHOOK, id, url: `https://example.com/hook-${id}` });
    const webhooks = ["wh-ok1", "wh-fail", "wh-ok2"].map(makeWebhook);
    mockPrismaTeamWebhook.findMany.mockResolvedValue(webhooks);

    mockFetch
      .mockResolvedValueOnce({ ok: true })       // wh-ok1 succeeds
      .mockRejectedValueOnce(new Error("Network error")) // wh-fail throws
      .mockResolvedValueOnce({ ok: true });       // wh-ok2 succeeds

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    // All 3 fetches attempted
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Both successful webhooks updated with failCount: 0
    const successCalls = mockPrismaTeamWebhook.update.mock.calls.filter(
      (call: Array<{ where?: { id: string }; data?: { failCount: number } }>) =>
        call[0]?.data?.failCount === 0,
    );
    const successIds = successCalls.map(
      (call: Array<{ where?: { id: string } }>) => call[0]?.where?.id,
    );
    expect(successIds).toContain("wh-ok1");
    expect(successIds).toContain("wh-ok2");
  });
});

describe("SSRF defense (resolveAndValidateIps)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore default public IP for subsequent test suites
    mockResolve4.mockImplementation(async () => ["93.184.216.34"]);
    mockResolve6.mockImplementation(async () => []);
  });

  it("skips delivery when DNS resolves to private IP", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.1"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery when DNS resolves to cloud metadata IP", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery when DNS resolution fails (empty results)", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery for loopback IP", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery for TEST-NET-1 IP (RFC 5737)", async () => {
    mockResolve4.mockResolvedValue(["192.0.2.1"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery for TEST-NET-2 IP (RFC 5737)", async () => {
    mockResolve4.mockResolvedValue(["198.51.100.1"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips delivery for TEST-NET-3 IP (RFC 5737)", async () => {
    mockResolve4.mockResolvedValue(["203.0.113.1"]);
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails delivery when server returns redirect (redirect: error)", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([WEBHOOK]);
    mockFetch.mockRejectedValue(new TypeError("redirect mode is set to error"));

    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);

    // All retry attempts should fail
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockPrismaTeamWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failCount: 1 }),
      }),
    );
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
        justification: "Emergency access needed",
        requestedScope: "credentials:list",
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
    expect(sentPayload.data).not.toHaveProperty("justification");
    expect(sentPayload.data).not.toHaveProperty("requestedScope");
    // crypto keys must also be absent
    expect(sentPayload.data).not.toHaveProperty("secret");
    expect(sentPayload.data).not.toHaveProperty("token");
    // non-PII key must be present
    expect(sentPayload.data).toHaveProperty("webhookId", "twh-1");
  });
});
