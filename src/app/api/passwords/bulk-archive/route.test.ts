import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockUpdateMany, mockAuditCreate, mockPrismaUser, mockWithUserTenantRls, mockWithBypassRls, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockTransaction: vi.fn(),
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
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";

const URL = "http://localhost:3000/api/passwords/bulk-archive";

describe("POST /api/passwords/bulk-archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });
    mockAuditCreate.mockResolvedValue({});
    // Default: $transaction invokes callback with a tx object that delegates to top-level mocks
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        passwordEntry: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
        },
      })
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: { ids: ["p1"] } }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 400 INVALID_JSON for invalid JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 VALIDATION_ERROR when ids is empty array", async () => {
    const res = await POST(createRequest("POST", URL, { body: { ids: [] } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when ids exceed 100 limit", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await POST(createRequest("POST", URL, { body: { ids } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("archives entries when operation is omitted (defaults to archive)", async () => {
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: ["p1", "p2"] },
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("archive");
    expect(json.processedCount).toBe(2);
    expect(json.archivedCount).toBe(2);
    expect(json.unarchivedCount).toBe(0);

    // findMany: lookup entries where isArchived is false (single call inside transaction)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: null,
          isArchived: false,
        }),
      })
    );

    // updateMany: set isArchived to true
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
  });

  it("unarchives entries when operation is 'unarchive'", async () => {
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: ["p1", "p2"], operation: "unarchive" },
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("unarchive");
    expect(json.processedCount).toBe(2);
    expect(json.archivedCount).toBe(0);
    expect(json.unarchivedCount).toBe(2);

    // findMany: lookup entries where isArchived is true (single call inside transaction)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isArchived: true,
        }),
      })
    );

    // updateMany: set isArchived to false
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
  });

  it("logs ENTRY_BULK_ARCHIVE for archive operation", async () => {
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, { body: { ids: ["p1", "p2"] } }));

    // 1 parent log + 2 per-entry logs = 3 calls
    expect(mockAuditCreate).toHaveBeenCalledTimes(3);

    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_ARCHIVE",
          targetId: "bulk",
          metadata: expect.objectContaining({
            bulk: true,
            operation: "archive",
            requestedCount: 2,
            processedCount: 2,
            archivedCount: 2,
            unarchivedCount: 0,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );

    // Per-entry logs: ENTRY_UPDATE with parentAction ENTRY_BULK_ARCHIVE
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

  it("logs ENTRY_BULK_UNARCHIVE for unarchive operation", async () => {
    mockFindMany.mockResolvedValue([{ id: "p1" }]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await POST(createRequest("POST", URL, {
      body: { ids: ["p1"], operation: "unarchive" },
    }));

    // 1 parent log + 1 per-entry log = 2 calls
    expect(mockAuditCreate).toHaveBeenCalledTimes(2);

    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_UNARCHIVE",
          metadata: expect.objectContaining({
            operation: "unarchive",
            archivedCount: 0,
            unarchivedCount: 1,
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
            parentAction: "ENTRY_BULK_UNARCHIVE",
          }),
        }),
      })
    );
  });

  it("uses transaction findMany entry IDs for per-entry audit logs", async () => {
    // findMany inside transaction returns 3 entries, updateMany reports count: 2
    // entryIds for audit come from the findMany result (not updateMany count)
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, {
      body: { ids: ["p1", "p2", "p3"] },
    }));

    // 1 parent + 3 per-entry (all entries returned by findMany) = 4
    expect(mockAuditCreate).toHaveBeenCalledTimes(4);

    // Parent log has entryIds from findMany
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_ARCHIVE",
          metadata: expect.objectContaining({
            entryIds: ["p1", "p2", "p3"],
          }),
        }),
      })
    );

    // Per-entry logs for all findMany entries
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_UPDATE",
          targetId: "p1",
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_UPDATE",
          targetId: "p2",
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_UPDATE",
          targetId: "p3",
        }),
      })
    );
  });
});
