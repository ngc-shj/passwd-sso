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
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";

const URL = "http://localhost:3000/api/passwords/bulk-trash";

describe("POST /api/passwords/bulk-trash", () => {
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
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`);
    const res = await POST(createRequest("POST", URL, { body: { ids } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("deduplicates IDs via Set before processing", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: [id1, id2, id1, id2, id1] },
    }));
    expect(res.status).toBe(200);

    // findMany inside transaction should receive deduplicated ids
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [id1, id2] },
        }),
      })
    );
  });

  it("soft-deletes entries with UUID v4 IDs", async () => {
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
    expect(json.movedCount).toBe(2);
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

  it("soft-deletes entries: findMany → updateMany → audit, returns movedCount", async () => {
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
    expect(json.movedCount).toBe(2);

    // findMany: initial lookup inside transaction
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [id1, id2] },
          deletedAt: null,
        }),
      })
    );

    // updateMany: soft-delete
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [id1, id2] },
          deletedAt: null,
        }),
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      })
    );
  });

  it("logs parent ENTRY_BULK_TRASH and per-entry ENTRY_TRASH audit logs", async () => {
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
          action: "ENTRY_BULK_TRASH",
          targetId: null,
          metadata: expect.objectContaining({
            bulk: true,
            requestedCount: 2,
            movedCount: 2,
            entryIds: [id1, id2],
          }),
        }),
      })
    );

    // Per-entry logs batched into a single createMany
    expect(mockAuditCreateMany).toHaveBeenCalledTimes(1);
    expect(mockAuditCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            action: "ENTRY_TRASH",
            targetId: id1,
            metadata: expect.objectContaining({
              source: "bulk-trash",
              parentAction: "ENTRY_BULK_TRASH",
            }),
          }),
          expect.objectContaining({
            action: "ENTRY_TRASH",
            targetId: id2,
            metadata: expect.objectContaining({
              source: "bulk-trash",
              parentAction: "ENTRY_BULK_TRASH",
            }),
          }),
        ]),
      })
    );
  });
});
