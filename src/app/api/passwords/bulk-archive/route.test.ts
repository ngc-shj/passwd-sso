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

describe("POST /api/passwords/bulk-archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["p1"] },
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: [] },
      })
    );
    expect(res.status).toBe(400);
  });

  it("archives matching entries and returns archived count", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["p1", "p2", "p1"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("archive");
    expect(json.processedCount).toBe(2);
    expect(json.archivedCount).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: null,
          isArchived: false,
        }),
        data: expect.objectContaining({
          isArchived: true,
        }),
      })
    );

    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_ARCHIVE",
          metadata: expect.objectContaining({
            bulk: true,
            operation: "archive",
            requestedCount: 2,
            archivedCount: 2,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_UPDATE",
          targetId: "p1",
          metadata: expect.objectContaining({
            source: "bulk-archive",
            parentAction: "ENTRY_BULK_ARCHIVE",
          }),
        }),
      })
    );
  });

  it("filters non-string and empty ids", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["p1", "", 123, null, "p2"] },
      })
    );
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["p1", "p2"] },
        }),
      })
    );
  });

  it("returns 400 when all ids are invalid after filtering", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["", null, 123] },
      })
    );

    expect(res.status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("falls back to archive when operation is invalid", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["p1"], operation: "noop" },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.operation).toBe("archive");
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isArchived: false,
        }),
        data: expect.objectContaining({
          isArchived: true,
        }),
      })
    );
  });

  it("creates summary log only when nothing matches", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["missing"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.operation).toBe("archive");
    expect(json.archivedCount).toBe(0);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_ARCHIVE",
          metadata: expect.objectContaining({
            bulk: true,
            operation: "archive",
            entryIds: [],
          }),
        }),
      })
    );
  });

  it("propagates db errors (framework handles 500)", async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(
      POST(
        createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
          body: { ids: ["p1"] },
        })
      )
    ).rejects.toThrow("db down");
  });

  it("unarchives matching entries and writes unarchive audit action", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-archive", {
        body: { ids: ["p1", "p2"], operation: "unarchive" },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("unarchive");
    expect(json.processedCount).toBe(2);
    expect(json.unarchivedCount).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isArchived: true,
        }),
        data: expect.objectContaining({
          isArchived: false,
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_UNARCHIVE",
          metadata: expect.objectContaining({
            operation: "unarchive",
            unarchivedCount: 2,
            archivedCount: 0,
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_UPDATE",
          targetId: "p1",
          metadata: expect.objectContaining({
            parentAction: "ENTRY_BULK_UNARCHIVE",
          }),
        }),
      })
    );
  });
});
