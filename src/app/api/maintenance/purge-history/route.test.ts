import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaHistory, mockRateLimiter, mockLogAudit, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaHistory: {
    deleteMany: vi.fn(),
  },
  mockRateLimiter: {
    check: vi.fn(),
    clear: vi.fn(),
  },
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordEntryHistory: mockPrismaHistory },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "./route";

describe("POST /api/maintenance/purge-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue(false);
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("purges old history entries and returns count", async () => {
    mockPrismaHistory.deleteMany.mockResolvedValue({ count: 5 });
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.purged).toBe(5);
  });

  it("logs audit with purgedCount when entries deleted", async () => {
    mockPrismaHistory.deleteMany.mockResolvedValue({ count: 3 });
    await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "HISTORY_PURGE",
        userId: "user-1",
        metadata: expect.objectContaining({
          purgedCount: 3,
        }),
      }),
    );
  });

  it("logs audit with purgedCount=0 when no entries to delete", async () => {
    mockPrismaHistory.deleteMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.purged).toBe(0);
    // Audit log is always emitted, even when nothing was purged
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "HISTORY_PURGE",
        metadata: expect.objectContaining({
          purgedCount: 0,
        }),
      }),
    );
  });

  it("only deletes entries older than 90 days", async () => {
    mockPrismaHistory.deleteMany.mockResolvedValue({ count: 0 });
    await POST(
      createRequest("POST", "http://localhost:3000/api/maintenance/purge-history"),
    );
    expect(mockPrismaHistory.deleteMany).toHaveBeenCalledWith({
      where: {
        entry: { userId: "user-1" },
        changedAt: { lt: expect.any(Date) },
      },
    });
    // Verify the date is approximately 90 days ago
    const calledDate = mockPrismaHistory.deleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const expectedDate = new Date(Date.now() - ninetyDaysMs);
    expect(Math.abs(calledDate.getTime() - expectedDate.getTime())).toBeLessThan(1000);
  });
});
