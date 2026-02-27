import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockDeleteMany, mockAuditCreate, mockPrismaUser, mockWithUserTenantRls, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
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
      deleteMany: mockDeleteMany,
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

describe("POST /api/passwords/empty-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
    mockAuditCreate.mockResolvedValue({});
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

    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_EMPTY_TRASH",
          metadata: expect.objectContaining({
            operation: "empty-trash",
            deletedCount: 2,
            entryIds: ["p1", "p2"],
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_PERMANENT_DELETE",
          targetId: "p1",
          metadata: expect.objectContaining({
            source: "empty-trash",
            parentAction: "ENTRY_EMPTY_TRASH",
          }),
        }),
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledTimes(3);
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
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_EMPTY_TRASH",
          metadata: expect.objectContaining({
            deletedCount: 0,
            entryIds: [],
          }),
        }),
      })
    );
  });

  it("propagates db errors (framework handles 500)", async () => {
    mockDeleteMany.mockRejectedValueOnce(new Error("db down"));

    await expect(
      POST(createRequest("POST", "http://localhost:3000/api/passwords/empty-trash"))
    ).rejects.toThrow("db down");
  });
});
