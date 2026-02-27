import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockUpdateMany, mockAuditCreate, mockPrismaUser, mockWithUserTenantRls, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
    },
    auditLog: {
      create: mockAuditCreate,
    },
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";

describe("POST /api/passwords/bulk-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
      body: { ids: ["p1"] },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
      body: { ids: [] },
    }));
    expect(res.status).toBe(400);
  });

  it("soft-deletes matching entries and returns moved count", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
      body: { ids: ["p1", "p2", "p1"] },
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.movedCount).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: null,
        }),
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      })
    );
    expect(mockFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: expect.any(Date),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_TRASH",
          metadata: expect.objectContaining({
            bulk: true,
            requestedCount: 2,
            movedCount: 2,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_TRASH",
          targetId: "p1",
          metadata: expect.objectContaining({
            source: "bulk-trash",
            parentAction: "ENTRY_BULK_TRASH",
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_TRASH",
          targetId: "p2",
          metadata: expect.objectContaining({
            source: "bulk-trash",
            parentAction: "ENTRY_BULK_TRASH",
          }),
        }),
      })
    );
  });

  it("filters non-string and empty ids", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
      body: { ids: ["p1", "", 123, null, "p2"] },
    }));
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["p1", "p2"] },
        }),
      })
    );
  });

  it("creates summary log only when nothing matches", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindMany.mockResolvedValueOnce([]);

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
        body: { ids: ["missing"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.movedCount).toBe(0);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_TRASH",
          metadata: expect.objectContaining({ entryIds: [] }),
        }),
      })
    );
  });

  it("propagates db errors (framework handles 500)", async () => {
    mockFindMany.mockResolvedValueOnce([{ id: "p1" }]);
    mockUpdateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      POST(
        createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
          body: { ids: ["p1"] },
        })
      )
    ).rejects.toThrow("db down");
  });

  it("logs per-entry delete only for actually moved entries", async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
      .mockResolvedValueOnce([{ id: "p1" }]);
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
        body: { ids: ["p1", "p2"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.movedCount).toBe(1);
    expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_TRASH",
          metadata: expect.objectContaining({ entryIds: ["p1"], movedCount: 1 }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_TRASH",
          targetId: "p1",
          metadata: expect.objectContaining({
            parentAction: "ENTRY_BULK_TRASH",
          }),
        }),
      })
    );
  });
});
