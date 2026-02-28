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

const URL = "http://localhost:3000/api/passwords/bulk-trash";

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

  it("deduplicates IDs via Set before processing", async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: ["p1", "p2", "p1", "p2", "p1"] },
    }));
    expect(res.status).toBe(200);

    // First findMany should receive deduplicated ids
    expect(mockFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["p1", "p2"] },
        }),
      })
    );
  });

  it("soft-deletes entries: findMany → updateMany → re-fetch → audit, returns movedCount", async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const res = await POST(createRequest("POST", URL, {
      body: { ids: ["p1", "p2"] },
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.movedCount).toBe(2);

    // findMany: initial lookup
    expect(mockFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: null,
        }),
      })
    );

    // updateMany: soft-delete
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

    // findMany: re-fetch with deletedAt
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
  });

  it("logs parent ENTRY_BULK_TRASH and per-entry ENTRY_TRASH audit logs", async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await POST(createRequest("POST", URL, { body: { ids: ["p1", "p2"] } }));

    // 1 parent log + 2 per-entry logs = 3 calls
    expect(mockAuditCreate).toHaveBeenCalledTimes(3);

    // Parent log: ENTRY_BULK_TRASH
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_TRASH",
          targetId: "bulk",
          metadata: expect.objectContaining({
            bulk: true,
            requestedCount: 2,
            movedCount: 2,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );

    // Per-entry log: ENTRY_TRASH for p1
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

    // Per-entry log: ENTRY_TRASH for p2
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
});
