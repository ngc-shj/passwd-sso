import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockUpdateMany, mockAuditCreate, mockAuditCreateMany, mockPrismaUser, mockWithUserTenantRls, mockWithBypassRls, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockAuditCreateMany: vi.fn(),
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
      createMany: mockAuditCreateMany,
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
    mockFindMany.mockResolvedValue([{ id: "00000000-0000-4000-a000-000000000001" }, { id: "00000000-0000-4000-a000-000000000002" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });
    mockAuditCreate.mockResolvedValue({});
    mockAuditCreateMany.mockResolvedValue({ count: 0 });
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
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: [id1, id2] },
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
          id: { in: [id1, id2] },
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
          id: { in: [id1, id2] },
          deletedAt: null,
          isArchived: false,
        }),
        data: expect.objectContaining({
          isArchived: true,
        }),
      })
    );
  });

  it("archives entries with UUID v4 IDs", async () => {
    const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
    const uuid2 = "550e8400-e29b-41d4-a716-446655440001";
    mockFindMany.mockResolvedValue([{ id: uuid1 }, { id: uuid2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: [uuid1, uuid2] },
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("archive");
    expect(json.processedCount).toBe(2);
    expect(json.archivedCount).toBe(2);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [uuid1, uuid2] },
        }),
      })
    );
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [uuid1, uuid2] },
        }),
      })
    );
  });

  it("unarchives entries when operation is 'unarchive'", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: [id1, id2], operation: "unarchive" },
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
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, { body: { ids: [id1, id2] } }));

    // 1 parent log via logAudit (create), per-entry logs via logAuditBatch (createMany)
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
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
            entryIds: [id1, id2],
          }),
        }),
      })
    );

    // Per-entry logs batched into a single createMany call
    expect(mockAuditCreateMany).toHaveBeenCalledTimes(1);
    expect(mockAuditCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            action: "ENTRY_UPDATE",
            targetId: id1,
            metadata: expect.objectContaining({
              source: "bulk-archive",
              parentAction: "ENTRY_BULK_ARCHIVE",
            }),
          }),
          expect.objectContaining({
            action: "ENTRY_UPDATE",
            targetId: id2,
            metadata: expect.objectContaining({
              source: "bulk-archive",
              parentAction: "ENTRY_BULK_ARCHIVE",
            }),
          }),
        ]),
      })
    );
  });

  it("logs ENTRY_BULK_UNARCHIVE for unarchive operation", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    mockFindMany.mockResolvedValue([{ id: id1 }]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await POST(createRequest("POST", URL, {
      body: { ids: [id1], operation: "unarchive" },
    }));

    // 1 parent log via logAudit (create), per-entry logs via logAuditBatch (createMany)
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
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

    expect(mockAuditCreateMany).toHaveBeenCalledTimes(1);
    expect(mockAuditCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            action: "ENTRY_UPDATE",
            targetId: id1,
            metadata: expect.objectContaining({
              source: "bulk-archive",
              parentAction: "ENTRY_BULK_UNARCHIVE",
            }),
          }),
        ]),
      })
    );
  });

  it("uses transaction findMany entry IDs for per-entry audit logs", async () => {
    // findMany inside transaction returns 3 entries, updateMany reports count: 2
    // entryIds for audit come from the findMany result (not updateMany count)
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    const id3 = "00000000-0000-4000-a000-000000000003";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }, { id: id3 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, {
      body: { ids: [id1, id2, id3] },
    }));

    // 1 parent via logAudit (create), 3 per-entry batched via logAuditBatch (createMany)
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_ARCHIVE",
          metadata: expect.objectContaining({
            entryIds: [id1, id2, id3],
          }),
        }),
      })
    );

    // All 3 per-entry logs in a single createMany
    expect(mockAuditCreateMany).toHaveBeenCalledTimes(1);
    expect(mockAuditCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ action: "ENTRY_UPDATE", targetId: id1 }),
          expect.objectContaining({ action: "ENTRY_UPDATE", targetId: id2 }),
          expect.objectContaining({ action: "ENTRY_UPDATE", targetId: id3 }),
        ]),
      })
    );
  });

  it("logAuditBatch receives per-entry data matching individual logAudit contract", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    const id3 = "00000000-0000-4000-a000-000000000003";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }, { id: id3 }]);
    mockUpdateMany.mockResolvedValue({ count: 3 });

    await POST(
      createRequest("POST", URL, {
        headers: { "user-agent": "TestAgent/1.0", "x-forwarded-for": "10.0.0.1" },
        body: { ids: [id1, id2, id3] },
      })
    );

    await vi.waitFor(() => expect(mockAuditCreateMany).toHaveBeenCalled());

    const batchData: Record<string, unknown>[] = mockAuditCreateMany.mock.calls[0][0].data;

    // Exactly 3 per-entry records — one per processed entry
    expect(batchData).toHaveLength(3);

    // Every record must carry the fields that individual logAudit calls would produce
    for (const entry of batchData) {
      expect(entry).toEqual(
        expect.objectContaining({
          scope: "PERSONAL",
          action: "ENTRY_UPDATE",
          userId: "user-1",
          tenantId: "tenant-1", // resolved, never null
          teamId: null,
          targetType: "PasswordEntry",
          metadata: expect.objectContaining({
            source: "bulk-archive",
            parentAction: "ENTRY_BULK_ARCHIVE",
          }),
        })
      );
    }

    // targetId is unique per entry — not all the same
    const ids = batchData.map((e) => e.targetId);
    expect(ids).toEqual(expect.arrayContaining([id1, id2, id3]));
    expect(new Set(ids).size).toBe(3);
  });
});
