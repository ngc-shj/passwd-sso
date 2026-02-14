import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockDeleteMany, mockAuditCreate } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockFindMany: vi.fn(),
    mockDeleteMany: vi.fn(),
    mockAuditCreate: vi.fn(),
  })
);

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
  },
}));

import { POST } from "./route";

describe("POST /api/passwords/empty-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
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
});
