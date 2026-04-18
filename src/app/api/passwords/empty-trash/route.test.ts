import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockDeleteMany, mockTransaction, mockLogAudit, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: vi.fn(async (entries: unknown[]) => {
    for (const e of entries) await mockLogAudit(e);
  }),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "./route";

describe("POST /api/passwords/empty-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        passwordEntry: {
          findMany: mockFindMany,
          deleteMany: mockDeleteMany,
        },
      })
    );
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/empty-trash")
    );
    expect(res.status).toBe(401);
  });

  it("empties trash and writes summary + per-entry logs", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/empty-trash")
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: { not: null },
        }),
      })
    );

    // Single withUserTenantRls + $transaction call
    expect(mockWithUserTenantRls).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // Summary log + 2 per-entry logs = 3 calls
    expect(mockLogAudit).toHaveBeenCalledTimes(3);
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "ENTRY_EMPTY_TRASH",
        userId: "user-1",
        metadata: expect.objectContaining({
          operation: "empty-trash",
          deletedCount: 2,
          entryIds: ["p1", "p2"],
        }),
      })
    );
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "ENTRY_PERMANENT_DELETE",
        userId: "user-1",
        targetId: "p1",
        metadata: expect.objectContaining({
          source: "empty-trash",
          parentAction: "ENTRY_EMPTY_TRASH",
        }),
      })
    );
  });

  it("returns deletedCount=0 when trash is empty", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/empty-trash")
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(0);
    // Only summary log, no per-entry logs
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_EMPTY_TRASH",
        metadata: expect.objectContaining({
          deletedCount: 0,
          entryIds: [],
        }),
      })
    );
  });

  it("propagates db errors (framework handles 500)", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("db down"));

    await expect(
      POST(createRequest("POST", "http://localhost:3000/api/passwords/empty-trash"))
    ).rejects.toThrow("db down");
  });
});
