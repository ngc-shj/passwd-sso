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

describe("POST /api/passwords/bulk-restore", () => {
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
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-restore", {
        body: { ids: ["p1"] },
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-restore", {
        body: { ids: [] },
      })
    );
    expect(res.status).toBe(400);
  });

  it("restores matching entries and returns restored count", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-restore", {
        body: { ids: ["p1", "p2", "p1"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.restoredCount).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["p1", "p2"] },
          deletedAt: { not: null },
        }),
        data: expect.objectContaining({
          deletedAt: null,
        }),
      })
    );

    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_RESTORE",
          metadata: expect.objectContaining({
            bulk: true,
            operation: "restore",
            requestedCount: 2,
            restoredCount: 2,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_RESTORE",
          targetId: "p1",
          metadata: expect.objectContaining({
            source: "bulk-restore",
            parentAction: "ENTRY_BULK_RESTORE",
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_RESTORE",
          targetId: "p2",
          metadata: expect.objectContaining({
            source: "bulk-restore",
            parentAction: "ENTRY_BULK_RESTORE",
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledTimes(3);
  });

  it("returns 400 when all ids are invalid after filtering", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-restore", {
        body: { ids: ["", null, 123] },
      })
    );

    expect(res.status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("creates summary log only when nothing matches", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/passwords/bulk-restore", {
        body: { ids: ["missing"] },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.restoredCount).toBe(0);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_BULK_RESTORE",
          metadata: expect.objectContaining({
            bulk: true,
            operation: "restore",
            entryIds: [],
          }),
        }),
      })
    );
  });
});
