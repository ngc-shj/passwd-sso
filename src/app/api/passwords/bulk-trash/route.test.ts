import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockUpdateMany, mockAuditCreate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockAuditCreate: vi.fn(),
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
  },
}));

import { POST } from "./route";

describe("POST /api/passwords/bulk-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
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
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_DELETE",
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
          action: "ENTRY_DELETE",
          targetId: "p1",
          metadata: expect.objectContaining({ source: "bulk-trash" }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_DELETE",
          targetId: "p2",
          metadata: expect.objectContaining({ source: "bulk-trash" }),
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
          action: "ENTRY_BULK_DELETE",
          metadata: expect.objectContaining({ entryIds: [] }),
        }),
      })
    );
  });

  it("propagates db errors (framework handles 500)", async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      POST(
        createRequest("POST", "http://localhost:3000/api/passwords/bulk-trash", {
          body: { ids: ["p1"] },
        })
      )
    ).rejects.toThrow("db down");
  });
});
