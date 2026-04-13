import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockUpdateMany, mockAuditCreate, mockAuditCreateMany, mockLogAudit, mockPrismaUser, mockWithUserTenantRls, mockWithBypassRls, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockAuditCreateMany: vi.fn(),
  mockLogAudit: vi.fn(),
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
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    logAuditAsync: mockLogAudit,
  };
});

import { POST } from "./route";

const URL = "http://localhost:3000/api/passwords/bulk-restore";

describe("POST /api/passwords/bulk-restore", () => {
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

  it("restores entries with UUID v4 IDs", async () => {
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
    expect(json.restoredCount).toBe(2);
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

  it("restores entries: findMany → updateMany → audit, returns restoredCount", async () => {
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
    expect(json.restoredCount).toBe(2);

    // findMany: initial lookup for trashed entries (deletedAt not null) inside transaction
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [id1, id2] },
          deletedAt: { not: null },
        }),
      })
    );

    // updateMany: set deletedAt to null
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [id1, id2] },
          deletedAt: { not: null },
        }),
        data: expect.objectContaining({
          deletedAt: null,
        }),
      })
    );
  });

  it("logs parent ENTRY_BULK_RESTORE and per-entry ENTRY_RESTORE audit logs", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    mockFindMany.mockResolvedValue([{ id: id1 }, { id: id2 }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, { body: { ids: [id1, id2] } }));

    // 1 parent log + 2 per-entry logs, all via logAuditAsync
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_BULK_RESTORE",
        metadata: expect.objectContaining({
          bulk: true,
          operation: "restore",
          requestedCount: 2,
          restoredCount: 2,
          entryIds: [id1, id2],
        }),
      })
    );

    // Per-entry logs via individual logAuditAsync calls
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_RESTORE",
        targetId: id1,
        metadata: expect.objectContaining({
          source: "bulk-restore",
          parentAction: "ENTRY_BULK_RESTORE",
        }),
      })
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_RESTORE",
        targetId: id2,
        metadata: expect.objectContaining({
          source: "bulk-restore",
          parentAction: "ENTRY_BULK_RESTORE",
        }),
      })
    );
  });
});
