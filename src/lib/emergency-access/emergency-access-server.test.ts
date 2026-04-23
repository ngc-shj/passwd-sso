import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrismaGrant } = vi.hoisted(() => ({
  mockPrismaGrant: {
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant },
}));

import { markGrantsStaleForOwner } from "./emergency-access-server";
import { EA_STATUS } from "@/lib/constants";

describe("markGrantsStaleForOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks IDLE and ACTIVATED grants as STALE", async () => {
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 2 });

    const count = await markGrantsStaleForOwner("owner-1", 2);

    expect(count).toBe(2);
    expect(mockPrismaGrant.updateMany).toHaveBeenCalledWith({
      where: {
        ownerId: "owner-1",
        status: { in: [EA_STATUS.IDLE, EA_STATUS.ACTIVATED] },
        OR: [
          { keyVersion: { lt: 2 } },
          { keyVersion: null },
        ],
      },
      data: { status: EA_STATUS.STALE },
    });
  });

  it("returns 0 when no grants match", async () => {
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 0 });

    const count = await markGrantsStaleForOwner("owner-no-grants", 1);

    expect(count).toBe(0);
  });

  it("only targets grants with keyVersion < newKeyVersion or null", async () => {
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 1 });

    await markGrantsStaleForOwner("owner-1", 3);

    const call = mockPrismaGrant.updateMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { keyVersion: { lt: 3 } },
      { keyVersion: null },
    ]);
  });
});