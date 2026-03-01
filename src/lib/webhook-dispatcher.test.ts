import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrismaTeamWebhook,
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
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));
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

import { dispatchWebhook } from "./webhook-dispatcher";
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

  it("never throws even on errors", async () => {
    mockPrismaTeamWebhook.findMany.mockRejectedValue(new Error("DB error"));

    // Should not throw
    dispatchWebhook(EVENT);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
