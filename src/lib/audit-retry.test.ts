import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, mockWithBypassRls, mockDeadLetterWarn } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown, _purpose: unknown) => fn(),
  ),
  mockDeadLetterWarn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { create: (...args: unknown[]) => mockCreate(...args) } },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit-logger", () => ({
  deadLetterLogger: { warn: (...args: unknown[]) => mockDeadLetterWarn(...args) },
  auditLogger: { info: vi.fn(), enabled: false },
  METADATA_BLOCKLIST: new Set(),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
}));

import {
  enqueue,
  drainBuffer,
  bufferSize,
  clearBuffer,
  type BufferedAuditEntry,
} from "@/lib/audit-retry";

function makeEntry(overrides: Partial<BufferedAuditEntry> = {}): BufferedAuditEntry {
  return {
    scope: "PERSONAL" as never,
    action: "PASSWORD_CREATED" as never,
    userId: "user-1",
    actorType: "HUMAN" as never,
    serviceAccountId: null,
    tenantId: "tenant-1",
    teamId: null,
    targetType: null,
    targetId: null,
    metadata: undefined,
    ip: null,
    userAgent: null,
    retryCount: 0,
    ...overrides,
  };
}

describe("audit-retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBuffer();
  });

  describe("enqueue", () => {
    it("adds entry to buffer", () => {
      const sizeBefore = bufferSize();
      enqueue(makeEntry());
      expect(bufferSize()).toBe(sizeBefore + 1);
    });

    it("drops oldest to dead-letter when buffer is full", () => {
      // Fill buffer to max
      for (let i = 0; i < 100; i++) {
        enqueue(makeEntry({ userId: `user-${i}` }));
      }
      const sizeAtMax = bufferSize();

      // Enqueue one more — should drop oldest
      enqueue(makeEntry({ userId: "user-overflow" }));
      expect(bufferSize()).toBe(sizeAtMax); // size unchanged (one dropped, one added)
      expect(mockDeadLetterWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_overflow" }),
        "audit.dead_letter",
      );
    });
  });

  describe("drainBuffer", () => {
    it("writes buffered entries to DB", async () => {
      mockCreate.mockResolvedValue({});
      enqueue(makeEntry());
      const sizeBefore = bufferSize();

      await drainBuffer();

      expect(mockCreate).toHaveBeenCalledTimes(sizeBefore);
      expect(bufferSize()).toBeLessThan(sizeBefore);
    });

    it("re-enqueues on transient failure", async () => {
      mockCreate.mockRejectedValueOnce(new Error("connection lost"));
      enqueue(makeEntry());

      await drainBuffer();

      // Entry should be re-enqueued with incremented retryCount
      expect(bufferSize()).toBeGreaterThan(0);
    });

    it("sends to dead-letter after max retries", async () => {
      mockCreate.mockRejectedValue(new Error("persistent failure"));
      enqueue(makeEntry({ retryCount: 2 })); // one more failure = 3 total

      await drainBuffer();

      expect(mockDeadLetterWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_retries_exceeded" }),
        "audit.dead_letter",
      );
    });

    it("does nothing when buffer is empty", async () => {
      // Drain any existing entries first
      while (bufferSize() > 0) await drainBuffer();
      mockCreate.mockClear();

      await drainBuffer();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("drains at most 10 entries per call", async () => {
      mockCreate.mockResolvedValue({});
      for (let i = 0; i < 15; i++) {
        enqueue(makeEntry({ userId: `user-${i}` }));
      }

      await drainBuffer();

      expect(mockCreate).toHaveBeenCalledTimes(10);
      expect(bufferSize()).toBeGreaterThanOrEqual(5);
    });
  });
});
